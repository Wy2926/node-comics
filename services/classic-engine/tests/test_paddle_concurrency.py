"""Session-level OCR concurrency without CUDA, model assets or timing sleeps."""
import asyncio
import sys
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from threading import Event
from types import SimpleNamespace

import numpy as np
import pytest
from rapidocr.ch_ppocr_rec import TextRecognizer

from classic_node import timing
from mtu_engine.ocr import Paddle, Recognizer


@pytest.mark.parametrize('shrink', [False, True])
def test_paddle_delegates_memory_policy_to_native_ort(monkeypatch, tmp_path, shrink):
    captured, runs = {}, []
    class Options:
        def __init__(self):
            self.entries = {}
        def add_session_config_entry(self, key, value):
            self.entries[key] = value
        add_run_config_entry = add_session_config_entry
    class Session:
        def get_providers(self):
            return ['CUDAExecutionProvider']
        def disable_fallback(self):
            captured['fallback_disabled'] = True
        def get_outputs(self):
            return [SimpleNamespace(shape=[1])]
        def run(self, outputs, inputs, run_options=None):
            runs.append(run_options)
            return ['native-output']
    session = Session()
    ort = SimpleNamespace(SessionOptions=Options, RunOptions=Options, set_default_logger_severity=lambda _: None)
    def create(_ort, _path, **kwargs):
        captured.update(kwargs)
        return session, None
    model = SimpleNamespace(logger=None, _load_char_dict=lambda _: ['x'])
    monkeypatch.setitem(sys.modules, 'manga_translator.ocr.model_paddleocr',
                        SimpleNamespace(ModelPaddleOCR=lambda _: model))
    monkeypatch.setitem(sys.modules, 'manga_translator.utils.onnx_runtime',
                        SimpleNamespace(create_inference_session=create, import_onnxruntime=lambda: ort))
    monkeypatch.setattr('mtu_engine.ocr.OrtInferSession', lambda cfg: cfg['session'])
    paddle = Paddle(tmp_path, 'en', 2, 3, batch_size=3, min_batch_size=1,
                    arena_extend_strategy='kSameAsRequested', arena_shrinkage=shrink)
    assert captured['cuda_options'] == {'device_id': 2, 'cudnn_conv_algo_search': 'HEURISTIC',
                                        'arena_extend_strategy': 'kSameAsRequested'}
    assert captured['fallback_disabled'] and captured['fallback_to_cpu'] is False
    assert captured['sess_options'].intra_op_num_threads == 3
    assert session.run([], {}) == ['native-output']
    assert (runs[0].entries if shrink else runs[0]) == (
        {'memory.enable_memory_arena_shrinkage': 'gpu:2'} if shrink else None)
    assert paddle.recognizer.rec_batch_num == 3
    from mtu_engine.ocr import _DML_INFERENCE_LOCK, release_cuda_cache
    assert paddle.recognizer.session._lock is not _DML_INFERENCE_LOCK
    assert paddle.recognizer.min_batch_size == 1
    assert paddle.recognizer.recover.func is release_cuda_cache and paddle.recognizer.recover.args == (2,)
    paddle.close()
    paddle.close()
    assert 'run' not in vars(session)


def test_native_ort_run_options_remain_compatible_with_rapidocr():
    # Real pinned ORT + RapidOCR on their shipped tiny CPU example. This checks
    # adapter plumbing only; it is NOT CUDA arena/performance acceptance.
    from functools import partial
    import onnxruntime as ort
    from onnxruntime.datasets import get_example
    from rapidocr.inference_engine.onnxruntime import OrtInferSession
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    session = ort.InferenceSession(get_example('mul_1.onnx'), sess_options=options,
                                   providers=['CPUExecutionProvider'])
    inputs = np.arange(6, dtype=np.float32).reshape(3, 2)
    adapter = OrtInferSession({'session': session})
    expected = adapter(inputs)
    run_options = ort.RunOptions()
    run_options.add_run_config_entry('memory.enable_memory_arena_shrinkage', 'cpu:0')
    session.run = partial(session.run, run_options=run_options)
    try:
        np.testing.assert_array_equal(adapter(inputs), expected)
    finally:
        del session.run


