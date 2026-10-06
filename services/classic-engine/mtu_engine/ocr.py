"""Adapt MTU crops/session/CTC to RapidOCR's unmodified recognition pipeline."""
from types import SimpleNamespace

import cv2
from rapidocr.ch_ppocr_rec import TextRecognizer
from rapidocr.ch_ppocr_rec.typings import TextRecInput
from rapidocr.inference_engine.onnxruntime import OrtInferSession

OCR_IMAGE_SHAPE = (3, 48, 320)
OCR_MAX_WIDTH = 3200  # PaddleX's standard recognition width limit.
OCR_BATCH_SIZE = 6  # RapidOCR's default recognition batch.


class Recognizer(TextRecognizer):
    def __init__(self, model):
        # Reuse the prepared CUDA session and official dictionary via MTU's
        # decoder; do not initialize/download another model or dictionary.
        self.session = OrtInferSession({'session': model.session})
        self.postprocess_op = lambda predictions, *args, **kwargs: (
            [model._decode_ctc(prediction) for prediction in predictions], [])
        self.rec_batch_num = OCR_BATCH_SIZE
        self.rec_image_shape = OCR_IMAGE_SHAPE
        self.cfg = SimpleNamespace(lang_type='ch', font_path=None)
        self.RTL_LANGS = set()
        self.crop = model._get_rotate_crop_image

    def recognize(self, image, lines, threshold):
        crops, valid = [], []
        for line in lines:
            line.text, line.prob = '', 0.0
            crop = self.crop(image, line.pts)
            if crop is None or not crop.size:
                continue
            height, width = crop.shape[:2]
            # Reject unsupported input instead of squeezing it or allocating
            # unbounded tensors. analyze preserves its incomplete paragraph.
            if width * OCR_IMAGE_SHAPE[1] > height * OCR_MAX_WIDTH:
                continue
            crops.append(cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
            valid.append(line)
        if crops:
            # Upstream owns aspect-ratio sorting, batch padding, inference and
            # restoration of the original line order. No local OCR algorithm.
            result = self(TextRecInput(crops))
            for line, text, score in zip(valid, result.txts, result.scores):
                line.text = text if score >= threshold else ''
                line.prob = float(score)
        return lines
