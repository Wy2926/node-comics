"""Adapter tests: input rejection, native scoring and batched paragraph routing."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
from types import SimpleNamespace
import sys

import numpy as np
import pytest

from mtu_engine.routing import ScriptRouter
from classic_node.timing import collect


def router():
    result = ScriptRouter.__new__(ScriptRouter)
    native = SimpleNamespace(_WEIGHTS={lang: {'latin': 1} for lang in ('en', 'ch', 'japan', 'korean')},
                             _script=lambda c: 'latin' if c.isalpha() else 'other')
    calls = []
    def detect(image):
        calls.append({lang: native._ocr_lines(image, lang) for lang in native._WEIGHTS})
        return 'korean'  # Scoring belongs to upstream, not this adapter test.
    native.detect_lang = detect
    result.native = native
    result._score_lock = Lock()
    return result, calls


@pytest.mark.parametrize('text,score', [('', .99), ('!!', .99), ('hello', .49), (' ', .99)])
def test_no_evidence_does_not_default_to_english(text, score):
    instance, calls = router()
    assert instance.choose({lang: {'text': text, 'conf': score} for lang in instance.native._WEIGHTS}) is None
    assert calls == []


def test_floor_then_delegate_scoring_and_release_private_text():
    instance, calls = router()
    values = {lang: {'text': 'word', 'conf': .1} for lang in instance.native._WEIGHTS}
    values['korean']['conf'] = .5
    assert instance.choose(values) == 'korean'
    assert calls == [{'en': [], 'ch': [], 'japan': [], 'korean': [values['korean']]}]
    assert instance.native._ocr_lines is None


def test_native_scoring_failure_releases_private_text_before_next_page(monkeypatch):
    instance, calls = router()
    values = {lang: {'text': 'first page', 'conf': .9} for lang in instance.native._WEIGHTS}
    failure = RuntimeError('Native scoring failed')
    def fail(image):
        assert instance.native._ocr_lines(image, 'en') == [values['en']]
        raise failure
    with monkeypatch.context() as patch:
        patch.setattr(instance.native, 'detect_lang', fail)
        with pytest.raises(RuntimeError) as raised:
            instance.choose(values)
        assert raised.value is failure
        assert instance.native._ocr_lines is None
        assert not instance._score_lock.locked()
    next_values = {lang: {'text': 'next page', 'conf': .8} for lang in instance.native._WEIGHTS}
    assert instance.choose(next_values) == 'korean'
    assert calls == [{lang: [row] for lang, row in next_values.items()}]
    assert instance.native._ocr_lines is None


def test_scoring_hook_isolated_between_concurrent_pages():
    instance, _ = router()
    entered, attempted, release = Event(), Event(), Event()
    lock = instance._score_lock

    def acquire():
        if lock.locked():
            attempted.set()
        lock.acquire()

    instance._score_lock = SimpleNamespace(acquire=acquire, release=lock.release)

    def detect(image):
        before = instance.native._ocr_lines(image, 'en')[0]['text']
        if before == 'first':
            entered.set()
            assert release.wait(5), 'Test did not release the first scorer'
        assert instance.native._ocr_lines(image, 'en')[0]['text'] == before
        return before

    def choose(text):
        values = {lang: {'text': text, 'conf': .9} for lang in instance.native._WEIGHTS}
        with collect() as timings:
            result = instance.choose(values)
        return result, timings

    instance.native.detect_lang = detect
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(choose, 'first')
        try:
            assert entered.wait(5)
            second = pool.submit(choose, 'second')
            assert attempted.wait(5)
            assert not second.done()
            assert instance.native._ocr_lines(None, 'en')[0]['text'] == 'first'
        finally:
            release.set()
        for job, expected in ((first, 'first'), (second, 'second')):
            result, timings = job.result(timeout=5)
            assert result == expected
            assert set(timings) == {'ocr_lock_wait'}
            assert timings['ocr_lock_wait'] >= 0
    assert instance.native._ocr_lines is None
    assert not lock.locked()


def test_every_probe_runs_once_per_page_and_routes_stay_per_paragraph(monkeypatch):
    instance, _ = router()
    calls, shapes = [], []
    crop = np.zeros((12, 24, 3), dtype=np.uint8)
    vertical = np.ones((24, 48, 3), dtype=np.uint8)
    quads = [np.array([[i, 0], [i+width, 0], [i+width, 12], [i, 12]])
             for i, width in ((0, 6), (1, 24), (2, 12), (3, 24))]
    monkeypatch.setitem(sys.modules, 'modules.detection.script_detection', SimpleNamespace(
        _line_area=lambda pts: np.ptp(pts[:, 0]) * np.ptp(pts[:, 1])))
    extracted = []
    def extract(image, points):
        extracted.append(points)
        return {1: crop, 2: vertical, 3: None}[points[0, 0]]
    def probe(language, images):
        calls.append(language)
        shapes.append([image.shape for image in images])
        return [{'text': str(i), 'conf': .9} for i in range(len(images))]
    instance.probes = {lang: SimpleNamespace(probe=lambda images, lang=lang: probe(lang, images))
                       for lang in ('en', 'ch', 'korean')}
    instance.probes['ch'].recognizer = SimpleNamespace(crop=extract)
    instance.choose = lambda predictions: ['ch', 'japan'][int(predictions['ch']['text'])]
    blocks = [SimpleNamespace(lines=quads[:2]), SimpleNamespace(lines=[quads[2]]),
              SimpleNamespace(lines=[quads[3]]), SimpleNamespace(lines=[])]
    groups = [[SimpleNamespace(pts=quad) for quad in block.lines] for block in blocks]
    routes, readings = instance.classify(crop, blocks, groups)
    assert routes == ['ch', 'japan', None, None]
    assert readings == [(1, {'text': '0', 'conf': .9}), None, None, None]
    for actual, expected in zip(extracted, quads[1:], strict=True):
        np.testing.assert_array_equal(actual, expected)
    assert calls == ['en', 'ch', 'korean']
    assert shapes == [[(12, 24, 3), (24, 48, 3)]] * 3  # No second rotation.
    calls.clear()
    assert instance.classify(crop, [], []) == ([], [])
    assert not calls
    assert not hasattr(instance, 'readings')  # No cross-page private text cache.


def test_probe_width_limit_preserves_candidate_alignment(monkeypatch):
    from mtu_engine.ocr import Paddle, Recognizer
    from rapidocr.ch_ppocr_rec import TextRecognizer
    model = Paddle.__new__(Paddle)
    seen = []
    def recognize(self, inputs):
        seen.append(inputs)
        return SimpleNamespace(txts=['valid'], scores=[.9])
    monkeypatch.setattr(TextRecognizer, '__call__', recognize)
    model.recognizer = Recognizer.__new__(Recognizer)
    rows = model.probe([np.zeros((1, 4000, 3), np.uint8), np.zeros((48, 240, 3), np.uint8), None])
    assert rows == [{'text': '', 'conf': 0.}, {'text': 'valid', 'conf': .9}, {'text': '', 'conf': 0.}]
    assert len(seen) == 1


@pytest.mark.parametrize('route,width,reusable', [('en', 320, True), ('korean', 100, True),
                                               ('ch', 321, False), (None, 100, False)])
def test_only_selected_expert_fixed_width_readings_can_be_reused(monkeypatch, route, width, reusable):
    instance, _ = router()
    monkeypatch.setitem(sys.modules, 'modules.detection.script_detection', SimpleNamespace(_line_area=lambda _: 1))
    instance.probes = {lang: SimpleNamespace(probe=lambda _, lang=lang: [{'text': lang, 'conf': .7}])
                       for lang in ('en', 'ch', 'korean')}
    instance.probes['ch'].recognizer = SimpleNamespace(crop=lambda *args: np.zeros((48, width, 3), np.uint8))
    instance.choose = lambda predictions: route
    block = SimpleNamespace(lines=[np.zeros((4, 2))])
    routes, readings = instance.classify(None, [block], [[SimpleNamespace(pts=block.lines[0])]])
    assert routes == [route]
    assert readings == ([(0, {'text': route, 'conf': .7})] if reusable else [None])


def test_probe_uses_formal_quadrilateral_point_order_not_raw_group_points(monkeypatch):
    instance, _ = router()
    monkeypatch.setitem(sys.modules, 'modules.detection.script_detection', SimpleNamespace(_line_area=lambda _: 1))
    raw = np.array([[0, 10], [10, 10], [10, 0], [0, 0]])
    canonical = raw[::-1].copy()
    seen = []
    def crop(image, points):
        seen.append(points)
        return np.zeros((48, 100, 3), np.uint8)
    instance.probes = {lang: SimpleNamespace(probe=lambda _: [{'text': 'text', 'conf': .8}])
                       for lang in ('en', 'ch', 'korean')}
    instance.probes['ch'].recognizer = SimpleNamespace(crop=crop)
    instance.choose = lambda _: 'en'
    instance.classify(None, [SimpleNamespace(lines=[raw])], [[SimpleNamespace(pts=canonical)]])
    assert len(seen) == 1 and seen[0] is canonical