@pytest.mark.parametrize('failure', [None, 'unavailable', 'cpu-fallback', 'dictionary'])
def test_amd_sessions_share_only_the_inference_lock_and_never_cuda_policy(monkeypatch, tmp_path, failure):
    calls = []
    class Options:
        def add_session_config_entry(self, *args):
            pass
    class Session:
        def __init__(self, path, **kwargs):
            calls.append(kwargs)
        def get_providers(self):
            return ['CPUExecutionProvider' if failure == 'cpu-fallback' else 'DmlExecutionProvider']
        def disable_fallback(self):
            self.fallback_disabled = True
        def get_outputs(self):
            return [SimpleNamespace(shape=[2 if failure == 'dictionary' else 1])]
    def unexpected(*args, **kwargs):
        raise AssertionError('AMD must not initialize CUDA or use CUDA RunOptions')
    ort = SimpleNamespace(SessionOptions=Options, InferenceSession=Session, RunOptions=unexpected,
        ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL='sequential'), set_default_logger_severity=lambda _: None,
        get_available_providers=lambda: [] if failure == 'unavailable' else ['DmlExecutionProvider'])
    monkeypatch.setitem(sys.modules, 'manga_translator.ocr.model_paddleocr', SimpleNamespace(
        ModelPaddleOCR=lambda _: SimpleNamespace(_load_char_dict=lambda _: ['x'])))
    monkeypatch.setitem(sys.modules, 'manga_translator.utils.onnx_runtime', SimpleNamespace(
        create_inference_session=unexpected, import_onnxruntime=lambda: ort))
    monkeypatch.setattr('mtu_engine.ocr.OrtInferSession', lambda cfg: cfg['session'])
    if failure:
        with pytest.raises((RuntimeError, ValueError)):
            Paddle(tmp_path, 'ch', 0, 4, backend='amd')
        return
    first, second = [Paddle(tmp_path, lang, 0, 4, backend='amd') for lang in ('ch', 'en')]
    assert first.session is not second.session
    assert first.recognizer.session._lock is second.recognizer.session._lock
    assert first.recognizer.min_batch_size == first.recognizer.rec_batch_num == 4
    assert first.recognizer.recover is None and first.session.fallback_disabled
    for call in calls:
        assert call['providers'] == [('DmlExecutionProvider', {'device_id': 0})]
        options = call['sess_options']
        assert options.enable_mem_pattern is False and options.execution_mode == 'sequential'
        assert options.intra_op_num_threads == 4 and options.inter_op_num_threads == 1
    first.close()
    second.close()


def _prediction(batch):
    return np.rint((batch[:, 0, 0, 0] + 1) * 127.5).astype(int)


def _paddle(monkeypatch, infer, *, decode=None, crop=None):
    monkeypatch.setattr('mtu_engine.ocr.OrtInferSession', lambda cfg: cfg['session'])
    model = SimpleNamespace(session=infer,
                            _decode_ctc=decode or (lambda value: (str(value), .9)),
                            _get_rotate_crop_image=crop or (lambda image, pts: pts))
    paddle = Paddle.__new__(Paddle)
    paddle.session = model.session
    paddle.recognizer = Recognizer(model)
    return paddle


def _crop(value, width=48):
    return np.full((48, width, 3), value, dtype=np.uint8)


class _ObservedLock:
    """Observe the second acquisition attempt while using the actual model lock."""
    def __init__(self, lock):
        self.lock = lock
        self.contended = Event()

    def acquire(self):
        if self.lock.locked():
            self.contended.set()
        return self.lock.acquire()

    def release(self):
        self.lock.release()


@pytest.mark.parametrize('second_operation', ['probe', 'recognize'])
def test_same_session_serializes_and_keeps_page_results_and_timings_separate(monkeypatch, second_operation):
    first_entered, second_entered, release_first = Event(), Event(), Event()
    clock = ContextVar('fixture_ocr_clock')
    monkeypatch.setattr(timing, 'perf_counter', lambda: next(clock.get()))

    def infer(batch):
        values = _prediction(batch)
        if values[0] == 11:
            first_entered.set()
            assert release_first.wait(5)
        else:
            second_entered.set()
        return values

    paddle = _paddle(monkeypatch, infer)
    lock = _ObservedLock(paddle.recognizer.session._lock)
    paddle.recognizer.session._lock = lock

    def run(value, operation, seconds):
        token = clock.set(iter((0., seconds, seconds, seconds + .25)))
        try:
            with timing.collect() as timings:
                if operation == 'probe':
                    rows = paddle.probe([_crop(value)])
                else:
                    lines = [SimpleNamespace(pts=_crop(value), text='stale', prob=0)]
                    asyncio.run(paddle.recognize(None, lines, SimpleNamespace(prob=.5)))
                    rows = [{'text': line.text, 'conf': line.prob} for line in lines]
            return rows, timings
        finally:
            clock.reset(token)

    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(run, 11, 'probe', .125)
        try:
            assert first_entered.wait(5)
            second = pool.submit(run, 22, second_operation, .75)
            assert lock.contended.wait(5)
            assert not second_entered.is_set()
        finally:
            release_first.set()
        for future, text, wait in ((first, '11', .125), (second, '22', .75)):
            rows, values = future.result(timeout=5)
            assert rows == [{'text': text, 'conf': .9}]
            assert values['ocr_lock_wait'] == wait and values['ocr_infer'] == .25
            assert values['ocr_batches'] == values['ocr_batch_max'] == 1
    assert second_entered.is_set()
    assert timing.current.get() is None


