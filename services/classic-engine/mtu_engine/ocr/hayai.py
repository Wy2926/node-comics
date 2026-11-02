"""Local Hayai paragraph recognition using the pinned upstream inference engine."""
import json
from pathlib import Path
import sys
from threading import Lock

from PIL import Image

from classic_node.timing import stage, waiting_for
from mtu_engine.backend import device_context
from . import Reading
from .crops import paragraph_box
from .models import verify_hayai

MAX_PATCHES = 512
MAX_TOKENS = 512


def complete_texts(sequences, tokenizer):
    """A capped paragraph must not authorize erasing text it did not finish reading."""
    stops = {tokenizer.eos_token_id, tokenizer.pad_token_id}
    texts = []
    for sequence in sequences:
        end = next((i for i, token in enumerate(sequence[1:], 1) if token in stops), None)
        texts.append(tokenizer.decode(sequence[1:end], skip_special_tokens=True).strip()
                     if end is not None else '')
    return texts


class HayaiOCR:
    def __init__(self, model, gpu=0, *, backend='cuda', batch_size=4):
        import torch
        from transformers import AutoConfig, AutoImageProcessor, AutoModel, PreTrainedTokenizerFast

        root = Path(model).resolve()
        self.identity = verify_hayai(root) | {'max_num_patches': MAX_PATCHES, 'max_new_tokens': MAX_TOKENS}
        self.backend, self.gpu, self.batch_size = backend, gpu, batch_size
        self.device = 'mps' if backend == 'mps' else f'cuda:{gpu}'
        self._lock = Lock()
        with device_context(backend, gpu):
            config = AutoConfig.from_pretrained(root / 'model', trust_remote_code=True, local_files_only=True)
            vision = json.loads((root / 'processor/config.json').read_text())
            config.vision_config = vision.get('vision_config', vision)
            model, loading = AutoModel.from_pretrained(root / 'model', config=config,
                trust_remote_code=True, local_files_only=True, dtype=torch.float32, output_loading_info=True)
            if (loading['missing_keys'] or loading.get('mismatched_keys') or loading.get('error_msgs')
                    or set(loading['unexpected_keys']) != {'decoder.ids_norm.weight', 'decoder.ids_head.weight'}):
                raise ValueError('Hayai checkpoint does not match its pinned inference code')
            model = model.to(self.device).eval()
            self.processor = AutoImageProcessor.from_pretrained(root / 'processor', local_files_only=True)
            self.tokenizer = PreTrainedTokenizerFast.from_pretrained(root / 'model', local_files_only=True)
            # The pinned upstream engine exposes raw tokens and owns its fused
            # weights/KV cache. Avoid generate()'s silent FP32/reference fallback
            # and retain EOS information for truncation detection.
            self.engine = sys.modules[type(model).__module__]._FastEngine(model, torch.float16)

    async def recognize(self, image, blocks, config):
        height, width = image.shape[:2]
        boxes = [paragraph_box(block.xyxy, width, height) for block in blocks]
        indices = sorted((i for i, (l, t, r, b) in enumerate(boxes)
                          if r > l and b > t and len(blocks[i].lines)),
                         key=lambda i: (boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1]))
        results = [Reading([]) for _ in blocks]
        with stage('analyze_ocr'):
            for offset in range(0, len(indices), self.batch_size):
                owners = indices[offset:offset + self.batch_size]
                crops = [Image.fromarray(image[t:b, l:r]) for l, t, r, b in (boxes[i] for i in owners)]
                for i, text in zip(owners, self._recognize(crops), strict=True):
                    results[i] = Reading([text] + [''] * (len(blocks[i].lines) - 1),
                                         line_aligned=len(blocks[i].lines) == 1)
        return results

    def _recognize(self, images):
        import torch

        inputs = self.processor(images=images, max_num_patches=MAX_PATCHES, return_tensors='pt')
        with device_context(self.backend, self.gpu), waiting_for(self._lock, 'ocr_lock_wait'), torch.inference_mode():
            inputs = {key: value.to(self.device) for key, value in inputs.items()}
            tokens = self.engine.run(**inputs, bos=self.tokenizer.bos_token_id,
                eos=self.tokenizer.eos_token_id, pad=self.tokenizer.pad_token_id,
                max_new=MAX_TOKENS, use_graph=False)
            sequences = tokens.tolist()  # Upstream returns a synchronized CPU tensor.
        return complete_texts(sequences, self.tokenizer)

    async def warmup(self, image, config):
        self._recognize([Image.fromarray(image[:96, :192])])

    def close(self):
        with device_context(self.backend, self.gpu), self._lock:
            self.engine = self.processor = self.tokenizer = None
