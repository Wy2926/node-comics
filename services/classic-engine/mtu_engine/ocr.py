"""Adapt MTU crops/session/CTC to RapidOCR's unmodified recognition pipeline."""
from types import SimpleNamespace
from pathlib import Path

import cv2
from rapidocr.ch_ppocr_rec import TextRecognizer
from rapidocr.ch_ppocr_rec.typings import TextRecInput
from rapidocr.inference_engine.onnxruntime import OrtInferSession

OCR_IMAGE_SHAPE = (3, 48, 320)
OCR_MAX_WIDTH = 3200  # PaddleX's standard recognition width limit.
OCR_BATCH_SIZE = 6  # RapidOCR's default recognition batch.


def valid_crop(crop):
    return (crop is not None and crop.size > 0
            and crop.shape[1] * OCR_IMAGE_SHAPE[1] <= crop.shape[0] * OCR_MAX_WIDTH)


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
            # Reject unsupported input instead of squeezing it or allocating
            # unbounded tensors. Other recognized lines can still be translated.
            if not valid_crop(crop):
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
            cuda_options={'device_id': gpu, 'cudnn_conv_algo_search': 'DEFAULT'},
            fallback_to_cpu=False, logger=model.logger)
        if model.session.get_providers()[0] != 'CUDAExecutionProvider':
            raise RuntimeError('PP-OCR requires ONNX Runtime CUDAExecutionProvider')
        model.session.disable_fallback()
        if model.session.get_outputs()[0].shape[-1] != len(model.char_dict):
            raise ValueError('PP-OCR model/dictionary mismatch')
        self.session = model.session
        self.recognizer = Recognizer(model)

    def probe(self, crops):
        indices = [index for index, crop in enumerate(crops) if valid_crop(crop)]
        rows = [{'text': '', 'conf': 0.} for _ in crops]
        if indices:
            result = self.recognizer(TextRecInput([cv2.cvtColor(crops[i], cv2.COLOR_RGB2BGR) for i in indices]))
            for index, text, score in zip(indices, result.txts, result.scores, strict=True):
                rows[index] = {'text': text, 'conf': float(score)}
        return rows

    async def recognize(self, image, lines, config):
        return self.recognizer.recognize(image, lines, config.prob)

    def close(self):
        self.recognizer = self.session = None
