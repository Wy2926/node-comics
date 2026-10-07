"""Session-level OCR concurrency without CUDA, model assets or timing sleeps."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from threading import Event
from types import SimpleNamespace

import numpy as np
import pytest
from rapidocr.ch_ppocr_rec import TextRecognizer

from classic_node import timing
from mtu_engine.ocr import Paddle, Recognizer


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
        token = clock.set(iter((0., seconds)))
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
        assert first.result(timeout=5) == ([{'text': '11', 'conf': .9}], {'ocr_lock_wait': .125})
        assert second.result(timeout=5) == ([{'text': '22', 'conf': .9}], {'ocr_lock_wait': .75})
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
    assert tensors == [(6, 3, 48, 320), (3, 3, 48, 320), (3, 3, 48, 3200)]
    assert stages == {'crop', 'resize', 'ctc'}
    assert [line.text for line in lines] == [str(index) for index in range(12)] + ['']
    assert [line.prob for line in lines] == [.9] * 12 + [0.]
