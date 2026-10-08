"""Adapt MTU color prediction and keep the rendered outline readable."""
from copy import copy
from functools import partial
from threading import Lock
from types import SimpleNamespace

import numpy as np

from classic_node.timing import record, stage, waiting_for
from .page_cache import bgr, crop as cached_crop


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


def _monochrome(crop):
    """No obvious chroma means default colors, regardless of ink/background gray."""
    if crop is None or crop.ndim != 3 or crop.shape[2] != 3 or not crop.size:
        return False
    from manga_translator.utils.bubble import check_color
    # Bound native float64 scratch arrays, not eligibility: even large gray
    # crops can bypass the model. Inspect original pixels without downsampling.
    for y in range(0, crop.shape[0], 512):
        for x in range(0, crop.shape[1], 512):
            tile = crop[y:y+512, x:x+512]
            record('color_gate_pixels', tile.shape[0] * tile.shape[1])
            if check_color(tile):
                return False
    return True


class _ParallelCrossAttention:
    """Reuse native attention with the incremental decoder's XPOS query scale."""
    def __init__(self, attention):
        self.attention = attention

    def __getattr__(self, name):
        return getattr(self.attention, name)

    def xpos(self, values, offset=0, downscale=False):
        import torch
        xpos = self.attention.xpos
        result = xpos(values, offset=offset, downscale=downscale)
        if not downscale:
            length = values.size(1)
            positions = torch.arange(1, length + 1, device=values.device)
            # Native XPOS centers a prefix of size n at -ceil(n/2). Self
            # attention cancels that center between Q/K; cross attention does
            # not, since its image keys have a fixed length. Restore each
            # query's original prefix scale after the native full-row XPOS.
            centers = (length + 1) // 2 - (positions + 1) // 2
            correction = xpos.scale ** (centers.to(xpos.scale)[:, None] / xpos.scale_base)
            result = result * correction.repeat_interleave(2, dim=-1)
        return result

    def __call__(self, *args, **kwargs):
        # A read-only view, not a copied Module with a shared _modules dict.
        return type(self.attention).forward(self, *args, **kwargs)


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
        """Decode known OCR tokens together, keeping native per-character colors."""
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
        decoded = model.embd(inputs)
        causal = memory.new_full((length, length), float('-inf')).triu_(1)
        for layer in model.decoders:
            normalized = layer.norm1(decoded)
            decoded = decoded + layer.self_attn(normalized, normalized, normalized, attn_mask=causal)[0]
            decoded = decoded + _ParallelCrossAttention(layer.multihead_attn)(
                layer.norm2(decoded), memory, memory, key_padding_mask=mask)[0]
            decoded = decoded + layer._ff_block(layer.norm3(decoded))
        features = model.color_pred1(decoded)
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

    def _monochrome_region(self, image, region):
        from .ocr import valid_crop
        # Inspect every line, not only a representative: a colored last line
        # must keep the paragraph on the model path rather than the plain style.
        checked = False
        for points in region.lines:
            crop = cached_crop(image, points, self.predictor._get_rotate_crop_image)
            if not valid_crop(crop):
                continue
            checked = True
            if not _monochrome(crop):
                return False
        return checked

    def _representative(self, image, region):
        from modules.detection.script_detection import _line_area
        from .ocr import valid_crop
        texts = self._line_texts(region)
        # Prefer reliable line-aligned OCR, then the existing native largest-line
        # rule (first wins ties). Japanese paragraph text stays unaligned here.
        indices = sorted(range(len(region.lines)), key=lambda i: (
            bool(texts[i] and texts[i].strip()), _line_area(region.lines[i])), reverse=True)
        for index in indices:
            crop = cached_crop(image, region.lines[index], self.predictor._get_rotate_crop_image)
            if valid_crop(crop):
                return crop, self._encode(texts[index])
        return None, None

    def apply(self, image, regions):
        from manga_translator.utils import chunks
        # CPU-only render workers use the contrast guard, not the OCR runtime.
        from .ocr import OCR_BATCH_SIZE
        predicted = []
        skipped_lines = 0
        with stage('analyze_color_gate'):
            for region in regions:
                if self._monochrome_region(image, region):
                    region.set_font_colors(np.zeros(3), np.full(3, 255.))
                    skipped_lines += len(region.lines)
                else:
                    region.set_font_colors(np.zeros(3), np.zeros(3))
                    predicted.append(region)
        record('color_fast_regions', len(regions) - len(predicted))
        record('color_fast_lines', skipped_lines)
        record('color_model_lines', 0)
        # Bound both crops and GPU batches, including on very long pages. Native
        # crops, preprocessing and per-character aggregation stay intact. Only
        # one line contributes colors; full OCR/erasure/layout geometry is retained.
        for batch in chunks(predicted, OCR_BATCH_SIZE):
            crops, owners, tokens = [], [], []
            for region in batch:
                crop, text_indices = self._representative(image, region)
                if crop is None:
                    # Match upstream's black/white fallback for unusable input.
                    region.set_font_colors(np.zeros(3), np.full(3, 255.))
                    continue
                crops.append(bgr(crop))
                owners.append(region)
                tokens.append(text_indices)
            if crops:
                record('color_model_lines', len(crops))
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
                    # update_font_colors divides by the original OCR line count,
                    # which would darken a single representative prediction.
                    region.set_font_colors(np.asarray(color[:3]), np.asarray(color[3:]))

    def close(self):
        self.predictor = None
