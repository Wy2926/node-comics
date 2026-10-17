"""Adapt MTU crops/session/CTC to RapidOCR's unmodified recognition pipeline."""
from types import SimpleNamespace
from copy import copy
from functools import partial
from pathlib import Path
from threading import Lock

import cv2
from rapidocr.ch_ppocr_rec import TextRecognizer
from rapidocr.ch_ppocr_rec.typings import TextRecInput
from rapidocr.inference_engine.onnxruntime import OrtInferSession

from classic_node.config import ENGINE_DEFAULTS
from classic_node.timing import waiting_for, record, stage
from .page_cache import bgr, crop as cached_crop, normalized

OCR_IMAGE_SHAPE = (3, 48, 320)
OCR_MAX_WIDTH = 3200  # PaddleX's standard recognition width limit.
# Windows AMD driver safety: DML submissions across languages must not overlap.
# CUDA retains its original independent per-model locks.
_DML_INFERENCE_LOCK = Lock()


def allocation_failure(error):
    """Only allocator exhaustion is retryable, not arbitrary CUDA/model errors."""
    for _ in range(8):
        message = str(error).lower()
        if (('bfc_arena.cc' in message and 'failed to allocate memory' in message)
                or 'cudaerrormemoryallocation' in message or 'cuda_error_out_of_memory' in message
                or ('cuda' in message and 'out of memory' in message)):
            return True
        if error.__cause__ is None:
            return False
        error = error.__cause__
    return False


def release_cuda_cache(gpu):
    import torch
    # Only after an allocation failure: release UNUSED PyTorch blocks so ORT
    # can use them. Never unload weights, touch live tensors or flush each page.
    with torch.cuda.device(gpu):
        torch.cuda.empty_cache()


def valid_crop(crop):
    return (crop is not None and crop.size > 0
            and crop.shape[1] * OCR_IMAGE_SHAPE[1] <= crop.shape[0] * OCR_MAX_WIDTH)


def short_crop(crop):
    """These crops always use RapidOCR's fixed minimum padding width."""
    return valid_crop(crop) and crop.shape[1] * OCR_IMAGE_SHAPE[1] <= crop.shape[0] * OCR_IMAGE_SHAPE[2]


class _LockedSession:
    """Serialize one resident model's inference, not RapidOCR preprocessing/CTC."""
    def __init__(self, session, lock=None):
        self._session = session
        self._lock = Lock() if lock is None else lock

    def __call__(self, batch):
        record('ocr_batches', 1)
        record('ocr_batch_max', len(batch), maximum=True)
        record('ocr_width_max', batch.shape[-1], maximum=True)
        record('ocr_input_bytes_max', batch.nbytes, maximum=True)
        with waiting_for(self._lock, 'ocr_lock_wait'):
            with stage('ocr_infer'):
                return self._session(batch)


class Recognizer(TextRecognizer):
    def __init__(self, model, batch_size=ENGINE_DEFAULTS['ocr_batch_size'],
                 min_batch_size=ENGINE_DEFAULTS['ocr_min_batch_size'], recover=None, *, inference_lock=None):
        # Reuse the prepared CUDA session and official dictionary via MTU's
        # decoder; do not initialize/download another model or dictionary.
        self.session = _LockedSession(OrtInferSession({'session': model.session}), inference_lock)
        self.postprocess_op = lambda predictions, *args, **kwargs: (
            [model._decode_ctc(prediction) for prediction in predictions], [])
        self.rec_batch_num = batch_size
        self.min_batch_size = min_batch_size
        self.recover = recover
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
            reader = self
            recovered = False
            while True:
                try:
                    result = reader(TextRecInput([bgr(crops[i]) for i in indices]))
                    break
                except Exception as error:
                    if not allocation_failure(error):
                        raise
                    record('ocr_ooms', 1)
                    actual = min(reader.rec_batch_num, len(indices))
                    if actual <= self.min_batch_size:
                        raise
                    # Request-local copy: concurrent pages must never change one
                    # another's native batch setting, padding or result mapping.
                    reader = copy(reader)
                    reader.rec_batch_num = max(self.min_batch_size, actual // 2)
                # Leave the exception frame before reclaiming unused blocks.
                if not recovered and self.recover is not None:
                    with stage('ocr_cache_release'):
                        self.recover()
                    record('ocr_cache_releases', 1)
                    recovered = True
                record('ocr_oom_retries', 1)
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
    def __init__(self, models, language, gpu, threads, *,
                 batch_size=ENGINE_DEFAULTS['ocr_batch_size'],
                 min_batch_size=ENGINE_DEFAULTS['ocr_min_batch_size'],
                 arena_extend_strategy=ENGINE_DEFAULTS['ocr_arena_extend_strategy'],
                 arena_shrinkage=ENGINE_DEFAULTS['ocr_arena_shrinkage'], backend='cuda'):
        if backend not in ('cuda', 'amd'):
            raise ValueError('backend must be cuda or amd')
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
        model_path = str(directory / f'{language}_PP-OCRv5_rec_mobile_infer.onnx')
        provider = 'CUDAExecutionProvider'
        if backend == 'amd':
            provider = 'DmlExecutionProvider'
            if provider not in ort.get_available_providers():
                raise RuntimeError('AMD OCR requires the separate onnxruntime-directml environment')
            options.enable_mem_pattern = False
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            model.session = ort.InferenceSession(model_path, sess_options=options,
                                                 providers=[(provider, {'device_id': gpu})])
            # CUDA arena options and CUDA allocation recovery do not apply to DML.
            arena_shrinkage = False
        else:
            model.session, _ = create_inference_session(ort, model_path,
                device='cuda', sess_options=options,
                cuda_options={'device_id': gpu, 'cudnn_conv_algo_search': 'HEURISTIC',
                              'arena_extend_strategy': arena_extend_strategy},
                fallback_to_cpu=False, logger=model.logger)
        if model.session.get_providers()[0] != provider:
            raise RuntimeError(f'PP-OCR requires ONNX Runtime {provider}')
        model.session.disable_fallback()
        if model.session.get_outputs()[0].shape[-1] != len(model.char_dict):
            raise ValueError('PP-OCR model/dictionary mismatch')
        self._arena_shrinkage = arena_shrinkage
        if arena_shrinkage:
            options = ort.RunOptions()
            options.add_run_config_entry('memory.enable_memory_arena_shrinkage', f'gpu:{gpu}')
            # Adapt this instance's public run method only. RapidOCR retains its
            # native session call, preprocessing, sorting, batching and decoder.
            model.session.run = partial(model.session.run, run_options=options)
        self.session = model.session
        self.recognizer = Recognizer(model, batch_size,
            batch_size if backend == 'amd' else min_batch_size,
            None if backend == 'amd' else partial(release_cuda_cache, gpu),
            inference_lock=_DML_INFERENCE_LOCK if backend == 'amd' else None)

    def probe(self, crops):
        return self.recognizer.read(crops)

    async def recognize(self, image, lines, config):
        return self.recognizer.recognize(image, lines, config.prob)

    def close(self):
        if self.session is not None and self._arena_shrinkage:
            # Break the bound-method partial's self-reference after draining.
            # Class lookup restores the original public run method.
            del self.session.run
        self.recognizer = self.session = None
