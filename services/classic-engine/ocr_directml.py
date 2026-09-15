"""Original 48px OCR decoder with equivalent out-of-place cache updates.

Derived from manga-image-translator@95227a2bb0fd306cd4f0c104d57284026f991b3a,
OCR.decoder_forward, under GPL-3.0 (licenses/manga-image-translator-GPL-3.0.txt).
The native DirectML
backend can corrupt the original strided cache writes. Keep all weights, beam
search, attention and prediction math unchanged; rebuild only the updated cache.
Enabled by the AMD v2 runtime and the isolated GPU OCR benchmark.
"""
import types

import torch


def decoder_forward(self, embd, cached_activations, memory, memory_mask, step):
    tgt = embd
    updated_cache = []
    for layer_index, layer in enumerate(self.decoders):
        prefix = cached_activations[:, layer_index, :step, :]
        combined = tgt if step == 0 else torch.cat((prefix, tgt), dim=1)
        tail = cached_activations[:, layer_index, step + 1:, :]
        updated_cache.append(torch.cat((combined, tail), dim=1)
                             if step + 1 < cached_activations.size(2) else combined)
        tgt = tgt + layer.self_attn(layer.norm1(tgt), layer.norm1(combined),
                                   layer.norm1(combined), q_offset=step)[0]
        tgt = tgt + layer.multihead_attn(layer.norm2(tgt), memory, memory,
                                        key_padding_mask=memory_mask, q_offset=step)[0]
        tgt = tgt + layer._ff_block(layer.norm3(tgt))
    final_index = len(self.decoders)
    last = tgt if step == 0 else torch.cat((cached_activations[:, final_index, :step, :], tgt), dim=1)
    tail = cached_activations[:, final_index, step + 1:, :]
    updated_cache.append(torch.cat((last, tail), dim=1)
                         if step + 1 < cached_activations.size(2) else last)
    return tgt.squeeze(1), torch.stack(updated_cache, dim=1)


def enable_gpu_ocr(model, device):
    """Apply after the existing hybrid runtime loads its private model instance."""
    network = model.model
    network.decoders.forward = types.MethodType(decoder_forward, network)
    # These container hooks are the hybrid runtime's transfer boundaries. The
    # Conv/Linear child hooks that record actual execution devices remain intact.
    network.backbone._forward_pre_hooks.clear()
    network.encoders._forward_pre_hooks.clear()
    network.encoders._forward_hooks.clear()
    network.to(device)
    model.device, model.use_gpu = str(device), True
    infer = network.infer_beam_batch_tensor

    def cpu_results(*args, **kwargs):
        return [tuple(value.cpu() if isinstance(value, torch.Tensor) else value for value in row)
                for row in infer(*args, **kwargs)]

    network.infer_beam_batch_tensor = cpu_results