def test_different_sessions_can_infer_while_another_session_is_busy(monkeypatch):
    first_entered, second_entered, release = Event(), Event(), Event()

    def first_infer(batch):
        first_entered.set()
        assert release.wait(5)
        return _prediction(batch)

    def second_infer(batch):
        second_entered.set()
        return _prediction(batch)

    first = _paddle(monkeypatch, first_infer)
    second = _paddle(monkeypatch, second_infer)
    with ThreadPoolExecutor(2) as pool:
        first_job = pool.submit(first.probe, [_crop(11)])
        try:
            assert first_entered.wait(5)
            second_job = pool.submit(second.probe, [_crop(22)])
            assert second_entered.wait(5)
            assert second_job.result(timeout=5) == [{'text': '22', 'conf': .9}]
            assert not first_job.done()
        finally:
            release.set()
        assert first_job.result(timeout=5) == [{'text': '11', 'conf': .9}]


def test_inference_failure_releases_session_and_records_wait(monkeypatch):
    failed = False

    def infer(batch):
        nonlocal failed
        if not failed:
            failed = True
            raise ValueError('fixture inference failure')
        return _prediction(batch)

    paddle = _paddle(monkeypatch, infer)
    with timing.collect() as timings:
        with pytest.raises(ValueError, match='fixture inference failure'):
            paddle.probe([_crop(11)])
    assert timings['ocr_lock_wait'] >= 0
    lock = paddle.recognizer.session._lock
    assert lock.acquire(blocking=False)
    lock.release()
    assert paddle.probe([_crop(22)]) == [{'text': '22', 'conf': .9}]


def test_crop_resize_and_ctc_remain_outside_lock_with_native_batches(monkeypatch):
    tensors = []
    stages = set()

    def outside_lock(stage):
        lock = paddle.recognizer.session._lock
        assert lock.acquire(blocking=False), stage
        lock.release()
        stages.add(stage)

    def crop(image, pts):
        outside_lock('crop')
        return pts

    def decode(value):
        outside_lock('ctc')
        return str(value), .9

    resize = TextRecognizer.resize_norm_img

    def resize_outside_lock(self, image, ratio):
        outside_lock('resize')
        return resize(self, image, ratio)

    def infer(batch):
        assert paddle.recognizer.session._lock.locked()
        tensors.append(batch.shape)
        return _prediction(batch)

    paddle = _paddle(monkeypatch, infer, decode=decode, crop=crop)
    monkeypatch.setattr(TextRecognizer, 'resize_norm_img', resize_outside_lock)
    widths = (160, 48, 2500, 600, 320, 48, 90, 100, 320, 280, 310, 3200, 3201)
    lines = [SimpleNamespace(pts=_crop(index, width), text='stale', prob=1)
             for index, width in enumerate(widths)]
    assert asyncio.run(paddle.recognize(None, lines, SimpleNamespace(prob=.5))) is lines
    assert tensors == [(4, 3, 48, 320), (4, 3, 48, 320), (1, 3, 48, 320), (3, 3, 48, 3200)]
    assert stages == {'crop', 'resize', 'ctc'}
    assert [line.text for line in lines] == [str(index) for index in range(12)] + ['']
    assert [line.prob for line in lines] == [.9] * 12 + [0.]


def test_oom_retry_does_not_reduce_another_pages_native_batch(monkeypatch):
    recovering, release = Event(), Event()
    batches = []
    def infer(batch):
        values = _prediction(batch)
        batches.append((values[0], len(batch)))
        if values[0] == 11 and len(batch) > 1:
            raise RuntimeError('CUDA out of memory')
        return values
    paddle = _paddle(monkeypatch, infer)
    def recover():
        recovering.set()
        assert release.wait(5)
    paddle.recognizer.recover = recover
    with ThreadPoolExecutor(2) as workers:
        first = workers.submit(paddle.probe, [_crop(11)] * 4)
        try:
            assert recovering.wait(5)
            second = workers.submit(paddle.probe, [_crop(22)] * 4)
            assert second.result(timeout=5) == [{'text': '22', 'conf': .9}] * 4
        finally:
            release.set()
        assert first.result(timeout=5) == [{'text': '11', 'conf': .9}] * 4
    assert (22, 4) in batches
    assert [size for value, size in batches if value == 11] == [4, 2, 1, 1, 1, 1]
    assert paddle.recognizer.rec_batch_num == 4
