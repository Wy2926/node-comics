"""Adapt MTU's unmodified 48px color prediction and TextBlock aggregation."""
import cv2
import numpy as np

from .ocr import OCR_BATCH_SIZE, valid_crop


class Colors:
    def __init__(self, model):
        from manga_translator.ocr.model_paddleocr import ModelPaddleOCR
        # Construct only the adapter, never another Paddle session or 48px model.
        self.predictor = ModelPaddleOCR()
        self.predictor.color_model = model.model
        self.predictor.device = model.device
        self.predictor.use_gpu = model.use_gpu

    def apply(self, image, regions):
        from manga_translator.utils import chunks
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
