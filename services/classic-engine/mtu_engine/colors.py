"""Adapt MTU color prediction and keep the rendered outline readable."""
import cv2
import numpy as np


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
    """Keep native beam inference; avoid per-character CUDA scalar transfers."""
    def __init__(self, model):
        self.model = model

    @property
    def dictionary(self):
        return self.model.dictionary

    def infer_beam_batch_tensor(self, *args, **kwargs):
        # Keep torch out of CPU-only render workers importing the contrast guard.
        import torch
        predictions = self.model.infer_beam_batch_tensor(*args, **kwargs)
        return [tuple(value.detach().cpu() if torch.is_tensor(value) else value for value in row)
                for row in predictions]


class Colors:
    def __init__(self, model):
        from manga_translator.ocr.model_paddleocr import ModelPaddleOCR
        # Construct only the adapter, never another Paddle session or 48px model.
        self.predictor = ModelPaddleOCR()
        self.predictor.color_model = _CpuColorModel(model.model)
        self.predictor.device = model.device
        self.predictor.use_gpu = model.use_gpu

    def apply(self, image, regions):
        from manga_translator.utils import chunks
        # CPU-only render workers use the contrast guard, not the OCR runtime.
        from .ocr import OCR_BATCH_SIZE, valid_crop
        for region in regions:
            region.set_font_colors(np.zeros(3), np.zeros(3))
        lines = [(region, points) for region in regions for points in region.lines]
        # Bound both crops and GPU batches, including on very long pages. Native
        # prediction still runs the 48px decoder; its text never replaces OCR.
        for batch in chunks(lines, OCR_BATCH_SIZE):
            crops, owners = [], []
            for region, points in batch:
                crop = self.predictor._get_rotate_crop_image(image, points)
                if not valid_crop(crop):
                    # Match upstream's black/white fallback for unusable input.
                    region.update_font_colors(np.zeros(3), np.full(3, 255.))
                    continue
                crops.append(cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
                owners.append(region)
            if crops:
                colors = self.predictor._estimate_colors_batch(crops)
                for region, color in zip(owners, colors, strict=True):
                    region.update_font_colors(np.asarray(color[:3]), np.asarray(color[3:]))

    def close(self):
        self.predictor = None
