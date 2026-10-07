"""Adapt MTU color prediction and keep the rendered outline readable."""
from copy import copy
from functools import partial
from threading import Lock
from types import SimpleNamespace

import cv2
import numpy as np

from classic_node.timing import waiting_for


def _luminance(color):
    # Match the integer RGB channels ultimately passed to Qt.
    rgb = [int(channel) / 255 for channel in color]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return sum(c * weight for c, weight in zip(linear, (0.2126, 0.7152, 0.0722)))


def ensure_stroke_contrast(region):
    """Keep the predicted fill; replace only low-contrast outlines (below 3:1)."""
    foreground, background = _luminance(region.fg_colors), _luminance(region.bg_colors)
    if (max(foreground, background) + 0.05) / (min(foreground, background) + 0.05) < 3:
        black_contrast = (foreground + 0.05) / 0.05
        white_contrast = 1.05 / (foreground + 0.05)
        region.bg_colors = np.full(3, 0 if black_contrast >= white_contrast else 255)
    # Prevent upstream's gray-color heuristic from overriding this decision or
    # dropping the outline. This also covers older checkpoints without a flag.
    region.adjust_bg_color = False


class _CpuColorModel:
    """Share one model lock and return color tensors without CUDA scalar reads."""
    def __init__(self, model):
        self.model = model
        self._lock = Lock()

    @property
    def dictionary(self):
        return self.model.dictionary

    def infer_beam_batch_tensor(self, *args, _text_indices=None, **kwargs):
        # Keep torch out of CPU-only render workers importing the contrast guard.
        import torch
        with waiting_for(self._lock, 'ocr_lock_wait'):
            if _text_indices is None:
                predictions = self.model.infer_beam_batch_tensor(*args, **kwargs)
            else:
                with torch.no_grad():
                    predictions = self._with_text(*args, text_indices=_text_indices, **kwargs)
            return [tuple(value.detach().cpu() if torch.is_tensor(value) else value for value in row)
                    for row in predictions]

    def infer_with_text(self, img, img_widths, *, text_indices, beams_k=5, max_seq_length=255):
        if len(text_indices) != img.shape[0] or len(img_widths) != img.shape[0]:
            raise ValueError('Color text/crop batch mismatch')
        if any(tokens is not None and not 0 < len(tokens) <= max_seq_length for tokens in text_indices):
            raise ValueError('Color text is outside the decoder input limit')
        return self.infer_beam_batch_tensor(img, img_widths, _text_indices=text_indices,
                                           beams_k=beams_k, max_seq_length=max_seq_length)

    def _with_text(self, img, img_widths, *, text_indices, **kwargs):
        # Split only after native padding, so mixed known/unknown lines keep the
        # same canvas. None means no reliable line-aligned text, not an empty word.
        predictions = [None] * len(text_indices)
        for known in (True, False):
            indices = [i for i, tokens in enumerate(text_indices) if (tokens is not None) == known]
            if not indices:
                continue
            pixels = img if len(indices) == len(text_indices) else img[indices]
            widths = [img_widths[i] for i in indices]
            if known:
                rows = self._forced_colors(pixels, widths, [text_indices[i] for i in indices])
            else:
                # Already holding the instance lock; never re-enter its wrapper.
                rows = self.model.infer_beam_batch_tensor(pixels, widths, **kwargs)
            for index, row in zip(indices, rows, strict=True):
                predictions[index] = row
        return predictions

    def _forced_colors(self, img, img_widths, tokens):
        """Native incremental decoder conditioned on OCR, without a text search."""
        import torch
        model = self.model
        memory = model.backbone(img).squeeze(2).transpose(1, 2)
        mask = torch.zeros(len(tokens), memory.size(1), dtype=torch.bool, device=img.device)
        for i, width in enumerate(img_widths):
            mask[i, (width + 3) // 4 + 2:] = True
        memory = model.encoders(memory, mask)
        length = max(map(len, tokens))
        # BOS=1 and PAD=0 are fixed by the pinned 48px dictionary. Feed existing
        # characters, never predictions. Ignore padded positions in the result.
        inputs = torch.tensor([[1, *row[:-1], *([0] * (length - len(row)))] for row in tokens],
                              dtype=torch.long, device=img.device)
        cache = memory.new_zeros((len(tokens), len(model.decoders) + 1, length, memory.size(2)))
        for step in range(length):
            _, cache = model.decoders(model.embd(inputs[:, step:step + 1]), cache, memory, mask, step)
        features = model.color_pred1(cache[:, -1])
        heads = [head(features) for head in (model.color_pred_fg, model.color_pred_bg,
                                            model.color_pred_fg_ind, model.color_pred_bg_ind)]
        # The native aggregator ignores confidence. None is not an OCR score.
        return [(row, None, *(head[i, :len(row)] for head in heads)) for i, row in enumerate(tokens)]


class Colors:
    def __init__(self, model):
        from manga_translator.ocr.model_paddleocr import ModelPaddleOCR
        # Construct only the adapter, never another Paddle session or 48px model.
        self.predictor = ModelPaddleOCR()
        self.predictor.color_model = _CpuColorModel(model.model)
        self.predictor.device = model.device
        self.predictor.use_gpu = model.use_gpu
        self._characters = {char: index for index, char in enumerate(model.model.dictionary) if len(char) == 1}
        if '<SP>' in model.model.dictionary:
            self._characters[' '] = model.model.dictionary.index('<SP>')

    def _encode(self, text):
        if not text or not text.strip() or len(text) > 255:
            return None
        try:
            return [self._characters[char] for char in text]
        except KeyError:
            return None  # Do not normalize, drop or replace unrepresentable text.

    @staticmethod
    def _line_texts(region):
        language = getattr(region, 'language', None)
        aligned = (language in ('en', 'ch', 'korean', 'japan') and len(region.texts) == len(region.lines)
                   and (language != 'japan' or len(region.lines) == 1))
        # Manga OCR writes a whole paragraph to its first line. It must never be
        # used as the conditioning text for just that first line's image.
        return region.texts if aligned else [None] * len(region.lines)

    def apply(self, image, regions):
        from manga_translator.utils import chunks
        # CPU-only render workers use the contrast guard, not the OCR runtime.
        from .ocr import OCR_BATCH_SIZE, valid_crop
        for region in regions:
            region.set_font_colors(np.zeros(3), np.zeros(3))
        lines = [(region, points, text) for region in regions
                 for points, text in zip(region.lines, self._line_texts(region), strict=True)]
        # Bound both crops and GPU batches, including on very long pages. Native
        # geometry, preprocessing and per-character color aggregation stay intact.
        for batch in chunks(lines, OCR_BATCH_SIZE):
            crops, owners, tokens = [], [], []
            for region, points, text in batch:
                crop = self.predictor._get_rotate_crop_image(image, points)
                if not valid_crop(crop):
                    # Match upstream's black/white fallback for unusable input.
                    region.update_font_colors(np.zeros(3), np.full(3, 255.))
                    continue
                crops.append(cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
                owners.append(region)
                tokens.append(self._encode(text))
            if crops:
                predictor = self.predictor
                if any(row is not None for row in tokens):
                    # This tiny, request-local adapter reuses upstream's input,
                    # aggregation and failure rules without shared mutable text.
                    predictor = copy(predictor)
                    model = self.predictor.color_model
                    predictor.color_model = SimpleNamespace(dictionary=model.dictionary,
                        infer_beam_batch_tensor=partial(model.infer_with_text, text_indices=tokens))
                colors = predictor._estimate_colors_batch(crops)
                for region, color in zip(owners, colors, strict=True):
                    region.update_font_colors(np.asarray(color[:3]), np.asarray(color[3:]))

    def close(self):
        self.predictor = None
