"""FP32 PyTorch inference optimizations; common tensor code for CUDA and ROCm.

Cross attention is adapted from manga-image-translator@95227a2, GPL-3.0.
Weights, beam policy, XPOS, masks and color calculations remain unchanged.
LaMa uses PyTorch's graph executor, with speculative optimization disabled to
avoid per-shape compilation pauses. No serialized graphs or new dependencies.
"""
import types

import torch
from torch.nn import functional as F
from manga_translator.ocr.model_48px import XposMultiheadAttention


class ProjectionCache:
    """At most one memory projection per cross-attention layer, per OCR batch.

    Entries are cleared on success and failure. Tensor identity/version checks
    invalidate entries when beam search compacts its batch; never reuse page
    data across calls. Oversized projections execute normally without caching.
    The existing engine device lock serializes model calls.
    """
    def __init__(self, network, max_bytes=64 * 1024**2):
        self.network, self.max_bytes = network, max_bytes
        self.entries, self.originals = {}, []
        self.active = False
        self.size = self.peak_bytes = self.hits = self.misses = 0
        for module in network.modules():
            if type(module) is not XposMultiheadAttention or not module.encoder_decoder_attention:
                continue
            original = module.forward
            def forward(current, query, key, value, key_padding_mask=None,
                        attn_mask=None, need_weights=False, is_causal=False,
                        k_offset=0, q_offset=0, original=original):
                if (not self.active or current.training or torch.is_grad_enabled()
                        or attn_mask is not None or need_weights or is_causal
                        or query.device.type not in ('cpu', 'cuda')):
                    return original(query, key, value, key_padding_mask, attn_mask,
                                    need_weights, is_causal, k_offset, q_offset)
                return self.forward(current, query, key, value, key_padding_mask, k_offset, q_offset)
            self.originals.append((module, original))
            module.forward = types.MethodType(forward, module)
        self.original_infer = network.infer_beam_batch_tensor
        def infer(*args, **kwargs):
            if self.active:
                raise RuntimeError('Concurrent OCR inference is unsupported')
            self.active = True
            try:
                rows = self.original_infer(*args, **kwargs)
                return [tuple(t.cpu() if isinstance(t, torch.Tensor) else t for t in row) for row in rows]
            finally:
                self.active = False
                self.entries.clear()
                self.size = 0
        network.infer_beam_batch_tensor = infer

    def forward(self, module, query, key, value, padding, k_offset, q_offset):
        batch, length, dim = query.shape
        source, heads, width = key.shape[1], module.num_heads, module.head_dim
        def split(tensor, size):
            return tensor.view(batch, size, heads, width).transpose(1, 2).reshape(batch * heads, size, width)
        q = module.q_proj(query)
        q *= module.scaling
        q = split(q, length)
        stamp = (key._version, value._version, k_offset)
        entry = self.entries.get(module)
        if entry is not None and entry[0] is key and entry[1] is value and entry[2] == stamp:
            k, v = entry[3:5]
            self.hits += 1
        else:
            self.misses += 1
            if entry is not None:
                self.size -= entry[5]
                del self.entries[module]
            k, v = split(module.k_proj(key), source), split(module.v_proj(value), source)
            if module.xpos is not None:
                k = module.xpos(k, offset=k_offset, downscale=True)
            # Include retained inputs conservatively, even if layers share them.
            cost = sum(t.numel() * t.element_size() for t in (key, value, k, v))
            if self.size + cost <= self.max_bytes:
                self.entries[module] = key, value, stamp, k, v, cost
                self.size += cost
                self.peak_bytes = max(self.peak_bytes, self.size)
        if module.xpos is not None:
            q = module.xpos(q, offset=q_offset, downscale=False)
        weights = torch.bmm(q, k.transpose(1, 2))
        if padding is not None:
            weights = weights.view(batch, heads, length, source).masked_fill(
                padding[:, None, None, :].to(torch.bool), float('-inf'))
            weights = weights.view(batch * heads, length, source)
        weights = F.softmax(weights, dim=-1, dtype=torch.float32).type_as(weights)
        output = torch.bmm(weights, v).transpose(0, 1).reshape(length, batch, dim).transpose(0, 1)
        return module.out_proj(output), None

    def describe(self):
        return {'layers': len(self.originals), 'bytes': self.size, 'max_bytes': self.max_bytes,
                'peak_bytes': self.peak_bytes, 'hits': self.hits, 'misses': self.misses}

    def close(self):
        self.network.infer_beam_batch_tensor = self.original_infer
        for module, original in self.originals:
            module.forward = original
        self.originals.clear()
        self.entries.clear()
        self.size = 0
        self.active = False


class NeuralAcceleration:
    """Install after model load, before warmup; fail startup on graph errors."""
    def __init__(self, models):
        self.projections = None
        self.generator = models['inpainter'].model.generator
        self.original_forward = self.generator.forward
        self.graph = None
        device = next(self.generator.parameters()).device
        self.device = device
        self.graph_calls = 0
        if device.type not in ('cpu', 'cuda') or self.generator.training or models['ocr'].model.training:
            raise ValueError('Portable inference requires eval models on CPU/CUDA/ROCm')
        try:
            # This pinned generator is LaMa-large without optional MPE inputs.
            if models['inpainter'].model.mpe is not None:
                raise ValueError('Portable LaMa graph does not support MPE')
            inputs = (torch.zeros(1, 3, 128, 128, device=device), torch.zeros(1, 1, 128, 128, device=device))
            with torch.no_grad():
                self.graph = torch.jit.freeze(torch.jit.trace(self.generator, inputs, check_trace=False), optimize_numerics=False)
                # Verify independent non-square dimensions and nonempty masks.
                for height, width in ((128, 128), (96, 160)):
                    image = torch.linspace(0, 1, 3 * height * width, device=device).reshape(1, 3, height, width)
                    mask = torch.zeros(1, 1, height, width, device=device)
                    mask[:, :, 16:48, 24:64] = 1
                    expected = self.original_forward(image, mask)
                    with torch.jit.optimized_execution(False):
                        actual = self.graph(image, mask)
                    torch.testing.assert_close(actual, expected, rtol=1e-4, atol=1e-5)
            self.generator.forward = self.forward
            self.projections = ProjectionCache(models['ocr'].model)
        except BaseException:
            self.close()
            raise

    def forward(self, image, mask, rel_pos=None, direct=None):
        if torch.is_grad_enabled() or self.generator.training or rel_pos is not None or direct is not None:
            return self.original_forward(image, mask, rel_pos, direct)
        if image.device != self.device or mask.device != self.device or image.dtype != torch.float32 or mask.dtype != torch.float32:
            raise ValueError('Portable LaMa graph requires FP32 tensors on its configured device')
        with torch.jit.optimized_execution(False):
            result = self.graph(image, mask)
        self.graph_calls += 1
        return result

    def describe(self):
        return {'implementation': 'torch-portable-v1', 'precision': 'fp32',
                'lama_executor': 'torchscript-frozen-no-speculation',
                'device': str(self.device), 'lama_graph_calls': self.graph_calls,
                'ocr_projection_cache': self.projections.describe() if self.projections else None}

    def close(self):
        self.generator.forward = self.original_forward
        if self.projections:
            self.projections.close()
            self.projections = None
        self.graph = None
