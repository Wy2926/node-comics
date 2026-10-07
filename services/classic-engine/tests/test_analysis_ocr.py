"""Mocked analysis-stage policy tests; no neural model or CUDA execution."""
from contextlib import nullcontext
import sys
from threading import Lock
from types import SimpleNamespace

import numpy as np
import pytest

from mtu_engine.engine import Engine


@pytest.fixture
def analysis(monkeypatch):
    source = np.full((64, 128, 3), 255, dtype=np.uint8)
    quads = [np.array([[4, y], [120, y], [120, y+12], [4, y+12]]) for y in (4, 24, 44)]
    block = SimpleNamespace(lines=quads, font_size=12, angle=0, src_is_vertical=False)
    calls = []

    def text_block(**kwargs):
        return SimpleNamespace(**kwargs, text=' '.join(kwargs['texts']), source_lang='en')

    async def detect(*args):
        return [SimpleNamespace(pts=quad) for quad in quads], np.ones(source.shape[:2]), None

    async def refine(regions, rgb, raw, **kwargs):
        calls.append(('refine', regions))
        return raw

    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(cuda=SimpleNamespace(device=lambda _: nullcontext())))
    monkeypatch.setitem(sys.modules, 'manga_translator.mask_refinement', SimpleNamespace(dispatch=refine))
    monkeypatch.setitem(sys.modules, 'ballontranslator.utils.textblock',
                        SimpleNamespace(group_output=lambda *args: [block]))
    monkeypatch.setitem(sys.modules, 'manga_translator.utils', SimpleNamespace(
        TextBlock=text_block,
        Quadrilateral=lambda pts, text, prob: SimpleNamespace(pts=pts, text=text, prob=prob),
        build_bubble_mask_from_mangalens_result=lambda detected, shape: np.zeros(shape),
        is_valuable_text=lambda text: any(char.isalpha() for char in text)))
    engine = Engine.__new__(Engine)
    engine.gpu, engine.keep_lang = 0, None
    engine.config = SimpleNamespace(
        detector=SimpleNamespace(detection_size=1280, text_threshold=0.5, box_threshold=0.7, unclip_ratio=2.3),
        ocr=SimpleNamespace(prob=0.5, min_text_length=1), mask_dilation_offset=0, kernel_size=3)
    engine._detector_lock, engine._ocr_lock, engine._bubble_lock = Lock(), Lock(), Lock()
    engine.detector = SimpleNamespace(detect=detect)
    engine.router = SimpleNamespace(classify=lambda image, blocks: ['en'] * len(blocks))
    engine.recognizers = {}
    engine.japanese = SimpleNamespace(recognize=lambda *args: pytest.fail('Unexpected Japanese branch'))
    engine.bubbles = SimpleNamespace(detect=lambda *args, **kwargs: calls.append(('bubbles', None)))
    return engine, source, quads, calls


@pytest.mark.parametrize('texts', [
    ['first line', '', 'last line'], ['', 'middle line', ''],
    ['first line', 'middle line', 'last line'],
])
def test_partial_ocr_retains_recognized_text_order_and_original_geometry(analysis, texts):
    engine, source, quads, calls = analysis

    async def recognize(rgb, lines, config):
        for line, text in zip(lines, texts):
            line.text, line.prob = text, 0.9 if text else 0.1

    engine.recognizers['en'] = SimpleNamespace(recognize=recognize)
    regions, mask, raw, bubbles = engine.analyze(source)
    assert len(regions) == 1
    assert regions[0].texts == texts
    np.testing.assert_array_equal(regions[0].lines, quads)
    assert mask is raw and bubbles.shape == source.shape[:2]
    assert [call[0] for call in calls] == ['bubbles', 'refine']


