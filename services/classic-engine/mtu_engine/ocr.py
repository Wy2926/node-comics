"""Adapt MTU crops/session/CTC to RapidOCR's unmodified recognition pipeline."""
from types import SimpleNamespace
from pathlib import Path
from threading import Lock

import cv2
from rapidocr.ch_ppocr_rec import TextRecognizer
from rapidocr.ch_ppocr_rec.typings import TextRecInput
from rapidocr.inference_engine.onnxruntime import OrtInferSession

from classic_node.timing import waiting_for
from .page_cache import bgr, crop as cached_crop, normalized

OCR_IMAGE_SHAPE = (3, 48, 320)
OCR_MAX_WIDTH = 3200  # PaddleX's standard recognition width limit.
OCR_BATCH_SIZE = 6  # RapidOCR's default recognition batch.


def valid_crop(crop):
    return (crop is not None and crop.size > 0
            and crop.shape[1] * OCR_IMAGE_SHAPE[1] <= crop.shape[0] * OCR_MAX_WIDTH)


def short_crop(crop):
    """These crops always use RapidOCR's fixed minimum padding width."""
    return valid_crop(crop) and crop.shape[1] * OCR_IMAGE_SHAPE[1] <= crop.shape[0] * OCR_IMAGE_SHAPE[2]


class _LockedSession:
    """Serialize one resident model's inference, not RapidOCR preprocessing/CTC."""
    def __init__(self, session):
        self._session = session
        self._lock = Lock()

    def __call__(self, batch):
        with waiting_for(self._lock, 'ocr_lock_wait'):
            return self._session(batch)


class Recognizer(TextRecognizer):
    def __init__(self, model):
        # Reuse the prepared CUDA session and official dictionary via MTU's
        # decoder; do not initialize/download another model or dictionary.
        self.session = _LockedSession(OrtInferSession({'session': model.session}))
        self.postprocess_op = lambda predictions, *args, **kwargs: (
            [model._decode_ctc(prediction) for prediction in predictions], [])
        self.rec_batch_num = OCR_BATCH_SIZE
        self.rec_image_shape = OCR_IMAGE_SHAPE
        self.cfg = SimpleNamespace(lang_type='ch', font_path=None)
        self.RTL_LANGS = set()
        self.crop = lambda image, points: cached_crop(image, points, model._get_rotate_crop_image)

    def resize_norm_img(self, image, max_wh_ratio):
        return normalized(image, max_wh_ratio, self.rec_image_shape,
            lambda: TextRecognizer.resize_norm_img(self, image, max_wh_ratio))

    def read(self, crops):
        rows = [{'text': '', 'conf': 0.} for _ in crops]
        groups = ([], [])
        for index, crop in enumerate(crops):
            # Reject unsupported input rather than squeezing or truncating it.
            if valid_crop(crop):
                groups[0 if short_crop(crop) else 1].append(index)
        for indices in groups:
            if not indices:
                continue
            # Only separate short lines from long ones: a long disclaimer must
            # not change a short dialogue's padding. RapidOCR still owns batch
            # size, sorting, resize/padding and restoration inside each group.
            result = self(TextRecInput([bgr(crops[i]) for i in indices]))
            for index, text, score in zip(indices, result.txts, result.scores, strict=True):
                rows[index] = {'text': text, 'conf': float(score)}
        return rows

    def recognize(self, image, lines, threshold):
        rows = self.read([self.crop(image, line.pts) for line in lines])
        for line, row in zip(lines, rows, strict=True):
            line.text = row['text'] if row['conf'] >= threshold else ''
            line.prob = row['conf']
        return lines


class Paddle:
    """Prepared PP-OCRv5 sessions; MTU decoder and RapidOCR inference unchanged."""
    def __init__(self, models, language, gpu, threads):
        from manga_translator.ocr.model_paddleocr import ModelPaddleOCR
        from manga_translator.utils.onnx_runtime import create_inference_session, import_onnxruntime
        ort = import_onnxruntime()
        ort.set_default_logger_severity(3)
        model = ModelPaddleOCR('korean' if language == 'korean' else 'ch')
        dictionary = f'ppocrv5_{language}_dict.txt' if language != 'ch' else 'ppocrv5_dict.txt'
        directory = Path(models) / 'ocr'
        model.char_dict = model._load_char_dict({'dict': str(directory / dictionary)})
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        model.session, _ = create_inference_session(ort,
            str(directory / f'{language}_PP-OCRv5_rec_mobile_infer.onnx'),
            device='cuda', sess_options=options,
            cuda_options={'device_id': gpu, 'cudnn_conv_algo_search': 'HEURISTIC'},
            fallback_to_cpu=False, logger=model.logger)
        if model.session.get_providers()[0] != 'CUDAExecutionProvider':
            raise RuntimeError('PP-OCR requires ONNX Runtime CUDAExecutionProvider')
        model.session.disable_fallback()
        if model.session.get_outputs()[0].shape[-1] != len(model.char_dict):
            raise ValueError('PP-OCR model/dictionary mismatch')
        self.session = model.session
        self.recognizer = Recognizer(model)

    def probe(self, crops):
        return self.recognizer.read(crops)

    async def recognize(self, image, lines, config):
        return self.recognizer.recognize(image, lines, config.prob)

    def close(self):
        self.recognizer = self.session = None
