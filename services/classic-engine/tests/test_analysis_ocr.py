"""Mocked analysis-stage policy tests; no neural model or CUDA execution."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
import sys
from threading import Event, Lock
from types import SimpleNamespace

import numpy as np
import pytest

from mtu_engine.engine import Engine
from classic_node.timing import collect


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
        render=SimpleNamespace(stroke_width=0.1),
        ocr=SimpleNamespace(prob=0.5, min_text_length=1), mask_dilation_offset=0, kernel_size=3)
    engine._detector_lock, engine._bubble_lock = Lock(), Lock()
    engine.detector = SimpleNamespace(detect=detect)
    engine.router = SimpleNamespace(classify=lambda image, blocks, groups: (['en'] * len(blocks), [None] * len(blocks)))
    engine.recognizers = {}
    engine.japanese = SimpleNamespace(recognize=lambda *args: pytest.fail('Unexpected Japanese branch'))
    def colors(image, regions):
        assert image is source and not hasattr(engine, '_ocr_lock')
        assert all(not region.adjust_bg_color and region.default_stroke_width == .1 for region in regions)
        calls.append(('colors', regions))
    engine.colors = SimpleNamespace(apply=colors)
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
    assert regions[0].language == 'en'  # Request-local route for line-aligned color reuse.
    np.testing.assert_array_equal(regions[0].lines, quads)
    assert mask is raw and bubbles.shape == source.shape[:2]
    assert [call[0] for call in calls] == ['colors', 'bubbles', 'refine']


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
    engine.router = SimpleNamespace(classify=lambda image, blocks, groups: (['korean', 'en', 'korean'], [None] * 3))
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
    assert [region.language for region in regions] == ['korean', 'en', 'korean']
    for region, quad in zip(regions, quads):
        np.testing.assert_array_equal(region.lines, [quad])


def test_four_languages_use_selected_experts_without_fallback(analysis, monkeypatch):
    engine, source, quads, calls = analysis
    quads = quads + [quads[0] + [1, 0]]
    blocks = [SimpleNamespace(lines=[quad], font_size=12, angle=0, src_is_vertical=False) for quad in quads]
    monkeypatch.setitem(sys.modules, 'ballontranslator.utils.textblock', SimpleNamespace(group_output=lambda *args: blocks))
    engine.router = SimpleNamespace(classify=lambda *args: (['japan', 'ch', 'en', 'korean'], [None] * 4))
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
    assert [r.language for r in regions] == ['japan', 'ch', 'korean']
    assert [name for name, _ in calls] == ['colors', 'bubbles', 'refine']
    assert [r.text for r in calls[0][1]] == ['japan', 'ch', 'korean']


def test_unknown_language_does_not_call_recognizers_or_erase(analysis):
    engine, source, _, calls = analysis
    engine.router = SimpleNamespace(classify=lambda *args: ([None], [None]))
    engine.recognizers['en'] = SimpleNamespace(recognize=lambda *args: pytest.fail('Unknown is not English'))
    assert engine.analyze(source) == ([], None, None, None)
    assert calls == []


@pytest.mark.parametrize('score,text', [(.9, 'cached'), (.49, ''), (.5, 'cached')])
def test_representative_reuse_skips_only_that_line_and_keeps_order(analysis, score, text):
    engine, source, quads, _ = analysis
    engine.router = SimpleNamespace(classify=lambda *args: (['en'], [(1, {'text': 'cached', 'conf': score})]))
    observed = []
    async def recognize(rgb, lines, config):
        observed.extend(lines)
        for line, value in zip(lines, ['first', 'last'], strict=True):
            line.text, line.prob = value, .9
    engine.recognizers['en'] = SimpleNamespace(recognize=recognize)
    regions, *_ = engine.analyze(source)
    assert len(observed) == 2
    assert regions[0].texts == ['first', text, 'last']
    np.testing.assert_array_equal(regions[0].lines, quads)
    assert not hasattr(engine, 'readings')


def test_single_line_reuse_never_calls_formal_model_and_is_page_local(analysis, monkeypatch):
    engine, source, quads, _ = analysis
    block = SimpleNamespace(lines=[quads[0]], font_size=12, angle=0, src_is_vertical=False)
    monkeypatch.setitem(sys.modules, 'ballontranslator.utils.textblock', SimpleNamespace(group_output=lambda *args: [block]))
    engine.recognizers['ch'] = SimpleNamespace(recognize=lambda *args: pytest.fail('Representative read twice'))
    for text in ('first page', 'second page'):
        engine.router = SimpleNamespace(classify=lambda *args: (['ch'], [(0, {'text': text, 'conf': .8})]))
        regions, *_ = engine.analyze(source)
        assert regions[0].texts == [text]
    engine.router = SimpleNamespace(classify=lambda *args: ([None], [None]))
    assert engine.analyze(source) == ([], None, None, None)


def test_close_does_not_unload_shared_probe_recognizers_twice(analysis):
    engine, _, _, _ = analysis
    closed = []
    engine.probes = {lang: SimpleNamespace(close=lambda lang=lang: closed.append(lang))
                     for lang in ('en', 'ch', 'korean')}
    engine.recognizers = engine.probes
    engine.japanese = SimpleNamespace(close=lambda: closed.append('japan'))
    engine.colors = SimpleNamespace(close=lambda: closed.append('colors'))
    async def unload():
        closed.append('unload')
    engine.detector = engine.inpainter = engine.color_model = SimpleNamespace(unload=unload)
    engine.close()
    assert closed == ['en', 'ch', 'korean', 'japan', 'colors', 'unload', 'unload', 'unload']


def test_analysis_does_not_require_new_center_timing_keys(analysis):
    engine, source, _, _ = analysis
    async def recognize(rgb, lines, config):
        for line in lines:
            line.text = 'recognized'
    engine.recognizers['en'] = SimpleNamespace(recognize=recognize)
    with collect() as values:
        engine.analyze(source)
    assert {'analyze_detect', 'analyze_route', 'analyze_ocr', 'analyze_colors',
            'analyze_bubbles', 'analyze_bubble_mask', 'analyze_refine'} <= values.keys()
    assert all(value >= 0 for value in values.values())


def test_analysis_failure_releases_locks_without_new_timing_keys(analysis):
    engine, source, _, _ = analysis
    async def recognize(*args):
        raise RuntimeError('OCR failed')
    engine.recognizers['en'] = SimpleNamespace(recognize=recognize)
    with collect() as values, pytest.raises(RuntimeError, match='OCR failed'):
        engine.analyze(source)
    assert values['analyze_ocr'] >= 0
    assert not engine._detector_lock.locked() and not engine._bubble_lock.locked()


@pytest.mark.parametrize('held_stage', ['colors', 'japan'])
def test_other_page_ocr_progresses_while_a_different_model_is_busy(analysis, held_stage):
    engine, source, _, _ = analysis
    other = source.copy()
    entered, release, other_read = Event(), Event(), Event()

    def classify(image, blocks, groups):
        language = 'japan' if image is source and held_stage == 'japan' else 'en'
        return [language] * len(blocks), [None] * len(blocks)

    async def recognize(image, lines, config):
        for line in lines:
            line.text, line.prob = ('first' if image is source else 'second'), .9
        if image is other:
            other_read.set()

    def japanese(image, blocks, groups):
        assert image is source
        entered.set()
        assert release.wait(5), 'Test did not release the Japanese model'
        for group in groups:
            for line in group:
                line.text = 'first'

    def colors(image, regions):
        if image is source and held_stage == 'colors':
            entered.set()
            assert release.wait(5), 'Test did not release the color model'

    engine.router = SimpleNamespace(classify=classify)
    engine.recognizers['en'] = SimpleNamespace(recognize=recognize)
    engine.japanese = SimpleNamespace(recognize=japanese)
    engine.colors = SimpleNamespace(apply=colors)
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(engine.analyze, source)
        try:
            assert entered.wait(5)
            second = pool.submit(engine.analyze, other)
            assert other_read.wait(5), 'Unrelated model blocked the second page OCR'
            assert second.result(timeout=5)[0][0].texts == ['second'] * 3
        finally:
            release.set()
        assert first.result(timeout=5)[0][0].texts == ['first'] * 3
