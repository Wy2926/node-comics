"""Adapter tests: input rejection, native scoring and batched paragraph routing."""
from types import SimpleNamespace
import sys

import numpy as np
import pytest

from mtu_engine.routing import ScriptRouter


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


def test_every_probe_runs_once_per_page_and_routes_stay_per_paragraph(monkeypatch):
    instance, _ = router()
    calls, shapes = [], []
    crop = np.zeros((12, 24, 3), dtype=np.uint8)
    monkeypatch.setitem(sys.modules, 'modules.detection.script_detection', SimpleNamespace(
        _largest_line_crop=lambda image, block: (None, 'horizontal') if block.text_bbox[0] == 2 else (crop, block.direction)))
    monkeypatch.setitem(sys.modules, 'modules.utils.textblock', SimpleNamespace(TextBlock=SimpleNamespace))
    def probe(language, images):
        calls.append(language)
        shapes.append([image.shape for image in images])
        return [{'text': str(i), 'conf': .9} for i in range(len(images))]
    instance.probes = {lang: SimpleNamespace(probe=lambda images, lang=lang: probe(lang, images))
                       for lang in ('en', 'ch', 'korean')}
    instance.choose = lambda predictions: ['ch', 'japan'][int(predictions['ch']['text'])]
    blocks = [SimpleNamespace(xyxy=[i, 0, 24, 12], lines=[], src_is_vertical=i == 1) for i in range(3)]
    assert instance.classify(crop, blocks) == ['ch', 'japan', None]
    assert calls == ['en', 'ch', 'korean']
    assert shapes == [[(12, 24, 3), (24, 12, 3)]] * 3
    calls.clear()
    assert instance.classify(crop, []) == []
    assert not calls


def test_probe_width_limit_preserves_candidate_alignment():
    from mtu_engine.ocr import Paddle
    model = Paddle.__new__(Paddle)
    seen = []
    def recognize(inputs):
        seen.append(inputs)
        return SimpleNamespace(txts=['valid'], scores=[.9])
    model.recognizer = recognize
    rows = model.probe([np.zeros((1, 4000, 3), np.uint8), np.zeros((48, 240, 3), np.uint8), None])
    assert rows == [{'text': '', 'conf': 0.}, {'text': 'valid', 'conf': .9}, {'text': '', 'conf': 0.}]
    assert len(seen) == 1
