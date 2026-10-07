"""Model-instance lock boundaries with events, without model assets or CUDA."""
from concurrent.futures import ThreadPoolExecutor
import sys
from threading import Event
from types import SimpleNamespace

import numpy as np
import pytest

from classic_node.timing import collect
from mtu_engine.colors import _CpuColorModel
from mtu_engine.experts import Japanese


class ObservedLock:
    """Expose an acquisition attempt while retaining the model's actual lock."""
    def __init__(self, lock):
        self.lock = lock
        self.attempted = Event()

    def acquire(self):
        self.attempted.set()
        return self.lock.acquire()

    def release(self):
        self.lock.release()

    def locked(self):
        return self.lock.locked()


@pytest.fixture
def model_factory(monkeypatch, tmp_path):
    directory = tmp_path / 'manga'
    directory.mkdir()
    for name in ('config.json', 'preprocessor_config.json', 'tokenizer_config.json',
                 'vocab.txt', 'pytorch_model.bin'):
        (directory / name).touch()
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(is_tensor=lambda value: False))
    monkeypatch.setitem(sys.modules, 'loguru', SimpleNamespace(logger=SimpleNamespace(disable=lambda name: None)))

    def make(kind, callback):
        if kind == 'color':
            expert = _CpuColorModel(SimpleNamespace(infer_beam_batch_tensor=lambda: [(callback(),)]))
            invoke = expert.infer_beam_batch_tensor
        else:
            class Native:
                model = SimpleNamespace(device=SimpleNamespace(type='cuda', index=0))

                def __call__(self, image):
                    assert image.size == (8, 6)
                    return callback()

            monkeypatch.setitem(sys.modules, 'manga_ocr', SimpleNamespace(MangaOcr=lambda path: Native()))
            expert = Japanese(tmp_path, 0)

            def invoke():
                lines = [SimpleNamespace(text='old', prob=.9)]
                expert.recognize(np.zeros((6, 8, 3), dtype=np.uint8),
                                 [SimpleNamespace(xyxy=[0, 0, 8, 6])], [lines])
                return lines[0].text
        return expert, invoke

    return make


@pytest.mark.parametrize('kind', ['color', 'japanese'])
@pytest.mark.parametrize('fail_first', [False, True])
def test_same_instance_serializes_model_calls_and_recovers_after_error(model_factory, kind, fail_first):
    entered, release = Event(), Event()
    calls = []
    failure = RuntimeError('fixture model failure')

    def infer():
        calls.append(True)
        if len(calls) == 1:
            entered.set()
            assert release.wait(5)
            if fail_first:
                raise failure
        return 'recognized'

    expert, invoke = model_factory(kind, infer)
    expert._lock = ObservedLock(expert._lock)
    with ThreadPoolExecutor(2) as workers:
        first = workers.submit(invoke)
        try:
            assert entered.wait(5)
            expert._lock.attempted.clear()
            second = workers.submit(invoke)
            assert expert._lock.attempted.wait(5)
            assert calls == [True] and expert._lock.locked()
        finally:
            release.set()
        if fail_first:
            with pytest.raises(RuntimeError) as caught:
                first.result(timeout=5)
            assert caught.value is failure
        else:
            first.result(timeout=5)
        second.result(timeout=5)
    assert len(calls) == 2 and not expert._lock.locked()


@pytest.mark.parametrize('kinds', [('color', 'color'), ('japanese', 'japanese'), ('color', 'japanese')])
def test_separate_model_instances_do_not_block_each_other(model_factory, kinds):
    entered, release = Event(), Event()

    def blocked():
        entered.set()
        assert release.wait(5)
        return 'first'

    first_expert, first_call = model_factory(kinds[0], blocked)
    second_expert, second_call = model_factory(kinds[1], lambda: 'second')
    assert first_expert._lock is not second_expert._lock
    with ThreadPoolExecutor(2) as workers:
        first = workers.submit(first_call)
        try:
            assert entered.wait(5)
            workers.submit(second_call).result(timeout=5)
        finally:
            release.set()
        first.result(timeout=5)


@pytest.mark.parametrize('kind', ['color', 'japanese'])
def test_model_wait_uses_existing_ocr_timing_key(model_factory, kind):
    _, invoke = model_factory(kind, lambda: 'recognized')
    with collect() as values:
        invoke()
    assert set(values) == {'ocr_lock_wait'} and values['ocr_lock_wait'] >= 0


def test_japanese_lock_only_covers_each_paragraph_model_call(model_factory, monkeypatch):
    calls = []

    def infer():
        assert expert._lock.locked()
        calls.append(True)
        return 'recognized'

    expert, _ = model_factory('japanese', infer)

    class Line:
        @property
        def text(self):
            return self._text

        @text.setter
        def text(self, value):
            assert not expert._lock.locked()
            self._text = value

    from mtu_engine.experts import Image
    fromarray = Image.fromarray

    def crop(pixels):
        assert not expert._lock.locked()
        return fromarray(pixels)

    monkeypatch.setattr(Image, 'fromarray', crop)
    groups = [[Line(), Line()], [Line()]]
    expert.recognize(np.zeros((6, 8, 3), dtype=np.uint8),
                     [SimpleNamespace(xyxy=[0, 0, 8, 6])] * 2, groups)
    assert calls == [True, True]
    assert [[line.text for line in group] for group in groups] == [['recognized', ''], ['recognized']]
    assert all(line.prob == 0. for group in groups for line in group)
    expert.close()
    assert expert.model is None