@pytest.mark.parametrize('texts,keep_lang,min_length', [
    (['', '', ''], None, 1), ([' ', '\t', '\n'], None, 1),
    (['...', '', ''], None, 1), (['hello', '', ''], 'zh', 1),
    (['a', '', ''], None, 2),
])
def test_no_eligible_text_skips_bubbles_and_erasure(analysis, texts, keep_lang, min_length):
    engine, source, _, calls = analysis
    engine.keep_lang = keep_lang
    engine.config.ocr.min_text_length = min_length

    async def recognize(rgb, lines, config):
        for line, text in zip(lines, texts):
            line.text, line.prob = text, 0.1

    engine.recognizers['en'] = SimpleNamespace(recognize=recognize)
    assert engine.analyze(source) == ([], None, None, None)
    assert calls == []


def test_ocr_failure_does_not_reach_erasure(analysis):
    engine, source, _, calls = analysis

    async def recognize(*args):
        raise RuntimeError('OCR failed')

    engine.recognizers['en'] = SimpleNamespace(recognize=recognize)
    with pytest.raises(RuntimeError, match='OCR failed'):
        engine.analyze(source)
    assert calls == []


def test_mixed_page_routes_korean_only_and_preserves_paragraph_order(analysis, monkeypatch):
    engine, source, quads, _ = analysis
    blocks = [SimpleNamespace(lines=[quad], font_size=12, angle=0, src_is_vertical=False)
              for quad in quads]
    monkeypatch.setitem(sys.modules, 'ballontranslator.utils.textblock',
                        SimpleNamespace(group_output=lambda *args: blocks))
    engine.router = SimpleNamespace(classify=lambda image, blocks: ['korean', 'en', 'korean'])
    observed = []

    async def korean(rgb, lines, config):
        observed.append(('ko', len(lines)))
        for line, text in zip(lines, ['첫 번째', '마지막']):
            line.text, line.prob = text, 0.99

    async def other(rgb, lines, config):
        observed.append(('other', len(lines)))
        lines[0].text, lines[0].prob = 'middle', 0.99

    engine.recognizers = {'en': SimpleNamespace(recognize=other), 'korean': SimpleNamespace(recognize=korean)}
    regions, *_ = engine.analyze(source)
    assert observed == [('other', 1), ('ko', 2)]
    assert [region.text for region in regions] == ['첫 번째', 'middle', '마지막']
    for region, quad in zip(regions, quads):
        np.testing.assert_array_equal(region.lines, [quad])


def test_four_languages_use_selected_experts_without_fallback(analysis, monkeypatch):
    engine, source, quads, _ = analysis
    quads = quads + [quads[0] + [1, 0]]
    blocks = [SimpleNamespace(lines=[quad], font_size=12, angle=0, src_is_vertical=False) for quad in quads]
    monkeypatch.setitem(sys.modules, 'ballontranslator.utils.textblock', SimpleNamespace(group_output=lambda *args: blocks))
    engine.router = SimpleNamespace(classify=lambda *args: ['japan', 'ch', 'en', 'korean'])
    observed = []
    def model(language):
        async def recognize(image, lines, config):
            observed.append(language)
            for line in lines:
                line.text = '' if language == 'en' else language
        return SimpleNamespace(recognize=recognize)
    engine.recognizers = {lang: model(lang) for lang in ('en', 'ch', 'korean')}
    def japanese(image, selected, groups):
        observed.append('japan')
        assert selected == [blocks[0]]
        groups[0][0].text = 'japan'
    engine.japanese = SimpleNamespace(recognize=japanese)
    regions, *_ = engine.analyze(source)
    assert observed == ['en', 'ch', 'korean', 'japan']
    assert [r.text for r in regions] == ['japan', 'ch', 'korean']


def test_unknown_language_does_not_call_recognizers_or_erase(analysis):
    engine, source, _, calls = analysis
    engine.router = SimpleNamespace(classify=lambda *args: [None])
    engine.recognizers['en'] = SimpleNamespace(recognize=lambda *args: pytest.fail('Unknown is not English'))
    assert engine.analyze(source) == ([], None, None, None)
    assert calls == []
