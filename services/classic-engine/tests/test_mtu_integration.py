"""Real Qt/GPU acceptance; MTU_TEST_ASSETS opts in, MTU_TEST_BACKEND defaults to CUDA."""
from concurrent.futures import ThreadPoolExecutor
import math
import json
import os
from pathlib import Path
import re
import socket
from threading import Barrier

import numpy as np
import pytest

from classic_node.runtime import LANGUAGE_PROBES
from mtu_engine.engine import Engine, Renderer, serialize_region
from mtu_engine.fonts import DEFAULT_FONT_IDS, FONT_CHOICES
from classic_node.config import ENGINE_DEFAULTS
from mtu_engine.ocr import OCR_IMAGE_SHAPE, OCR_MAX_WIDTH


@pytest.fixture(scope='module')
def assets():
    value = os.environ.get('MTU_TEST_ASSETS')
    if not value:
        pytest.skip('Set MTU_TEST_ASSETS to run real upstream components')
    root = Path(value).resolve()
    from mtu_engine.assets import verify
    verify(root / 'models')
    fonts = json.loads((root / 'licenses/font-sources.json').read_text(encoding='utf-8'))['fonts']
    return root / 'models', [str(root / 'fonts' / item['name']) for item in fonts]


def deny_network(*args, **kwargs):
    raise AssertionError('Prepared image stages must work offline')


@pytest.mark.parametrize('language,text', [('en', 'HELLO'), ('japan', 'こんにちは'),
                                         ('ch', '你好世界'), ('korean', '안녕하세요')])
def test_native_script_scoring_keeps_weak_evidence_for_every_expert(assets, offline, language, text):
    from mtu_engine.routing import ScriptRouter
    router = ScriptRouter(assets[0], {})
    predictions = {lang: {'text': '', 'conf': 0.} for lang in router.native.DETECT_CANDIDATES}
    predictions['en'] = {'text': 'I', 'conf': .6}
    predictions[language] = {'text': text, 'conf': .4}
    if language in ('ch', 'japan'):
        predictions['ch'] = predictions['japan'] = predictions[language]
    assert router.choose(predictions) == language
    assert router.native._ocr_lines is None


def test_native_script_scoring_keeps_clear_latin_over_weak_other_scripts(assets, offline):
    from mtu_engine.routing import ScriptRouter
    router = ScriptRouter(assets[0], {})
    weak = {'text': 'あ', 'conf': .31}
    assert router.choose({'en': {'text': 'HELLO WORLD', 'conf': .95},
                          'ch': weak, 'japan': weak,
                          'korean': {'text': '가', 'conf': .31}}) == 'en'


def test_font_search_prepares_plain_text_once_and_preserves_native_sizes(assets, monkeypatch):
    import inspect
    from mtu_engine.assets import LOCK
    from mtu_engine.engine import configuration
    Renderer(*assets)
    from manga_translator import rendering
    from manga_translator.rendering.text_render import _render
    patch = next(p for p in LOCK['source']['patches']['manga_translator/rendering/__init__.py']
                 if 'def _fits(fs:' in p['before'])
    source = inspect.getsource(rendering.calc_font_from_box)
    assert source.count(patch['after']) == 1
    scope = dict(vars(rendering))
    exec(source.replace(patch['after'], patch['before']), scope)
    native = scope['calc_font_from_box']
    convert, calls = _render.legacy_line_breaks_to_document, []

    def counted(text, *args, **kwargs):
        calls.append(text)
        return convert(text, *args, **kwargs)

    monkeypatch.setattr(_render, 'legacy_line_breaks_to_document', counted)
    monkeypatch.setattr(rendering, 'legacy_line_breaks_to_document', counted)
    for text in ('THIS PERSON[BR]COULD USE MAGIC.', '你好，世界。\n第二行', 'مرحبا بالعالم', 'A'):
        for horizontal in (True, False):
            options = dict(width=230, height=95, text=text, is_horizontal=horizontal,
                           config=configuration(), stroke_width=.1)
            expected = native(**options)
            calls.clear()
            assert rendering.calc_font_from_box(**options) == expected
            assert calls == [text]


def test_style_value_copy_keeps_all_mutable_children_independent(assets):
    import copy
    Renderer(*assets)
    from manga_translator.rendering.rich_text import TextStyle
    style = TextStyle.from_dict({'bold': True, 'italic': 12, 'color': '#123456',
        'stroke': {'color': '#111111', 'width': .1},
        'outerStroke': {'color': '#ffffff', 'width': .2},
        'glow': {'color': '#444444', 'blur': 3}, 'transform': {'rotation': 15, 'scaleX': 2}})
    result = style.copy()
    assert result == copy.deepcopy(style) and result is not style
    for name in ('stroke', 'outer_stroke', 'glow', 'transform'):
        assert getattr(result, name) is not getattr(style, name)
    result.stroke.color = '#aaaaaa'
    result.outer_stroke.width = 1
    result.glow.blur = 9
    result.transform.scale_x = 3
    assert style.stroke.color == '#111111' and style.outer_stroke.width == .2
    assert style.glow.blur == 3 and style.transform.scale_x == 2
    assert TextStyle().copy() == TextStyle()


@pytest.mark.parametrize('shape', [(80, 150), (800, 800), (777, 1103)])
def test_lama_scaling_preserves_thin_masks_and_original_paste_boundary(assets, shape):
    from types import SimpleNamespace
    Renderer(*assets)
    from manga_translator.inpainting.inpainting_lama_mpe import LamaLargeInpainter, resize_keep_aspect
    image = np.full((*shape, 3), 29, np.uint8)
    mask = np.zeros(shape, np.uint8)
    mask[:, shape[1] // 3] = 255
    mask[0, :shape[1] // 2] = 255
    mask[-1, -10:] = 255
    original = mask.copy()
    mask.flags.writeable = False
    owner = SimpleNamespace(logger=SimpleNamespace(info=lambda *args: None))
    prep = LamaLargeInpainter._prepare_large_image(owner, image, mask, 512)
    if max(shape) > 512:
        coverage = resize_keep_aspect(mask.astype(np.float32), 512) > 0
        assert np.all(prep['mask_resized'][:, :, 0][coverage] > 0)
    model_output = np.full(prep['image_pad'].shape, 230, np.uint8)
    result = LamaLargeInpainter._restore_large_output(owner, model_output, prep)
    assert np.all(result[mask > 0] == 230)
    np.testing.assert_array_equal(result[mask == 0], image[mask == 0])
    np.testing.assert_array_equal(mask, original)


def test_inpaint_crop_copy_cleanup_preserves_overlapping_window_order(assets):
    import asyncio
    import inspect
    from mtu_engine.assets import LOCK
    Renderer(*assets)
    from manga_translator.inpainting import ballon_fill
    source = inspect.getsource(ballon_fill.inpaint_regions_per_block)
    for patch in reversed(LOCK['source']['patches']['manga_translator/inpainting/ballon_fill.py']):
        if patch['after'] in source:
            source = source.replace(patch['after'], patch['before'])
    scope = dict(vars(ballon_fill))
    exec(source, scope)
    image = np.random.default_rng(43).integers(0, 256, (70, 90, 3), dtype=np.uint8)
    snapshots, outputs = [], []
    for fn in (scope['inpaint_regions_per_block'], ballon_fill.inpaint_regions_per_block):
        mask = np.zeros(image.shape[:2], np.uint8)
        mask[1:14, 0:12] = 255
        mask[16:29, 14:27] = 255  # Disjoint masks, overlapping enlarged windows.
        mask[-10:, -9:] = 255
        original = image.copy()
        seen = []

        async def repair(crop, local_mask):
            assert not np.shares_memory(crop, image)
            seen.append((crop.copy(), local_mask.copy()))
            crop[:] = (crop.astype(np.uint16) + 13) % 256
            return crop

        result, count = asyncio.run(fn(image, mask, repair))
        assert count == 3 and not np.any(mask)
        np.testing.assert_array_equal(image, original)
        snapshots.append(seen)
        outputs.append(result)
    np.testing.assert_array_equal(*outputs)
    for native, current in zip(*snapshots):
        for a, b in zip(native, current):
            np.testing.assert_array_equal(a, b)


@pytest.mark.parametrize('height,width', [(12930,720), (720,12930), (16000,320), (320,16000)])
def test_native_rearrange_overlap_and_roundtrip(assets, height, width):
    from mtu_engine.assets import activate
    activate(assets[0])
    from manga_translator.utils.generic import (build_det_rearrange_plan,
        det_rearrange_patch_array, det_rearrange_patch_spans, det_unrearrange_patch_maps)
    source = np.zeros((height, width, 3), dtype=np.uint8)
    plan = build_det_rearrange_plan(source, 1280)
    spans = det_rearrange_patch_spans(plan)
    assert spans[0][0] == 0 and spans[-1][1] == max(height, width)
    assert all(left[1] - right[0] >= plan['patch_size'] // 5 for left, right in zip(spans, spans[1:]))
    # Feed coordinate ramps through native packing and feathered stitching,
    # including horizontal transposition and the padded tail of the last batch.
    view = np.broadcast_to(np.arange(plan['h'], dtype=np.float32)[:, None, None],
                           (plan['h'], plan['w'], 1))
    coordinate_image = np.swapaxes(view, 0, 1) if plan['transpose'] else view
    coordinate_plan = build_det_rearrange_plan(coordinate_image, 1280)
    patches = det_rearrange_patch_array(coordinate_plan)
    restored = det_unrearrange_patch_maps(list(patches), coordinate_plan, data_format='hwc')
    np.testing.assert_allclose(restored, coordinate_image, atol=.002, rtol=0)
    assert build_det_rearrange_plan(source[:400,:400],1280) is None


@pytest.fixture
def offline(monkeypatch):
    connect = socket.socket.connect
    def loopback_only(sock, address):
        # Windows asyncio implements its wakeup pipe with a loopback socketpair.
        if isinstance(address, tuple) and address[0] in ('127.0.0.1', '::1'):
            return connect(sock, address)
        return deny_network()
    monkeypatch.setattr(socket.socket, 'connect', loopback_only)
    monkeypatch.setattr(socket, 'create_connection', deny_network)


def test_long_page_cross_seam_lines_are_complete_without_duplicate_ocr(assets, offline, monkeypatch):
    import asyncio
    import torch
    from PIL import Image, ImageDraw, ImageFont
    models, fonts = assets
    Renderer(models, fonts)
    from manga_translator.detection import default
    from manga_translator.utils import ModelWrapper, Quadrilateral
    from manga_translator.utils.generic import build_det_rearrange_plan, det_rearrange_patch_spans
    from ballontranslator.utils.textblock import group_output
    from mtu_engine.engine import configuration
    from mtu_engine.ocr import Paddle
    ModelWrapper._MODEL_DIR = str(models)
    detector = default.DefaultDetector()
    asyncio.run(detector.load('cuda'))
    native = default.det_rearrange_forward
    # This focused regression can run beside an existing service. It retains
    # native tile geometry, inference and merging, but limits GPU batch size.
    monkeypatch.setattr(default, 'det_rearrange_forward',
        lambda image, forward, size, batch, **kw: native(image, forward, size, 1, **kw))
    english = None
    try:
        image = Image.new('RGB', (720, 12930), 'white')
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(str(models.parent / 'fonts/NotoSans-Regular.ttf'), 26)
        sentence = 'TALKING ABOUT MAGIC'
        bounds = draw.textbbox((0, 0), sentence, font=font)
        # Center line 20 on the old 2160px tile edge. The paragraph is longer
        # than the new overlap, so it also exercises whole-page grouping.
        first_y = 2160 - 20 * 40 - (bounds[1] + bounds[3]) // 2
        for index in range(30):
            draw.text((180, first_y + index * 40), sentence, font=font, fill='black')
        rgb = np.array(image)
        config = configuration()
        lines, raw, _ = asyncio.run(detector.detect(rgb, 1280, .5, .7, 2.3))
        torch.cuda.empty_cache()
        blocks = group_output([], [line.pts for line in lines], 720, 12930)
        assert len(lines) == 30 and sum(len(block.lines) for block in blocks) == 30
        english = Paddle(models, 'en', 0, 2, backend=os.environ.get('MTU_TEST_BACKEND', 'cuda'))
        grouped = [Quadrilateral(np.asarray(line), '', 1) for block in blocks for line in block.lines]
        asyncio.run(english.recognize(rgb, grouped, config.ocr))
        assert [line.text for line in grouped] == [sentence] * 30
        seams = [top for top, _ in det_rearrange_patch_spans(build_det_rearrange_plan(rgb, 1280))[1:]]
        assert any(block.xyxy[1] < seam < block.xyxy[3] for block in blocks for seam in seams)
        assert raw.shape == rgb.shape[:2]
    finally:
        if english is not None:
            english.close()
        asyncio.run(detector.unload())
        default.MODEL = None
        torch.cuda.empty_cache()


def test_qt_worker_multilingual_text_and_region_fit_offline(assets, offline, monkeypatch):
    models, fonts = assets
    renderer = Renderer(models, fonts)  # QApplication and fonts belong to main.
    from manga_translator import rendering
    from manga_translator.utils import TextBlock
    block = TextBlock(np.array([[[90, 70], [510, 70], [510, 300], [90, 300]]]),
                      ['source'], font_size=48, default_stroke_width=0.07)
    region = serialize_region(block)
    restored = TextBlock(**region)
    assert restored.stroke_width == block.stroke_width
    source = np.full((400, 600, 3), 255, dtype=np.uint8)
    mask = np.zeros(source.shape[:2], dtype=np.uint8)
    calls = []
    real_dispatch = rendering.dispatch

    async def capture(*args, **kwargs):
        result = await real_dispatch(*args, **kwargs)
        calls.extend(args[1])
        return result

    monkeypatch.setattr(rendering, 'dispatch', capture)
    sentence = 'THIS PERSON COULD WIELD MAGIC TO CONTROL ALL THINGS.'
    word_samples = {'en': sentence, 'ar': 'كان هذا الشخص قادرًا على تسخير السحر للتحكم في كل شيء.',
                    'fr': 'CETTE PERSONNE POUVAIT TOUT CONTRÔLER PAR LA MAGIE.'}
    with ThreadPoolExecutor(2) as workers:
        outputs = []
        for language, probe in LANGUAGE_PROBES.items():
            assert renderer.covers(probe), language
            text = word_samples.get(language, probe)
            output = workers.submit(renderer.render, source, source, [region], [text], language, mask).result()
            changed = np.any(output != source, axis=2)
            assert changed.any(), language
            y, x = np.where(changed)
            # smart_scaling permits a small expansion beyond the source box.
            assert x.min() >= 80 and x.max() <= 520 and y.min() >= 60 and y.max() <= 310, language
            outputs.append(output)
        english = [item for item in calls if item.target_lang == 'ENG'][0]
        assert re.sub(r'\s*\[BR\]\s*', ' ', english.translation).split() == sentence.split()
        from mtu_engine.engine import LANGUAGES
        for language, sentence_text in word_samples.items():
            block = next(item for item in calls if item.target_lang == LANGUAGES[language])
            assert re.sub(r'\s*\[BR\]\s*', ' ', block.translation).split() == sentence_text.split(), language
        repeated = workers.submit(renderer.render, source, source, [region], [sentence], 'en', mask).result()
        assert np.array_equal(repeated, outputs[list(LANGUAGE_PROBES).index('en')])
        empty = workers.submit(renderer.render, source, source, [region], [''], 'en', mask).result()
        assert np.array_equal(empty, source)


@pytest.mark.parametrize('font_id', FONT_CHOICES)
def test_selected_regular_or_light_font_uses_its_physical_face_and_fallback(assets, offline, font_id):
    from PyQt6.QtGui import QRawFont
    renderer = Renderer(*assets)
    from manga_translator.rendering.text_render import _fonts
    filename, languages = FONT_CHOICES[font_id]
    path = renderer.font_by_name[filename]
    sample = 'مرحبًا بالعالم' if languages[0] == 'ar' else LANGUAGE_PROBES[languages[0]]
    expected = QRawFont(path, 48)
    assert expected.isValid() and expected.weight() <= 400
    _fonts.set_font(path)
    _, _, layout, _ = _fonts._create_text_layout(sample, 48)
    runs = layout.glyphRuns()
    assert runs and all(index != 0 for run in runs for index in run.glyphIndexes())
    assert all(run.rawFont().familyName() == expected.familyName() for run in runs)
    assert all(run.rawFont().styleName() == expected.styleName() and run.rawFont().weight() <= 400 for run in runs)
    assert all(run.rawFont().weight() == (300 if font_id.endswith('-light') else 400) for run in runs)
    # A mixed-script name must stay visible even when absent from the chosen face.
    fallback_sample = sample + (' مُحَمَّد' if expected.supportsCharacter(ord('龘')) else ' 龘')
    _, _, mixed, _ = _fonts._create_text_layout(fallback_sample, 48)
    assert all(index != 0 for run in mixed.glyphRuns() for index in run.glyphIndexes())
    assert any(run.rawFont().familyName() != expected.familyName() for run in mixed.glyphRuns())


def test_selected_fonts_cover_all_languages_and_do_not_mix_between_render_threads(assets, offline):
    renderer = Renderer(*assets)
    from manga_translator.utils import TextBlock
    block = TextBlock(np.array([[[70, 60], [530, 60], [530, 260], [70, 260]]]),
                      ['source'], font_size=36, direction='h')
    region = serialize_region(block)
    source = np.full((320, 600, 3), 255, np.uint8)
    choices = [(font_id, language) for font_id, (_, languages) in FONT_CHOICES.items() for language in languages]
    assert set(renderer.font_ids) == set(FONT_CHOICES)

    def draw(choice):
        font_id, language = choice
        return renderer.render(source, source, [region], [LANGUAGE_PROBES[language]], language, None, font_id=font_id)

    expected = [draw(choice) for choice in choices]
    assert all(np.any(result != source) for result in expected)
    with ThreadPoolExecutor(3) as workers:
        actual = list(workers.map(draw, choices * 2))
    for result, reference in zip(actual, expected * 2):
        assert np.array_equal(result, reference)
    assert not np.array_equal(draw(('comic-relief', 'en')), draw(('patrick-hand', 'en')))


def test_unselected_null_and_empty_fonts_render_each_language_default(assets, offline, monkeypatch):
    renderer = Renderer(*assets)
    from manga_translator.utils import TextBlock
    block = TextBlock(np.array([[[70, 60], [530, 60], [530, 260], [70, 260]]]),
                      ['source'], font_size=36, direction='h')
    region = serialize_region(block)
    source = np.full((320, 600, 3), 255, np.uint8)
    selected = []
    render_blocks = renderer._render_blocks

    def capture(original, cleaned, blocks, language, config, *args):
        selected.append((language, config.render.font_family, [block.font_family for block in blocks]))
        return render_blocks(original, cleaned, blocks, language, config, *args)

    monkeypatch.setattr(renderer, '_render_blocks', capture)
    for language, default in DEFAULT_FONT_IDS.items():
        args = (source, source, [region], [LANGUAGE_PROBES[language]], language, None)
        expected = renderer.render(*args, font_id=default)
        assert np.any(expected != source), language
        assert np.array_equal(renderer.render(*args), expected), language
        for font_id in (None, ''):
            assert np.array_equal(renderer.render(*args, font_id=font_id), expected), language
        filename = renderer.font_by_name[FONT_CHOICES[default][0]]
        assert selected[-4:] == [(language, filename, [filename])] * 4


def test_renderer_rejects_unknown_or_uninstalled_default_without_first_font_fallback(assets, offline):
    renderer = Renderer(*assets)
    source = np.full((30, 40, 3), 255, np.uint8)
    args = (source, source, [], [], 'en', None)
    with pytest.raises(ValueError, match='Unsupported translation font'):
        renderer.render(*args, font_id='unknown')
    renderer.font_by_name.pop(FONT_CHOICES[DEFAULT_FONT_IDS['en']][0])
    for font_id in (None, '', DEFAULT_FONT_IDS['en']):
        with pytest.raises(ValueError, match='Translation font is not installed'):
            renderer.render(*args, font_id=font_id)


def test_font_choices_survive_real_render_process_pool(assets, offline):
    from classic_node.render_pool import RenderPool, render_page
    renderer = Renderer(*assets)
    from manga_translator.utils import TextBlock
    source = np.full((240, 420, 3), 255, np.uint8)
    block = TextBlock(np.array([[[40, 40], [380, 40], [380, 200], [40, 200]]]),
                      ['source'], font_size=30, direction='h')
    regions = [serialize_region(block)]
    options = {'alpha': None, 'version': 'font-fixture', 'analysis': {'input_hash': '0' * 64},
               'translated': {'analysis_hash': '1' * 64, 'revision': '2' * 64}}
    choices = [('en', 'comic-relief'), ('en', 'patrick-hand'), ('en', None), ('en', ''),
               ('zh-Hans', 'lxgw-wenkai-light'), ('zh-Hans', 'lxgw-wenkai'),
               ('zh-Hans', 'noto-sans-cjk-light'), ('zh-Hans', 'noto-sans-cjk'),
               ('ko', 'gaegu'), ('ar', 'noto-naskh-arabic'), ('ar', ''), ('ja', None)]
    expected = [render_page(renderer, source, source, regions, [LANGUAGE_PROBES[language]], language, None,
                            font_id=font_id, **options) for language, font_id in choices]
    pool = RenderPool(*assets, workers=2, threads=1)
    try:
        pool.warmup()

        def draw(choice):
            language, font_id = choice
            return pool.render(source, source, regions, [LANGUAGE_PROBES[language]], language, None,
                               font_id=font_id, **options)

        with ThreadPoolExecutor(3) as workers:
            assert list(workers.map(draw, choices * 2)) == expected * 2
    finally:
        pool.close()


def private_layout_cases():
    manifest = os.environ.get('MTU_TEST_LAYOUT_CASES')
    if not manifest:
        return [pytest.param(None, id='private-pages-disabled')]
    path = Path(manifest).resolve()
    return [pytest.param((path.parent, row), id=Path(row['image']).stem)
            for row in json.loads(path.read_text(encoding='utf-8'))]


@pytest.mark.parametrize('case', private_layout_cases())
def test_private_page_refinement_preserves_detected_text(assets, case):
    if case is None:
        pytest.skip('Set MTU_TEST_LAYOUT_CASES to a private page manifest')
    import asyncio
    import cv2
    from PIL import Image
    from classic_node.runtime import decode_mask
    from mtu_engine.engine import configuration
    Renderer(*assets)
    from manga_translator.mask_refinement import dispatch, _build_line_protect_mask
    from manga_translator.utils import TextBlock
    root, row = case
    original = np.asarray(Image.open(root / row['image']).convert('RGB'))
    analysis = json.loads((root / row['analysis']).read_text(encoding='utf-8'))
    raw, bubbles = [decode_mask(analysis, key, original.shape[1::-1]) for key in ('raw_mask', 'bubble_mask')]
    blocks = [TextBlock(**r) for r in analysis['regions']]
    config = configuration()
    mask = asyncio.run(dispatch(blocks, original, raw, bubble_mask=bubbles,
        dilation_offset=config.mask_dilation_offset, kernel_size=config.kernel_size,
        limit_mask_dilation_to_bubble_mask=True))
    support = cv2.dilate(cv2.compare(raw, 0, cv2.CMP_GT), None, iterations=2)
    selected = _build_line_protect_mask(blocks, original.shape[:2], expand_px=2 + config.kernel_size // 2)
    assert np.all(mask[(support > 0) & (selected > 0)] == 255)
    assert not np.shares_memory(mask, raw) and not np.shares_memory(mask, bubbles)
    # A fresh production checkpoint must use exactly the tested repair mask.
    np.testing.assert_array_equal(mask, decode_mask(analysis, 'mask', original.shape[1::-1]))


@pytest.mark.parametrize('case', private_layout_cases())
@pytest.mark.parametrize('language', ['zh-Hans', 'en'])
@pytest.mark.parametrize('cache_bytes', [0, None])
def test_private_page_layout_replays_fixed_checkpoints(bubble_layout, case, language, cache_bytes):
    """Opt-in private pages: real Qt, unchanged GPU checkpoint and fixed text."""
    if case is None:
        pytest.skip('Set MTU_TEST_LAYOUT_CASES to a private page manifest')
    import hashlib
    import cv2
    from PIL import Image
    from classic_node.runtime import decode_mask
    from manga_translator.utils import build_region_reference_mask, erode_bubble_mask
    root, row = case
    if row.get('language', language) != language:
        pytest.skip('Private fixture supplies another target language')
    source_path = root / row['image']
    analysis = json.loads((root / row['analysis']).read_text(encoding='utf-8'))
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == analysis['input_hash']
    original = np.asarray(Image.open(source_path).convert('RGB'))
    cleaned = np.asarray(Image.open(root / row['cleaned']).convert('RGB'))
    repair_mask = decode_mask(analysis, 'mask', original.shape[1::-1])
    np.testing.assert_array_equal(cleaned[repair_mask == 0], original[repair_mask == 0])
    # Optional clean-only ROIs catch old glyphs before the new text can hide them.
    # Keep private pixels/coordinates outside the repository; textured ROIs can
    # specify their own background tolerance instead of requiring blanket white.
    for check in row.get('clean_checks', []):
        x1, y1, x2, y2 = check['bbox']
        dark = np.max(cleaned[y1:y2, x1:x2], axis=2) < check.get('dark_below', 160)
        assert np.count_nonzero(dark) <= check['max_dark_pixels'], check['bbox']
    translated = json.loads((root / row['translations']).read_text(encoding='utf-8'))[source_path.name]
    texts = [translated[s['id']] if language == row.get('language', 'zh-Hans') else s['source']
             for s in analysis['segments']]
    inset = erode_bubble_mask(decode_mask(analysis, 'bubble_mask', original.shape[1::-1]), .02)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(inset, connectivity=8)
    renderer, observed, native = bubble_layout
    result = renderer.render(original, cleaned, analysis['regions'], texts, language, inset,
        bubble_prepared=True, bubble_components=(labels, stats), mask_cache_bytes=cache_bytes)
    assert result.shape == original.shape and np.any(result != cleaned)
    assert len(observed) == len(texts)
    expected = {tuple(np.asarray(region['lines']).ravel()): text
                for region, text in zip(analysis['regions'], texts, strict=True)}
    allowed = inset.copy()
    height, width = original.shape[:2]
    for index, block in enumerate(observed):
        text = expected[tuple(block.lines.ravel())]  # Source geometry must not be rewritten.
        actual = re.sub(r'\s*\[BR\]\s*', ' ' if language == 'en' else '', block.translation)
        # Normal words stay intact. A narrow-caption recovery may introduce
        # line-end hyphens; joining those must restore the original words.
        joined = re.sub(r'-\[BR\]', '', block.translation).replace('[BR]', ' ')
        expected_tokens = re.findall(r'\w+|[^\w\s]', text)
        assert (re.findall(r'\w+|[^\w\s]', actual) == expected_tokens or
                (language == 'en' and re.findall(r'\w+|[^\w\s]', joined) == expected_tokens))
        assert block.font_size > 0
        points = block.dst_points.reshape(-1, 2)
        assert (points >= (1, 1)).all() and (points <= (width - 1, height - 1)).all()
        if block.bubble_enclosed:
            reference = build_region_reference_mask(block, inset, labels)
            assert native._polygon_fully_inside_mask(points, reference)
        else:
            cv2.fillPoly(allowed, [np.rint(points).astype(np.int32)], 255)
        for neighbor in observed[index+1:]:
            assert not native._polygons_overlap(points, neighbor.dst_points)
    assert not np.any(np.any(result != cleaned, axis=2) & (allowed == 0))


@pytest.mark.parametrize(('language', 'text'), [
    ('en', 'THIS PERSON COULD WIELD MAGIC TO CONTROL ALL THINGS.'),
    ('zh-Hans', '这个人能够运用魔法，控制世间的一切事物。'),
    ('zh-Hant', '這個人能夠運用魔法，控制世間的一切事物。'),
    ('ja', 'この人は魔法を使って、すべてのものを操ることができた。'),
    ('ko', '이 사람은 마법을 사용하여 모든 것을 제어할 수 있었습니다.'),
    ('ar', 'كان هذا الشخص قادرًا على تسخير السحر للتحكم في كل شيء.'),
    ('fr', 'CETTE PERSONNE POUVAIT TOUT CONTRÔLER PAR LA MAGIE.'),
    ('es', 'ESTA PERSONA PODÍA CONTROLAR TODO CON MAGIA.'),
    ('pt-BR', 'ESTA PESSOA PODIA CONTROLAR TODAS AS COISAS COM MAGIA.'),
    ('de', 'DIESE PERSON KONNTE MIT MAGIE ALLES KONTROLLIEREN.'),
    ('it', 'QUESTA PERSONA POTEVA CONTROLLARE TUTTO CON LA MAGIA.'),
    ('ru', 'Этот человек мог управлять всем с помощью магии.'),
    ('pl', 'Ta osoba mogła kontrolować wszystko za pomocą magii.'),
    ('uk', 'Ця людина могла керувати всім за допомогою магії.'),
    ('tr', 'Bu kişi sihir kullanarak her şeyi kontrol edebilirdi.'),
    ('vi', 'Người này có thể dùng phép thuật để điều khiển mọi thứ.'),
    ('id', 'Orang ini bisa mengendalikan segalanya dengan sihir.'),
])
def test_qt_mask_optimization_preserves_pixels_and_layout(assets, offline, monkeypatch, language, text):
    import cv2
    from mtu_engine.assets import LOCK
    models, fonts = assets
    renderer = Renderer(models, fonts)
    from manga_translator import rendering
    from manga_translator.utils import TextBlock
    from manga_translator.utils.bubble import _reference_masks
    source = np.full((1800, 720, 3), 240, dtype=np.uint8)
    mask = np.zeros(source.shape[:2], dtype=np.uint8)
    regions = []
    for top in (90, 650, 1200):
        mask[top:top + 450, 80:650] = 255
        block = TextBlock([[[260, top + 70], [430, top + 70], [430, top + 370], [260, top + 370]]],
                          ['source'], font_size=48, direction='v')
        regions.append(serialize_region(block))
    dispatch, observed = rendering.dispatch, []
    async def capture(*args, **kwargs):
        output = await dispatch(*args, **kwargs)
        observed.extend((block.translation, block.font_size, block.dst_points.tolist()) for block in args[1])
        return output
    monkeypatch.setattr(rendering, 'dispatch', capture)
    optimized = rendering._polygon_fully_inside_mask
    optimized_rectangle = rendering.find_largest_inscribed_rect
    namespace = {'np': np, 'cv2': cv2}
    patches = LOCK['source']['patches']['manga_translator/rendering/__init__.py']
    exec(patches[0]['before'], namespace)
    rectangle = next(p for p in patches if p['before'].startswith('def find_largest_inscribed_rect('))
    exec(rectangle['before'], namespace)
    monkeypatch.setattr(rendering, '_polygon_fully_inside_mask', namespace['_polygon_fully_inside_mask'])
    monkeypatch.setattr(rendering, 'find_largest_inscribed_rect', namespace['find_largest_inscribed_rect'])
    baseline = renderer.render(source, source, regions, [text] * 3, language, mask, mask_cache_bytes=0)
    layout = observed.copy()
    observed.clear()
    monkeypatch.setattr(rendering, '_polygon_fully_inside_mask', optimized)
    monkeypatch.setattr(rendering, 'find_largest_inscribed_rect', optimized_rectangle)
    candidate = renderer.render(source, source, regions, [text] * 3, language, mask)
    assert np.array_equal(baseline, candidate)
    assert observed == layout
    assert _reference_masks.get() is None


@pytest.mark.parametrize('enclosed', [False, True])
@pytest.mark.parametrize('matching_background', [False, True])
@pytest.mark.parametrize('adjust', [False, True, None])
@pytest.mark.parametrize('fg,bg,stroke', [
    ([0, 0, 0], [10, 10, 10], [255, 255, 255]),
    ([255, 255, 255], [240, 240, 240], [0, 0, 0]),
    ([235, 35, 60], [80, 80, 80], [0, 0, 0]),
    ([245, 245, 245], [20, 40, 130], [20, 40, 130]),
    ([210, 40, 60], [205, 38, 58], [255, 255, 255]),
    ([0, 0, 0], [90, 90, 90], [90, 90, 90]),
])
def test_qt_guards_stroke_contrast_after_checkpoint_restore(
        assets, offline, enclosed, matching_background, adjust, fg, bg, stroke):
    models, fonts = assets
    renderer = Renderer(models, fonts)
    from manga_translator.utils import TextBlock
    block = TextBlock([[[100, 80], [500, 80], [500, 210], [100, 210]]], ['source'],
        font_size=48, fg_color=fg, bg_color=bg, default_stroke_width=.1, adjust_bg_color=False)
    data = json.loads(json.dumps(serialize_region(block)))
    if adjust is None:
        data.pop('adjust_bg_color')
    else:
        data['adjust_bg_color'] = adjust
    # Also match the page to the fill: only the outline keeps text visible.
    cleaned = np.full((300, 600, 3), fg if matching_background else [240, 220, 190], dtype=np.uint8)
    bubble = np.zeros(cleaned.shape[:2], dtype=np.uint8)
    if enclosed:
        bubble[30:260, 40:560] = 255
    result = renderer.render(cleaned, cleaned, [data], ['COLOR TEST'], 'en', bubble)
    assert np.count_nonzero(np.all(result == fg, axis=2)) > 20
    assert np.count_nonzero(np.all(result == stroke, axis=2)) > 20
    assert data['fg_color'] == fg and data['bg_color'] == bg
    assert data.get('adjust_bg_color') is adjust  # Do not mutate saved checkpoints.


def test_legacy_checkpoint_retains_black_white_without_color_inference(assets, offline):
    models, fonts = assets
    renderer = Renderer(models, fonts)
    from manga_translator.utils import TextBlock
    block = TextBlock([[[100, 80], [500, 80], [500, 210], [100, 210]]], ['source'], font_size=48)
    data = serialize_region(block)
    data.pop('adjust_bg_color')
    cleaned = np.full((300, 600, 3), 220, dtype=np.uint8)
    result = renderer.render(cleaned, cleaned, [data], ['LEGACY TEST'], 'en', None)
    assert np.count_nonzero(np.all(result == [0, 0, 0], axis=2)) > 20
    assert np.count_nonzero(np.all(result == [255, 255, 255], axis=2)) > 20


def test_native_representative_color_is_not_divided_by_original_line_count(assets):
    from mtu_engine.assets import activate
    models, _ = assets
    activate(models)
    from manga_translator.utils import TextBlock
    from mtu_engine.colors import Colors
    from types import SimpleNamespace
    predictor = SimpleNamespace(_get_rotate_crop_image=lambda *args: np.full((48, 100, 3), (180, 30, 40), dtype=np.uint8),
        _estimate_colors_batch=lambda crops: [(220, 40, 60, 120, 120, 120)] * len(crops))
    colors = Colors.__new__(Colors)
    colors.batch_size = ENGINE_DEFAULTS['color_batch_size']
    colors.predictor = predictor
    block = TextBlock([[[0, 0], [100, 0], [100, 48], [0, 48]]] * 2, ['first', 'second'],
                      adjust_bg_color=False)
    colors.apply(None, [block])
    assert block.get_font_colors() == ((220., 40., 60.), (120., 120., 120.))
    assert block.texts == ['first', 'second']


@pytest.mark.parametrize('style,skip', [('plain', True), ('colored', False), ('reversed', True),
    ('gray', True), ('gray_background', True), ('faint_tint', True), ('small_color', False)])
def test_native_monochrome_color_gate_without_bubble(assets, style, skip):
    from PIL import Image, ImageDraw, ImageFont
    from types import SimpleNamespace
    from mtu_engine.assets import activate
    from mtu_engine.colors import Colors
    from classic_node.timing import collect
    models, _ = assets
    activate(models)
    from manga_translator.utils import TextBlock
    from manga_translator.ocr.model_paddleocr import ModelPaddleOCR
    background = {'reversed': 'black', 'gray_background': (160, 160, 160),
                  'faint_tint': (250, 248, 249)}.get(style, 'white')
    image = Image.new('RGB', (500, 140), background)
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(models.parent / 'fonts/NotoSans-Regular.ttf'), 48)
    fill = {'colored': (200, 20, 40), 'reversed': 'white', 'gray': (120, 120, 120)}.get(style, 'black')
    draw.text((35, 30), 'PLAIN TEXT', font=font, fill=fill)
    x1, y1, x2, y2 = draw.textbbox((35, 30), 'PLAIN TEXT', font=font)
    block = TextBlock([[[x1-4, y1-4], [x2+4, y1-4], [x2+4, y2+4], [x1-4, y2+4]]],
                      ['PLAIN TEXT'], language='en', adjust_bg_color=False)
    if style == 'small_color':
        draw.rectangle((x1+1, y1-3, x1+12, y1-2), fill=(240, 0, 0))
    calls = []
    def predict(crops):
        calls.append(len(crops))
        return [(90, 60, 30, 200, 210, 220)] * len(crops)
    colors = Colors.__new__(Colors)
    colors.batch_size = ENGINE_DEFAULTS['color_batch_size']
    colors._characters = {}
    colors.predictor = SimpleNamespace(_get_rotate_crop_image=ModelPaddleOCR()._get_rotate_crop_image,
                                      _estimate_colors_batch=predict)
    with collect() as metrics:
        colors.apply(np.array(image), [block])
    assert metrics['color_fast_regions'] == int(skip)
    assert calls == ([] if skip else [1])
    assert block.get_font_colors() == (((0., 0., 0.), (255., 255., 255.)) if skip else
                                      ((90., 60., 30.), (200., 210., 220.)))
    assert block.texts == ['PLAIN TEXT'] and len(block.lines) == 1


def test_native_48px_colors_reuse_ocr_and_keep_failure_fallback_offline(assets, offline, monkeypatch):
    import asyncio
    import torch
    from PIL import Image, ImageDraw, ImageFont
    from mtu_engine.colors import Colors
    from test_color_text_inference import _incremental_colors
    models, fonts = assets
    Renderer(models, fonts)
    from manga_translator.utils import ModelWrapper, TextBlock
    from manga_translator.ocr.model_48px import Model48pxOCR
    ModelWrapper._MODEL_DIR = str(models)
    native = Model48pxOCR()
    assert native.is_downloaded()
    # This component probe can run on CPU; Engine still requires CUDA.
    asyncio.run(native.load('cuda' if torch.cuda.is_available() else 'cpu'))
    colors = Colors(native)
    try:
        image = Image.new('RGB', (700, 160), (240, 220, 190))
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(str(models.parent / 'fonts/NotoSans-Regular.ttf'), 48)
        draw.text((95, 45), 'COLOR TEST', font=font, fill=(235, 35, 60),
                  stroke_width=4, stroke_fill=(80, 80, 80))
        x1, y1, x2, y2 = draw.textbbox((95, 45), 'COLOR TEST', font=font, stroke_width=4)
        block = TextBlock([[[x1-3, y1-3], [x2+3, y1-3], [x2+3, y2+3], [x1-3, y2+3]]],
                          ['COLOR TEST'], language='en', adjust_bg_color=False)
        def failed(*args, **kwargs):
            raise RuntimeError('Injected color prediction failure')
        parallel = colors.predictor.color_model._forced_colors
        compared = []

        def compare(image, widths, tokens):
            actual = parallel(image, widths, tokens)
            expected = _incremental_colors(native.model, image, widths, tokens)
            compared.append((actual, expected))
            return actual

        with monkeypatch.context() as guarded:
            guarded.setattr(native.model, 'infer_beam_batch_tensor', failed)
            guarded.setattr(native.model.pred, 'forward', failed)
            guarded.setattr(native.model.pred1, 'forward', failed)
            guarded.setattr(native.model.decoders, 'forward', failed)
            guarded.setattr(colors.predictor.color_model, '_forced_colors', compare)
            colors.apply(np.array(image), [block])
        assert len(compared) == 1
        for actual, expected in zip(*compared[0], strict=True):
            assert actual[:2] == expected[:2]
            for index, (head, reference) in enumerate(zip(actual[2:], expected[2:], strict=True)):
                torch.testing.assert_close(head.cpu(), reference, atol=2e-5, rtol=2e-5)
                if index >= 2:
                    assert torch.equal(head.cpu().argmax(-1), reference.argmax(-1))
        fg, bg = block.get_font_colors()
        np.testing.assert_allclose(fg, [235, 35, 60], atol=35, rtol=0)
        np.testing.assert_allclose(bg, [80, 80, 80], atol=35, rtol=0)
        assert block.texts == ['COLOR TEST']
        monkeypatch.setattr(native.model.color_pred1, 'forward', failed)
        colors.apply(np.array(image), [block])
        assert block.get_font_colors() == ((0., 0., 0.), (255., 255., 255.))
        assert block.texts == ['COLOR TEST']
    finally:
        colors.close()
        asyncio.run(native.unload())


def test_cuda_models_warmup_and_local_inpaint_offline(assets, offline, monkeypatch):
    models, fonts = assets
    backend = os.environ.get('MTU_TEST_BACKEND', 'cuda')
    engine = Engine(models, fonts, backend=backend)
    try:
        color_batches = []
        estimate_colors = engine.colors.predictor._estimate_colors_batch
        def predict(crops):
            color_batches.append(len(crops))
            return estimate_colors(crops)
        monkeypatch.setattr(engine.colors.predictor, '_estimate_colors_batch', predict)
        engine.warmup()
        assert color_batches == [2]  # Both known-text and fallback models were warmed.
        for probe in engine.probes.values():
            provider = 'DmlExecutionProvider' if backend == 'amd' else 'CUDAExecutionProvider'
            assert probe.session.get_providers()[0] == provider
            if backend == 'cuda':
                assert int(probe.session.get_provider_options()[provider]['device_id']) == engine.gpu
            assert probe.session.get_session_options().intra_op_num_threads == 2
        assert engine.recognizers is engine.probes
        assert len({id(probe.session) for probe in engine.probes.values()}) == 3
        assert engine.japanese.model.model.device.type == 'cuda'
        assert engine.color_model.use_gpu
        assert next(engine.color_model.model.parameters()).device.type == 'cuda'
        assert engine.colors.predictor.color_model.model is engine.color_model.model
        import asyncio
        from types import SimpleNamespace
        from PIL import Image, ImageDraw, ImageFont
        from manga_translator.utils import Quadrilateral
        font = ImageFont.truetype(str(models.parent / 'fonts/NotoSansCJKsc-Regular.otf'), 36)
        for language, text in [('en', 'WHERE ARE YOU GOING?'), ('japan', '明日はきっと晴れる。'),
                               ('ch', '曾經有一名偉大的魔術師'), ('korean', '오늘은 날씨가 좋습니다')]:
            image = Image.new('RGB', (600, 100), 'white')
            draw = ImageDraw.Draw(image)
            draw.text((12, 8), text, font=font, fill='black')
            x1, y1, x2, y2 = draw.textbbox((12, 8), text, font=font)
            quad = np.array([[x1-3,y1-3],[x2+3,y1-3],[x2+3,y2+3],[x1-3,y2+3]])
            block = SimpleNamespace(xyxy=[x1-3,y1-3,x2+3,y2+3], lines=[quad], src_is_vertical=False)
            line = Quadrilateral(quad, '', 1)
            routes, _ = engine.router.classify(np.array(image), [block], [[line]])
            assert routes == [language]
            if language == 'japan':
                engine.japanese.recognize(np.array(image), [block], [[line]])
            else:
                asyncio.run(engine.recognizers[language].recognize(np.array(image), [line], engine.config.ocr))
            assert ''.join(line.text.split()) == ''.join(text.split())
        # Exercise the real detector at the page boundary and cross the old
        # 16+remainder boundary with native bounded OCR batches and tail batches.
        shapes = []
        infer = engine.probes['en'].session.run
        def capture(outputs, feed, *args, **kwargs):
            shapes.append(next(iter(feed.values())).shape)
            return infer(outputs, feed, *args, **kwargs)
        monkeypatch.setattr(engine.probes['en'].session, 'run', capture)
        edge_font = ImageFont.truetype(str(models.parent / 'fonts/NotoSans-Regular.ttf'), 26)
        sentence = 'BUT UNLIKE ME'
        edge_inputs = []
        edge_regions = {}
        for count in (17, 4):
            image = Image.new('RGB', (720, 1203), 'white')
            draw = ImageDraw.Draw(image)
            bounds = draw.textbbox((0, 0), sentence, font=edge_font)
            bottom_y = image.height - 1 - bounds[3]
            for index in range(count):
                draw.text((96, bottom_y - (count - 1 - index) * 44), sentence, font=edge_font, fill='black')
            regions, mask, _, _ = engine.analyze(np.array(image))
            recognized = ' '.join(region.text for region in regions)
            assert recognized.count(sentence) == count
            assert mask is not None and mask[-8:].any()
            edge_inputs.append((np.array(image), count))
            edge_regions[count] = [serialize_region(region) for region in regions]
        assert sum(shape[0] for shape in shapes) >= 21  # Includes representative-line probes.
        assert all(1 <= shape[0] <= ENGINE_DEFAULTS['ocr_batch_size'] and shape[1:3] == OCR_IMAGE_SHAPE[:2] and
                   OCR_IMAGE_SHAPE[2] <= shape[3] <= OCR_MAX_WIDTH for shape in shapes)
        # Pair analyses at the same start gate and compare full checkpoint
        # regions, including line order and colors, against serial inference.
        gate = Barrier(2)
        def analyze_pair(image):
            gate.wait(timeout=30)
            return engine.analyze(image)
        with ThreadPoolExecutor(2) as workers:
            paired = [(count, workers.submit(analyze_pair, image)) for image, count in edge_inputs]
            for count, job in paired:
                regions, *_ = job.result()
                assert [serialize_region(region) for region in regions] == edge_regions[count]
        source = np.full((256, 256, 3), 220, dtype=np.uint8)
        source[110:135, 110:135] = 0
        mask = np.zeros(source.shape[:2], dtype=np.uint8)
        mask[100:145, 100:145] = 255
        cleaned = engine.inpaint(source, mask, mask, np.zeros_like(mask), [])
        assert cleaned.shape == source.shape and cleaned.dtype == np.uint8
        assert np.array_equal(cleaned[mask == 0], source[mask == 0])
        assert np.any(cleaned[mask != 0] != source[mask != 0])
        # Mix different pages and real inpainting on the node's two compute
        # workers. This catches shared upstream state crossing page boundaries.
        with ThreadPoolExecutor(2) as workers:
            jobs = []
            for image, count in edge_inputs * 2:
                jobs.append((count, workers.submit(engine.analyze, image)))
                jobs.append((None, workers.submit(engine.inpaint, source, mask, mask, np.zeros_like(mask), [])))
            for count, job in jobs:
                output = job.result()
                if count is None:
                    assert np.array_equal(output[mask == 0], source[mask == 0])
                    assert np.abs(output.astype(np.int16) - cleaned.astype(np.int16)).max() <= 1
                else:
                    regions, edge_mask, _, _ = output
                    assert ' '.join(region.text for region in regions).count(sentence) == count
                    assert [serialize_region(region) for region in regions] == edge_regions[count]
                    assert edge_mask is not None and edge_mask[-8:].any()
        assert all(1 <= shape[0] <= ENGINE_DEFAULTS['ocr_batch_size'] and shape[1:3] == OCR_IMAGE_SHAPE[:2] and
                   OCR_IMAGE_SHAPE[2] <= shape[3] <= OCR_MAX_WIDTH for shape in shapes)
    finally:
        engine.close()


def test_missing_cuda_fails_before_loading_an_alternate_backend(monkeypatch):
    import torch
    monkeypatch.setattr(torch.version, 'hip', None)
    monkeypatch.setattr(torch.cuda, 'is_available', lambda: False)
    with pytest.raises(RuntimeError, match='CPU fallback is disabled'):
        Engine('missing', [])


def test_long_lines_and_partial_ocr_continue_at_different_positions(assets, offline, monkeypatch):
    from PIL import Image, ImageDraw, ImageFont
    models, fonts = assets
    engine = Engine(models, fonts, backend=os.environ.get('MTU_TEST_BACKEND', 'cuda'))
    sentences = ['We read a new story together at the library.',
                 'The evening sky was full of distant stars.',
                 'Our next adventure begins early tomorrow.']
    font = ImageFont.truetype(str(models.parent / 'fonts/NotoSans-Regular.ttf'), 24)
    recognize = engine.recognizers['en'].recognize
    classify = engine.router.classify
    failure = None

    def rejected(text):
        return failure == 'all-empty' or (failure and 'evening' in text)

    def incomplete_readings(*args):
        routes, readings = classify(*args)
        for index, reading in enumerate(readings):
            if reading is not None and rejected(reading[1]['text']):
                readings[index] = (reading[0], {'text': '', 'conf': 0.})
        return routes, readings

    async def incomplete(*args, **kwargs):
        result = await recognize(*args, **kwargs)
        for line in args[1]:
            if rejected(line.text):
                # The OCR adapter already drops text below its line threshold.
                line.text = ''
                line.prob = 0.1 if failure == 'low-confidence' else 0.0
        return result

    monkeypatch.setattr(engine.recognizers['en'], 'recognize', incomplete)
    monkeypatch.setattr(engine.router, 'classify', incomplete_readings)
    try:
        engine.warmup()
        for top in (32, 440, 900):
            image = Image.new('RGB', (800, 1200), 'white')
            draw = ImageDraw.Draw(image)
            for index, sentence in enumerate(sentences):
                draw.text((70, top + index * 31), sentence, font=font, fill='black')
            draw.text((70, 1100 if top < 900 else 200), 'STILL READABLE', font=font, fill='black')
            rgb = np.array(image)
            failure = None
            regions, mask, _, _ = engine.analyze(rgb)
            recognized = ' '.join(region.text for region in regions)
            for sentence in sentences:
                assert sentence.rstrip('.') in recognized
            assert mask[top:top + 135].any()
            for failure in ('empty', 'low-confidence'):
                regions, mask, raw, bubbles = engine.analyze(rgb)
                recognized = ' '.join(region.text for region in regions)
                assert sentences[0].rstrip('.') in recognized
                assert sentences[2].rstrip('.') in recognized
                assert 'evening' not in recognized
                assert 'STILL READABLE' in recognized
                assert mask[top:top + 135].any()
                cleaned = engine.inpaint(rgb, mask, raw, bubbles,
                                         [serialize_region(region) for region in regions])
                # Native LaMa resizes large local masks before blending; their
                # resampled edge is not pixel-identical to the analysis mask.
                assert cleaned.shape == rgb.shape and cleaned.dtype == np.uint8
                assert np.any(cleaned != rgb)
            failure = 'all-empty'
            assert engine.analyze(rgb) == ([], None, None, None)
    finally:
        engine.close()


@pytest.mark.parametrize(('filename', 'family'), [
    ('NotoNaskhArabic-Regular.ttf', 'Noto Naskh Arabic'),
    ('NotoSansArabic.ttf', 'Noto Sans Arabic'),
])
def test_arabic_native_shaping_bidi_and_diacritics_offline(assets, offline, filename, family):
    models, fonts = assets
    renderer = Renderer(models, fonts)
    from manga_translator.rendering.text_render import _fonts
    _fonts.set_font(renderer.font_by_name[filename])
    # Contextual Arabic forms must differ from isolated cmap glyphs. Some Noto
    # versions compose lam-alef from two joining glyphs rather than one ligature.
    _, _, layout, _ = _fonts._create_text_layout('سلام', 48)
    runs = layout.glyphRuns()
    assert len(runs) == 1 and runs[0].isRightToLeft()
    assert runs[0].rawFont().familyName() == family
    assert runs[0].glyphIndexes() != runs[0].rawFont().glyphIndexesForString('سلام')
    positions = [point.x() for point in runs[0].positions()]
    assert positions == sorted(positions, reverse=True)
    text = 'مُحَمَّد: لا لأ لإ لآ، عام 200 AMIRA (٢٠٠)؟…'
    assert renderer.covers(text)
    _, _, mixed, _ = _fonts._create_text_layout(text, 48)
    runs = mixed.glyphRuns()
    assert any(run.isRightToLeft() for run in runs)
    assert any(not run.isRightToLeft() for run in runs)
    assert all(index != 0 for run in runs for index in run.glyphIndexes())


@pytest.mark.parametrize(('language', 'text'), [
    ('en', 'THIS PERSON COULD WIELD MAGIC TO CONTROL ALL THINGS.'),
    ('ar', 'كان هذا الشخص قادرًا على تسخير السحر للتحكم في كل شيء.'),
    ('vi', 'NGƯỜI NÀY CÓ THỂ DÙNG PHÉP THUẬT ĐỂ ĐIỀU KHIỂN VẠN VẬT.'),
])
def test_translated_glyphs_stay_inside_bubble_mask(assets, offline, monkeypatch, language, text):
    models, fonts = assets
    renderer = Renderer(models, fonts)
    from manga_translator import rendering
    from manga_translator.utils import TextBlock, erode_bubble_mask
    source = np.full((500, 600, 3), 255, dtype=np.uint8)
    block = TextBlock(np.array([[[230, 130], [350, 130], [350, 340], [230, 340]]]),
                      ['source'], font_size=56, direction='v')
    mask = np.zeros(source.shape[:2], dtype=np.uint8)
    mask[95:375, 180:410] = 255
    dispatch, observed = rendering.dispatch, []

    async def capture(*args, **kwargs):
        output = await dispatch(*args, **kwargs)
        observed.extend(args[1])
        return output

    monkeypatch.setattr(rendering, 'dispatch', capture)
    output = renderer.render(source, source, [serialize_region(block)], [text], language, mask)
    painted = np.any(output != source, axis=2)
    assert painted.any()
    assert not np.any(painted & (mask == 0))
    assert re.sub(r'\s*\[BR\]\s*', ' ', observed[0].translation).split() == text.split()
    assert observed[0].font_size < block.font_size
    # Line counts and nominal sizes vary with the selected font. Keep whole
    # words and verify the largest safe size, not the retired Bangers metrics.
    assert_maximum_scaled_font(observed[0], erode_bubble_mask(mask, .02))


def assert_maximum_scaled_font(block, mask):
    """Measure actual glyphs, not a font-specific historical pixel-size floor."""
    from mtu_engine.engine import configuration
    from manga_translator import rendering
    config = configuration()
    config._current_region = block
    rendering.text_render.set_font(block.font_family)
    maximum = rendering._apply_final_font_constraints(block.original_font_size, config)
    assert block.font_size <= maximum
    assert rendering._polygon_fully_inside_mask(block.dst_points[0], mask)
    if block.font_size == maximum:
        return  # Source-size cap can be reached before the geometry is full.
    # The smallest layout font that could raise the final scaled size by 1px.
    next_size = math.ceil((block.font_size + 1) / config.render.font_scale_ratio)
    points = rendering._calc_region_dst_points_for_font(
        region=block, font_size=next_size, render_horizontally=block.horizontal,
        line_spacing_multiplier=block.line_spacing, letter_spacing_multiplier=block.letter_spacing,
        config=config, anchor_mode='center')
    assert not rendering._polygon_fully_inside_mask(points[0], mask)


@pytest.mark.parametrize('text', ['NEW', 'STOP!', 'سلام'])
def test_single_word_preserves_characters_without_internal_breaks(assets, offline, monkeypatch, text):
    models, fonts = assets
    renderer = Renderer(models, fonts)
    from manga_translator import rendering
    from manga_translator.utils import TextBlock
    source = np.full((300, 300, 3), 255, dtype=np.uint8)
    block = TextBlock(np.array([[[100, 40], [190, 40], [190, 220], [100, 220]]]),
                      ['原'], font_size=90, direction='v')
    dispatch, observed = rendering.dispatch, []
    async def capture(*args, **kwargs):
        result = await dispatch(*args, **kwargs)
        observed.extend(args[1])
        return result
    monkeypatch.setattr(rendering, 'dispatch', capture)
    output = renderer.render(source, source, [serialize_region(block)], [text],
                             'ar' if text == 'سلام' else 'en', None)
    assert np.any(output != source)
    assert observed[0].translation == text
    assert observed[0].font_size > 0


@pytest.mark.parametrize(('language', 'text', 'shape'), [
    ('de', 'WUNDERSCHÖN.', 'solid'),
    ('en', 'Beautiful.', 'solid'),
    ('de', 'WUNDERSCHÖN.', 'hole'),
    ('de', 'WUNDERSCHÖN.', 'neighbor'),
])
@pytest.mark.parametrize('font_id', [None, 'patrick-hand'])
def test_horizontal_single_word_uses_enclosing_bubble_without_splitting(assets, offline, monkeypatch, language, text, shape, font_id):
    import cv2
    from mtu_engine import layout
    # This regression isolates the whole-word horizontal/rich path. Stacked
    # words may now span columns and have separate character-completeness tests.
    monkeypatch.setattr(layout, '_can_stack_text', lambda *_: False)
    models, fonts = assets
    renderer = Renderer(models, fonts)
    from manga_translator import rendering
    from manga_translator.utils import TextBlock, erode_bubble_mask
    source = np.full((1000, 500, 3), 255, dtype=np.uint8)
    # Actual narrow vertical source geometry; target words must fit the bubble,
    # not stay trapped inside the original 43px-wide OCR rectangle.
    block = TextBlock([[[207, 770], [250, 770], [250, 851], [207, 851]]],
                      ['source'], font_size=43, direction='v')
    region = serialize_region(block)
    mask = np.zeros(source.shape[:2], dtype=np.uint8)
    cv2.ellipse(mask, (230, 812), (86, 86), 0, 0, 360, 255, -1)
    if shape == 'hole':
        # Outside the source lines, but inside the larger word's possible box.
        mask[792:831, 280:296] = 0
    elif shape == 'neighbor':
        cv2.ellipse(mask, (415, 812), (60, 82), 0, 0, 360, 255, -1)
    dispatch, observed = rendering.dispatch, []

    async def capture(*args, **kwargs):
        result = await dispatch(*args, **kwargs)
        observed.extend((str(args[2].render.layout_mode), item) for item in args[1])
        return result

    monkeypatch.setattr(rendering, 'dispatch', capture)
    free_output = renderer.render(source, source, [region], [text], language, None, font_id=font_id)
    free_mode, free = observed.pop()
    assert free_mode == 'smart_scaling' and free.translation == text
    assert np.any(free_output != source) and 0 < free.font_size < 20
    output = renderer.render(source, source, [region], [text], language, mask, font_id=font_id)
    mode, enclosed = observed.pop()
    painted = np.any(output != source, axis=2)
    assert mode == 'balloon_fill' and painted.any()
    assert enclosed.horizontal and enclosed.translation == text and '[BR]' not in enclosed.translation
    assert not np.any(painted & (mask == 0))
    assert enclosed.font_size > 0
    assert enclosed.font_size > free.font_size
    assert_maximum_scaled_font(enclosed, erode_bubble_mask(mask, .02))
    if shape == 'neighbor':
        assert not np.any(painted[:, 355:])
    # No per-page layout state may turn a later uncontained word into a bubble.
    assert np.array_equal(renderer.render(source, source, [region], [text], language, None, font_id=font_id), free_output)


@pytest.mark.parametrize(('texts', 'lefts', 'shape'), [
    (['WUNDERSCHÖN.', 'WUNDERSCHÖN.'], (158, 398), 'rectangle'),
    (['WUNDERSCHÖN.', 'DIE WELT IST SCHÖN.'], (158, 370), 'rectangle'),
    (['DIE WELT IST SCHÖN.', 'WUNDERSCHÖN.'], (158, 370), 'rectangle'),
    (['WUNDERSCHÖN.', 'WUNDERSCHÖN.'], (240, 298), 'ellipse'),
], ids=['rich-rich', 'rich-plain', 'plain-rich', 'nearby-anchors'])
def test_enlarged_horizontal_single_word_avoids_other_paragraph_in_same_bubble(assets, offline, monkeypatch, texts, lefts, shape):
    import cv2
    from mtu_engine import layout
    # Preserve this test's original rich-word collision coverage independently
    # of the additional vertical alternatives exercised by shared-bubble tests.
    monkeypatch.setattr(layout, '_can_stack_text', lambda *_: False)
    models, fonts = assets
    renderer = Renderer(models, fonts)
    from manga_translator import rendering
    from manga_translator.utils import TextBlock
    source = np.full((400, 600, 3), 255, dtype=np.uint8)
    mask = np.zeros(source.shape[:2], dtype=np.uint8)
    if shape == 'ellipse':
        cv2.ellipse(mask, (300, 200), (250, 170), 0, 0, 360, 255, -1)
    else:
        mask[60:340, 40:560] = 255
    regions = [serialize_region(TextBlock([[[left, 160], [left + 43, 160],
        [left + 43, 241], [left, 241]]], ['source'], font_size=43, direction='v'))
        for left in lefts]
    dispatch, observed = rendering.dispatch, []

    async def capture(*args, **kwargs):
        result = await dispatch(*args, **kwargs)
        observed.extend(args[1])
        return result

    monkeypatch.setattr(rendering, 'dispatch', capture)
    output = renderer.render(source, source, regions, texts, 'de', mask)
    painted = np.any(output != source, axis=2)
    assert painted.any() and not np.any(painted & (mask == 0))
    assert len(observed) == 2
    for block, text in zip(observed, texts):
        assert block.horizontal and block.font_size > 0
        assert re.sub(r'\s*\[BR\]\s*', ' ', block.translation).split() == text.split()
        if len(text.split()) == 1:
            assert block.translation == text
    assert not rendering._polygons_overlap(observed[0].dst_points, observed[1].dst_points)


@pytest.mark.parametrize('angle', [0, 15, -15])
def test_long_translation_near_page_edge_preserves_all_words(assets, offline, monkeypatch, angle):
    models, fonts = assets
    renderer = Renderer(models, fonts)
    from manga_translator import rendering
    from manga_translator.utils import TextBlock
    block = TextBlock(np.array([[[470, 60], [570, 60], [570, 300], [470, 300]]]),
                      ['source'], font_size=48, angle=angle, direction='h')
    source = np.full((400, 600, 3), 255, dtype=np.uint8)
    text = 'KEINDAHAN DUNIA YANG SESUNGGUHNYA.'
    dispatch, observed = rendering.dispatch, []
    async def capture(*args, **kwargs):
        result = await dispatch(*args, **kwargs)
        observed.extend(args[1])
        return result
    monkeypatch.setattr(rendering, 'dispatch', capture)
    output = renderer.render(source, source, [serialize_region(block)], [text], 'id', None)
    assert np.any(output != source)
    points = observed[0].dst_points.reshape(-1, 2)
    assert points[:, 0].min() >= 1 and points[:, 0].max() <= 599
    assert points[:, 1].min() >= 1 and points[:, 1].max() <= 399
    assert re.sub(r'\s*\[BR\]\s*', ' ', observed[0].translation).split() == text.split()


@pytest.fixture
def bubble_layout(assets, offline, monkeypatch):
    """Real Qt pixels and final native boxes; no OCR or model inference."""
    renderer = Renderer(*assets)
    from manga_translator import rendering
    dispatch, observed = rendering.dispatch, []

    async def capture(*args, **kwargs):
        result = await dispatch(*args, **kwargs)
        observed.extend(args[1])
        return result

    monkeypatch.setattr(rendering, 'dispatch', capture)
    return renderer, observed, rendering


@pytest.mark.parametrize('edge', ['left', 'right'])
@pytest.mark.parametrize('cache_bytes', [0, None])
@pytest.mark.parametrize('font_id', [None, 'noto-sans'])
def test_narrow_caption_recovers_font_with_bounded_native_hyphenation(
        bubble_layout, monkeypatch, edge, cache_bytes, font_id):
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    # Isolate dictionary-based horizontal recovery: a valid vertical
    # alternative can otherwise beat both horizontal sides of this A/B. Keep
    # the real Unicode safety decision shared by hyphenation and stacking.
    resize = native.resize_regions_to_font_size

    def reject_vertical_candidate(*args, **kwargs):
        points = resize(*args, **kwargs)
        for block in args[1]:
            if block.vertical:
                block.font_size = 1
        return points

    monkeypatch.setattr(native, 'resize_regions_to_font_size', reject_vertical_candidate)
    image = np.full((400, 300, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    x = 0 if edge == 'left' else 260
    mask[10:390, x:x+40] = 255
    region = serialize_region(TextBlock([[[x+8, 30], [x+30, 30], [x+30, 370], [x+8, 370]]],
        ['source'], font_size=24, direction='v'))
    snapshot = json.loads(json.dumps(region))
    text = 'Extraordinary circumstances / Please proceed carefully.'
    with monkeypatch.context() as baseline:
        baseline.setattr(native.text_render, 'select_hyphenator', lambda *_: None)
        renderer.render(image, image, [region], [text], 'en', mask,
                        mask_cache_bytes=cache_bytes, font_id=font_id)
    before = observed.pop()
    calls, rectangle = [], native.find_largest_inscribed_rect

    def counted(value):
        calls.append(value.shape)
        return rectangle(value)

    monkeypatch.setattr(native, 'find_largest_inscribed_rect', counted)
    result = renderer.render(image, image, [region], [text], 'en', mask,
                             mask_cache_bytes=cache_bytes, font_id=font_id)
    after = observed.pop()
    assert region == snapshot
    assert len(calls) == 1 and calls[0][1] < image.shape[1]  # One local alternative, never a page search.
    assert after.font_size > before.font_size
    assert '-[BR]' in after.translation
    assert re.sub(r'-\[BR\]', '', after.translation).replace('[BR]', ' ').split() == text.split()
    assert native._polygon_fully_inside_mask(after.dst_points[0], erode_bubble_mask(mask, .02))
    points = after.dst_points.reshape(-1, 2)
    assert (points >= (1, 1)).all() and (points <= (299, 399)).all()
    painted = np.any(result != image, axis=2)
    assert painted.any() and not np.any(painted & (erode_bubble_mask(mask, .02) == 0))
    np.testing.assert_array_equal(after.lines, np.asarray(region['lines']))


@pytest.mark.parametrize(('language', 'text', 'narrow'), [
    ('en', 'Extraordinary circumstances / Please proceed carefully.', False),
    ('en', 'Extraordinary[BR]circumstances / Please proceed carefully.', True),
    ('en', 'Extraordinary', True),
    ('ar', 'هذه ظروف استثنائية يرجى المتابعة بحذر', True),
])
def test_hyphenation_recovery_preserves_normal_explicit_single_and_unsupported_layouts(
        bubble_layout, monkeypatch, language, text, narrow):
    from manga_translator.utils import TextBlock
    renderer, observed, native = bubble_layout
    image = np.full((400, 300, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[10:390, 10:50 if narrow else 290] = 255
    # A wide bubble with a narrow source is now a recovery case too. Use
    # genuinely normal source geometry for the unchanged-layout control.
    lines = [[[18, 30], [42, 30], [42, 370], [18, 370]]] if narrow else [
        [[50, 110], [250, 110], [250, 290], [50, 290]]]
    region = serialize_region(TextBlock(lines, ['source'], font_size=24, direction='v'))
    with monkeypatch.context() as baseline:
        baseline.setattr(native.text_render, 'select_hyphenator', lambda *_: None)
        expected = renderer.render(image, image, [region], [text], language, mask)
    observed.clear()
    actual = renderer.render(image, image, [region], [text], language, mask)
    np.testing.assert_array_equal(actual, expected)
    assert '-[BR]' not in observed[-1].translation


def test_narrow_caption_recovery_reserves_other_paragraphs(bubble_layout):
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    image = np.full((500, 240, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[10:490, 90:138] = 255
    regions = [serialize_region(TextBlock([[[102, y], [126, y], [126, y+100], [102, y+100]]],
        ['source'], font_size=24, direction='v')) for y in (50, 320)]
    texts = ['Extraordinary circumstances / Please proceed carefully.', 'Keep this paragraph.']
    result = renderer.render(image, image, regions, texts, 'en', mask)
    assert len(observed) == 2
    assert not native._polygons_overlap(observed[0].dst_points, observed[1].dst_points)
    for block, text in zip(observed, texts):
        if block.horizontal:
            assert re.sub(r'-\[BR\]', '', block.translation).replace('[BR]', ' ').split() == text.split()
        else:
            # Native stacked columns can continue a word in the next column.
            assert ''.join(block.translation.replace('[BR]', '').split()) == ''.join(text.split())
    painted = np.any(result != image, axis=2)
    assert painted.any() and not np.any(painted & (erode_bubble_mask(mask, .02) == 0))


def test_narrow_caption_keeps_existing_layout_when_candidate_is_not_larger(bubble_layout, monkeypatch):
    from manga_translator.utils import TextBlock
    from manga_translator.rendering import auto_linebreak
    renderer, observed, native = bubble_layout
    image = np.full((400, 200, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[10:390, 10:50] = 255
    region = serialize_region(TextBlock([[[18, 30], [42, 30], [42, 370], [18, 370]]],
        ['source'], font_size=24, direction='v'))
    text = 'Extraordinary circumstances / Please proceed carefully.'
    with monkeypatch.context() as baseline:
        baseline.setattr(native.text_render, 'select_hyphenator', lambda *_: None)
        expected = renderer.render(image, image, [region], [text], 'en', mask)
    calls = []

    def no_improvement(font_size, value, *args, **kwargs):
        calls.append(value)
        return [value], []

    monkeypatch.setattr(auto_linebreak, '_layout_horizontal_eng', no_improvement)
    actual = renderer.render(image, image, [region], [text], 'en', mask)
    assert calls == [text]
    np.testing.assert_array_equal(actual, expected)


@pytest.mark.parametrize('shape', ['concave', 'hole', 'tail'])
@pytest.mark.parametrize('cache_bytes', [0, None])
def test_irregular_bubble_recovers_readable_layout_without_changing_source(bubble_layout, shape, cache_bytes):
    import cv2
    from mtu_engine.layout import associate_bubbles
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    image = np.full((400, 500, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    if shape == 'concave':
        mask[30:350, 20:210] = 255
        mask[230:370, 20:430] = 255
        lines = [[[25, 70], [190, 70], [190, 100], [25, 100]],
                 [[25, 160], [190, 160], [190, 190], [25, 190]],
                 [[25, 250], [405, 250], [405, 285], [25, 285]]]
    elif shape == 'hole':
        mask[20:380, 20:450] = 255
        mask[140:240, 180:270] = 0
        lines = [[[40, 80], [165, 80], [165, 110], [40, 110]],
                 [[280, 260], [420, 260], [420, 290], [280, 290]]]
    else:
        mask[60:330, 140:450] = 255
        cv2.fillPoly(mask, [np.array([[20, 100], [160, 100], [160, 180]])], 255)
        lines = [[[70, 110], [120, 110], [120, 120], [70, 120]],
                 [[160, 240], [410, 240], [410, 270], [160, 270]]]
    block = TextBlock(lines, ['source'], font_size=26, direction='h', angle=1)
    associate_bubbles([block], mask)
    assert block.bubble_enclosed
    region = serialize_region(block)
    snapshot = json.loads(json.dumps(region))
    text = '虽然很厉害但是我不想学一般人会选择更容易掌握的招式'
    calls, rectangle = [], native.find_largest_inscribed_rect

    def counted(value):
        calls.append(value.shape)
        return rectangle(value)

    native.find_largest_inscribed_rect = counted
    try:
        output = renderer.render(image, image, [region], [text], 'zh-Hans', mask,
                                 mask_cache_bytes=cache_bytes)
    finally:
        native.find_largest_inscribed_rect = rectangle
    assert region == snapshot
    assert len(calls) == 1 and calls[0][0] < image.shape[0]  # One ROI-only alternative.
    painted = np.any(output != image, axis=2)
    inset = erode_bubble_mask(mask, .02)
    assert painted.any() and not np.any(painted & (inset == 0))
    assert observed[-1].font_size >= 16
    assert observed[-1].translation.replace('[BR]', '') == text
    np.testing.assert_array_equal(observed[-1].lines, block.lines)
    # The checkpoint carries ownership across inpaint/cache/IPC. Cached inset
    # and cold raw-mask paths must produce identical pixels and source geometry.
    _, labels, stats, _ = cv2.connectedComponentsWithStats(inset, connectivity=8)
    restored = renderer.render(image, image, [snapshot], [text], 'zh-Hans', inset,
        bubble_prepared=True, bubble_components=(labels, stats), mask_cache_bytes=cache_bytes)
    np.testing.assert_array_equal(restored, output)


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('language,texts', [
    ('zh-Hans', ['这是一段需要重新排版的文字不能挤到旁边', '中间这段文字也要保留', '最后一段同样需要空间']),
    ('en', ['This paragraph needs room without covering its neighbors.',
            'Keep the middle paragraph intact.', 'The final paragraph also needs space.']),
])
def test_shared_bubble_reserves_pending_and_placed_paragraphs(bubble_layout, reverse, language, texts):
    import cv2
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    image = np.full((420, 600, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    cv2.ellipse(mask, (300, 210), (275, 180), 0, 0, 360, 255, -1)
    lines = [
        [[[75, 125], [130, 125], [130, 145], [75, 145]],
         [[45, 205], [140, 205], [140, 225], [45, 225]]],
        [[[270, 160], [330, 160], [330, 230], [270, 230]]],
        [[[440, 160], [520, 160], [520, 230], [440, 230]]],
    ]
    regions = [serialize_region(TextBlock(value, ['source'], font_size=26, direction='h')) for value in lines]
    if reverse:
        regions, texts = regions[::-1], texts[::-1]
    output = renderer.render(image, image, regions, texts, language, mask)
    assert len(observed) == 3
    for i, block in enumerate(observed):
        assert block.font_size >= 10
        # Narrow paragraphs in a wide shared bubble can now use native
        # hyphenation too; reconstruct words before checking completeness.
        restored = block.translation.replace('-[BR]', '').replace('[BR]', '')
        assert ''.join(restored.split()) == ''.join(texts[i].split())
        for other in observed[i+1:]:
            assert not native._polygons_overlap(block.dst_points, other.dst_points)
    painted = np.any(output != image, axis=2)
    assert painted.any() and not np.any(painted & (erode_bubble_mask(mask, .02) == 0))


@pytest.mark.parametrize('edge,box', [
    ('top', (190, 0, 290, 38)), ('bottom', (190, 360, 290, 399)),
    ('left', (0, 180, 80, 220)), ('right', (419, 180, 499, 220)),
])
@pytest.mark.parametrize('angle', [0, 18])
def test_bubble_layout_checks_unclipped_page_edges(bubble_layout, edge, box, angle):
    from manga_translator.utils import TextBlock
    renderer, observed, _ = bubble_layout
    image = np.full((400, 500, 3), 255, np.uint8)
    mask = np.full(image.shape[:2], 255, np.uint8)
    x1, y1, x2, y2 = box
    block = TextBlock([[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]],
                      ['source'], font_size=30, angle=angle, direction='h')
    text = '页面边缘的文字也应该完整保留不能被裁切或缩成看不清的小字'
    output = renderer.render(image, image, [serialize_region(block)], [text], 'zh-Hans', mask)
    points = observed[-1].dst_points.reshape(-1, 2)
    assert (points >= (1, 1)).all() and (points <= (499, 399)).all(), edge
    assert observed[-1].font_size >= 16
    assert observed[-1].translation.replace('[BR]', '') == text
    assert np.any(output != image)
    assert np.array_equal(output[[0, -1]], image[[0, -1]])
    assert np.array_equal(output[:, [0, -1]], image[:, [0, -1]])


@pytest.mark.parametrize('cache_bytes', [0, None])
def test_short_wide_bubble_shrinks_overflow_without_a_collision(bubble_layout, monkeypatch, cache_bytes):
    from manga_translator.utils import TextBlock
    renderer, observed, native = bubble_layout
    image = np.full((200, 1433, 3), 255, np.uint8)
    inset = np.zeros(image.shape[:2], np.uint8)
    inset[45:127, 420:1071] = 255
    region = {**serialize_region(TextBlock(
        [[[458, 60], [1056, 60], [1056, 110], [458, 110]]],
        ['source'], font_size=50, direction='h')), 'bubble_enclosed': True}
    snapshot = json.loads(json.dumps(region))
    text = 'AN EXTRAORDINARY ADVENTURE'
    resize = native.resize_regions_to_font_size

    def oversized(*args, **kwargs):
        points = resize(*args, **kwargs)
        # Reproduce a final native font that exceeds a short bubble after
        # wrapping, independently of platform-specific Qt font measurements.
        for index, block in enumerate(args[1]):
            block.font_size = 48
            args[2]._current_region = block
            native.text_render.set_font(block.font_family)
            points[index] = native._calc_region_dst_points_for_font(
                region=block, font_size=48, render_horizontally=True,
                line_spacing_multiplier=block.line_spacing,
                letter_spacing_multiplier=block.letter_spacing, config=args[2], anchor_mode='center')
        return points

    monkeypatch.setattr(native, 'resize_regions_to_font_size', oversized)
    output = renderer.render(image, image, [region], [text], 'en', inset,
        bubble_prepared=True, mask_cache_bytes=cache_bytes, font_id='comic-relief')
    assert region == snapshot and len(observed) == 1
    block = observed[0]
    assert 1 < block.font_size < 47
    assert block.translation.replace('[BR]', ' ').split() == text.split()
    assert native._polygon_fully_inside_mask(block.dst_points.reshape(-1, 2), inset)
    painted = np.any(output != image, axis=2)
    assert painted.any() and not np.any(painted & (inset == 0))
    np.testing.assert_array_equal(block.lines, region['lines'])


def test_safe_bubble_layout_does_not_search_alternate_rectangles(bubble_layout, monkeypatch):
    from manga_translator.utils import TextBlock
    renderer, observed, native = bubble_layout
    image = np.full((300, 400, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[20:280, 20:380] = 255
    block = TextBlock([[[100, 90], [300, 90], [300, 200], [100, 200]]], ['source'],
                      font_size=26, direction='h')
    monkeypatch.setattr(native, 'find_largest_inscribed_rect',
                        lambda *_: pytest.fail('Normal CJK layout must keep its fast path'))
    layouts, layout = [], native._layout_regions_to_font_size

    def counted(*args, **kwargs):
        if args[1]:
            layouts.append(len(args[1]))
        return layout(*args, **kwargs)

    monkeypatch.setattr(native, '_layout_regions_to_font_size', counted)
    result = renderer.render(image, image, [serialize_region(block)], ['正常气泡保持原有排版'], 'zh-Hans', mask)
    assert np.any(result != image) and len(observed) == 1
    assert layouts == [1]  # Paint the validated geometry without repeating Qt layout.


def test_bubble_layout_keeps_native_subpixel_mask_tolerance(bubble_layout, monkeypatch):
    import cv2
    from mtu_engine.engine import configuration
    from mtu_engine.layout import fit_bubbles
    from manga_translator.utils import TextBlock
    _, _, native = bubble_layout
    image = np.full((180, 240, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[20:120, 20:180] = 255
    _, labels = cv2.connectedComponents(mask)
    block = TextBlock([[[50, 50], [150, 50], [150, 90], [50, 90]]],
                      ['source'], font_size=26, direction='h')
    block.original_font_size = block.font_size
    block.font_size = 20
    points = np.array([[[40., 40.], [179.4, 40.], [179.4, 119.4], [40., 119.4]]])
    monkeypatch.setattr(native, 'resize_regions_to_font_size', lambda *a, **k: [points])
    monkeypatch.setattr(native, '_binary_search_font_for_bubble_mask',
                        lambda **k: pytest.fail('Native pixel rounding must not trigger shrinking'))
    monkeypatch.setattr(native, 'find_largest_inscribed_rect',
                        lambda *_: pytest.fail('A tolerated layout needs no alternate rectangle'))
    blocks, actual = fit_bubbles(image, image, [block], ['SOURCE'], configuration(),
                                mask, labels, language='en')
    assert blocks[0].font_size == 20
    np.testing.assert_array_equal(actual[0], points)


def test_missing_safe_bubble_fails_without_publishing_erased_page(bubble_layout):
    from manga_translator.utils import TextBlock
    renderer, observed, _ = bubble_layout
    image = np.full((100, 100, 3), 255, np.uint8)
    block = TextBlock([[[20, 20], [80, 20], [80, 80], [20, 80]]], ['source'], font_size=24)
    region = {**serialize_region(block), 'bubble_enclosed': True}
    with pytest.raises(ValueError, match='No safe bubble layout'):
        renderer.render(image, image, [region], ['保留原图'], 'zh-Hans', np.zeros(image.shape[:2], np.uint8),
                        bubble_prepared=True)
    assert not observed


@pytest.mark.parametrize('language', ['zh-Hans', 'en', 'ko'])
def test_recovered_bubble_layout_matches_real_render_process_pool(assets, offline, language):
    import cv2
    from classic_node.render_pool import RenderPool, render_page
    from mtu_engine.layout import associate_bubbles
    renderer = Renderer(*assets)
    from manga_translator.utils import TextBlock, erode_bubble_mask
    image = np.full((360, 480, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    if language in ('en', 'ko'):
        mask[20:340, 20:60] = 255
        lines = [[[28, 40], [52, 40], [52, 320], [28, 320]]]
        text = ['개구쟁이 초등학생이냐고' if language == 'ko' else
                'Extraordinary circumstances / Please proceed carefully.']
    else:
        mask[20:330, 20:200] = 255
        mask[220:340, 20:450] = 255
        lines = [[[24, 70], [190, 70], [190, 100], [24, 100]],
                 [[30, 240], [430, 240], [430, 270], [30, 270]]]
        text = ['异形气泡在子进程中同样保持安全排版和可读字号']
    block = TextBlock(lines, ['source'], font_size=26, direction='h')
    associate_bubbles([block], mask)
    assert block.bubble_enclosed
    regions = [serialize_region(block)]
    inset = erode_bubble_mask(mask, .02)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(inset, connectivity=8)
    options = {'alpha': None, 'version': 'bubble-fixture', 'analysis': {'input_hash': '0' * 64},
               'translated': {'analysis_hash': '1' * 64, 'revision': '2' * 64},
               'bubble_prepared': True, 'bubble_components': (labels, stats)}
    expected = render_page(renderer, image, image, regions, text, language, inset, **options)
    pool = RenderPool(*assets, workers=2, threads=1)
    try:
        pool.warmup()
        assert pool.render(image, image, regions, text, language, inset, **options) == expected
    finally:
        pool.close()


@pytest.mark.parametrize('cache_bytes', [0, None])
@pytest.mark.parametrize(('language', 'text'), [
    ('ko', '실례할게'),
    ('ko', '개구쟁이 초등학생이냐고'),
    ('en', 'Extraordinary'),
    ('de', 'WUNDERSCHÖN.'),
    ('ru', 'Замечательно!'),
    ('id', 'Mengagumkan!'),
])
def test_narrow_translation_recovers_native_vertical_font(
        bubble_layout, monkeypatch, cache_bytes, language, text):
    from mtu_engine import layout
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    image = np.full((440, 200, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[30:410, 78:122] = 255
    region = serialize_region(TextBlock([[[86, 45], [114, 45], [114, 395], [86, 395]]],
        ['source'], font_size=28, direction='v'))
    snapshot = json.loads(json.dumps(region))
    with monkeypatch.context() as baseline:
        baseline.setattr(layout, '_can_stack_text', lambda *_: False)
        renderer.render(image, image, [region], [text], language, mask,
                        mask_cache_bytes=cache_bytes)
    before = observed.pop()
    calls, rectangle = [], native.find_largest_inscribed_rect

    def counted(value):
        calls.append(value.shape)
        return rectangle(value)

    monkeypatch.setattr(native, 'find_largest_inscribed_rect', counted)
    result = renderer.render(image, image, [region], [text], language, mask,
                             mask_cache_bytes=cache_bytes)
    after = observed.pop()
    assert region == snapshot
    assert before.horizontal and after.vertical
    assert after.font_size > before.font_size
    assert after.font_size >= region['font_size'] * .5
    assert after.original_font_size == region['font_size']
    assert len(calls) == 1 and calls[0][1] < image.shape[1]
    assert ''.join(after.translation.replace('[BR]', '').split()) == ''.join(text.split())
    np.testing.assert_array_equal(after.lines, np.asarray(region['lines']))
    inset = erode_bubble_mask(mask, .02)
    assert native._polygon_fully_inside_mask(after.dst_points[0], inset)
    painted = np.any(result != image, axis=2)
    assert painted.any() and not np.any(painted & (inset == 0))


def test_narrow_source_recovers_inside_wide_shared_bubble(bubble_layout, monkeypatch):
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    image = np.full((440, 400, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[20:220, 20:380] = 255
    mask[180:420, 40:84] = 255
    regions = [serialize_region(TextBlock([[[46, 250], [76, 250], [76, 390], [46, 390]]],
        ['source'], font_size=28, direction='v')),
        serialize_region(TextBlock([[[130, 65], [310, 65], [310, 165], [130, 165]]],
        ['source'], font_size=28, direction='h'))]
    texts = ['개구쟁이 초등학생이냐고', '이 문단의 글자는 다른 문단이 가리면 안 됩니다.']
    snapshot = json.loads(json.dumps(regions))
    calls, rectangle = [], native.find_largest_inscribed_rect

    def counted(value):
        calls.append(value.shape)
        return rectangle(value)

    monkeypatch.setattr(native, 'find_largest_inscribed_rect', counted)
    result = renderer.render(image, image, regions, texts, 'ko', mask)
    assert regions == snapshot and len(observed) == 2
    assert observed[0].font_size >= regions[0]['font_size'] * .5
    assert not native._polygons_overlap(observed[0].dst_points, observed[1].dst_points)
    # Native initial mask layout can receive the page mask; the additional
    # recovery still searches only one component-local rectangle.
    local_calls = [shape for shape in calls if shape != image.shape[:2]]
    assert len(local_calls) == 1 and local_calls[0][1] < image.shape[1]
    for block, text in zip(observed, texts):
        assert ''.join(block.translation.replace('[BR]', '').split()) == ''.join(text.split())
    painted = np.any(result != image, axis=2)
    assert painted.any() and not np.any(painted & (erode_bubble_mask(mask, .02) == 0))


@pytest.mark.parametrize(('language', 'text', 'narrow'), [
    ('ko', '내일 제출인 레포트가 안 끝나아~!!', False),
    ('ko', '개구쟁이[BR]초등학생이냐고', True),
    ('en', 'Extraordinary[BR]circumstances', True),
    ('ar', 'استثنائية', True),
    ('en', 'Magicسلام', True),
    ('en', 'E\u0301xtraordinaire', True),
    ('ko', '\u1100\u1162구쟁이', True),
])
def test_vertical_recovery_preserves_normal_explicit_and_shaped_text(
        bubble_layout, monkeypatch, language, text, narrow):
    from mtu_engine import layout
    from manga_translator.utils import TextBlock
    renderer, observed, _ = bubble_layout
    image = np.full((440, 260, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    left, right = (108, 152) if narrow else (25, 235)
    mask[30:410, left:right] = 255
    region = serialize_region(TextBlock([[[116, 45], [144, 45], [144, 395], [116, 395]]],
        ['source'], font_size=28, direction='v'))
    with monkeypatch.context() as baseline:
        baseline.setattr(layout, '_can_stack_text', lambda *_: False)
        expected = renderer.render(image, image, [region], [text], language, mask)
    observed.clear()
    actual = renderer.render(image, image, [region], [text], language, mask)
    np.testing.assert_array_equal(actual, expected)
    assert observed[-1].horizontal


@pytest.mark.parametrize('shape', ['left-edge', 'hole'])
def test_vertical_recovery_keeps_page_edges_and_mask_holes(bubble_layout, shape):
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    image = np.full((440, 200, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    left = 0 if shape == 'left-edge' else 78
    mask[10:430, left:left+44] = 255
    if shape == 'hole':
        mask[205:225, left:left+17] = 0
    region = serialize_region(TextBlock([[[left+20, 30], [left+40, 30],
        [left+40, 410], [left+20, 410]]], ['source'], font_size=28, direction='v'))
    result = renderer.render(image, image, [region], ['실례할게'], 'ko', mask)
    block = observed[-1]
    assert block.font_size >= 14
    points = block.dst_points.reshape(-1, 2)
    assert (points >= (1, 1)).all() and (points <= (199, 439)).all()
    inset = erode_bubble_mask(mask, .02)
    assert native._polygon_fully_inside_mask(block.dst_points[0], inset)
    painted = np.any(result != image, axis=2)
    assert painted.any() and not np.any(painted & (inset == 0))


def test_vertical_recovery_rejects_smaller_candidate_and_restores_native_options(
        bubble_layout, monkeypatch):
    from mtu_engine import layout
    from manga_translator.utils import TextBlock
    renderer, observed, native = bubble_layout
    image = np.full((440, 200, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[30:410, 78:122] = 255
    region = serialize_region(TextBlock([[[86, 45], [114, 45], [114, 395], [86, 395]]],
        ['source'], font_size=28, direction='v'))
    with monkeypatch.context() as baseline:
        baseline.setattr(layout, '_can_stack_text', lambda *_: False)
        expected = renderer.render(image, image, [region], ['실례할게'], 'ko', mask)
    observed.clear()
    calls, resize, dispatch = [], native.resize_regions_to_font_size, native.dispatch

    def smaller_candidate(*args, **kwargs):
        points = resize(*args, **kwargs)
        for block in args[1]:
            if block.vertical:
                assert not args[2].render.bubble_layout_english
                calls.append(block)
                block.font_size = 1
        return points

    async def check_restored_options(*args, **kwargs):
        assert args[2].render.bubble_layout_english
        return await dispatch(*args, **kwargs)

    monkeypatch.setattr(native, 'resize_regions_to_font_size', smaller_candidate)
    monkeypatch.setattr(native, 'dispatch', check_restored_options)
    actual = renderer.render(image, image, [region], ['실례할게'], 'ko', mask)
    np.testing.assert_array_equal(actual, expected)
    assert len(calls) == 1 and observed[-1].horizontal


@pytest.mark.parametrize('cache_bytes', [0, None])
def test_moderately_tall_translation_recovers_font_with_bounded_reflow(
        bubble_layout, monkeypatch, cache_bytes):
    from mtu_engine import layout
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    image = np.full((400, 300, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[40:300, 60:240] = 255
    lines = [[[x, 80], [x+24, 80], [x+24, 230], [x, 230]] for x in (90, 120, 150)]
    region = serialize_region(TextBlock(lines, ['source'], font_size=28, direction='v'))
    snapshot = json.loads(json.dumps(region))
    text = '그럴 줄 알았어, 나뭇잎투성이잖아'
    with monkeypatch.context() as baseline:
        baseline.setattr(layout, '_can_stack_text', lambda *_: False)
        baseline.setattr(native.text_render, 'select_hyphenator', lambda *_: None)
        baseline.setattr(layout, '_wrap_words', lambda text, *_: text)
        renderer.render(image, image, [region], [text], 'ko', mask,
                        mask_cache_bytes=cache_bytes)
    before = observed.pop()
    calls, rectangle = [], native.find_largest_inscribed_rect

    def counted(value):
        calls.append(value.shape)
        return rectangle(value)

    monkeypatch.setattr(native, 'find_largest_inscribed_rect', counted)
    result = renderer.render(image, image, [region], [text], 'ko', mask,
                             mask_cache_bytes=cache_bytes)
    after = observed.pop()
    assert before.horizontal and before.font_size < .75 * region['font_size']
    # Recovery must improve the font within one safe rectangle, regardless of
    # which native horizontal or vertical candidate wins.
    assert after.font_size > before.font_size
    assert region == snapshot and after.original_font_size == region['font_size']
    assert len(calls) == 1 and calls[0][1] < image.shape[1]
    assert ''.join(after.translation.replace('[BR]', '').split()) == ''.join(text.split())
    np.testing.assert_array_equal(after.lines, np.asarray(region['lines']))
    inset = erode_bubble_mask(mask, .02)
    assert native._polygon_fully_inside_mask(after.dst_points[0], inset)
    painted = np.any(result != image, axis=2)
    assert painted.any() and not np.any(painted & (inset == 0))


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('source_sizes', [(28, 28), (20, 36)])
@pytest.mark.parametrize(('language', 'texts'), [
    ('ko', ['놀라워!', '서두르지 마, 내가 도와줄게.']),
    ('en', ['Incredible!', "Don't panic. I'll help you."]),
    ('fr', ['Incroyable !', "Pas de panique, je vais t'aider."]),
    ('ar', ['مذهل!', 'لا تقلق، سأساعدك.']),
])
def test_shared_bubble_source_font_caps_leave_room_for_both_paragraphs(
        bubble_layout, monkeypatch, reverse, source_sizes, language, texts):
    from mtu_engine.engine import configuration
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    image = np.full((440, 400, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[20:220, 20:380] = 255
    mask[180:420, 40:84] = 255
    regions = [serialize_region(TextBlock([[[46, 250], [76, 250], [76, 390], [46, 390]]],
        ['source'], font_size=source_sizes[0], direction='v')),
        serialize_region(TextBlock([[[130, 65], [310, 65], [310, 165], [130, 165]]],
        ['source'], font_size=source_sizes[1], direction='h'))]
    if reverse:
        regions, texts = regions[::-1], texts[::-1]
    snapshot = json.loads(json.dumps(regions))
    candidates, resize = [], native.resize_regions_to_font_size

    def capture_recovery_candidates(*args, **kwargs):
        points = resize(*args, **kwargs)
        config = args[2]
        if config.render.layout_mode == 'balloon_fill' and not config.render.balloon_fill_mask_layout:
            # Keep the objects: the adapter must cap every candidate after
            # native fitting, including a candidate that is not selected.
            candidates.extend(args[1])
        return points

    monkeypatch.setattr(native, 'resize_regions_to_font_size', capture_recovery_candidates)
    result = renderer.render(image, image, regions, texts, language, mask)
    assert regions == snapshot and len(observed) == len(regions)
    assert candidates  # In particular, French recovery previously grew again after the first cap.
    constraints = configuration()
    for candidate in candidates:
        assert candidate.font_size <= native._apply_final_font_constraints(
            candidate.original_font_size, constraints)
    inset = erode_bubble_mask(mask, .02)
    for block, text, source in zip(observed, texts, regions):
        source_font = source['font_size']
        maximum = native._apply_final_font_constraints(source_font, constraints)
        assert .7 * source_font <= block.font_size <= maximum
        assert block.original_font_size == source_font
        assert ''.join(re.sub(r'-\[BR\]', '', block.translation).replace('[BR]', '').split()) == ''.join(text.split())
        np.testing.assert_array_equal(block.lines, np.asarray(source['lines']))
        points = block.dst_points.reshape(-1, 2)
        assert np.isfinite(points).all()
        assert (points >= (1, 1)).all() and (points <= (399, 439)).all()
        assert native._polygon_fully_inside_mask(points, inset)
        if language == 'ar':
            assert block.horizontal  # Keep Arabic joins and logical character order intact.
    assert not native._polygons_overlap(observed[0].dst_points, observed[1].dst_points)
    painted = np.any(result != image, axis=2)
    assert painted.any() and not np.any(painted & (inset == 0))


@pytest.mark.parametrize('cache_bytes', [0, None])
@pytest.mark.parametrize('edge', [False, True])
@pytest.mark.parametrize(('language', 'text'), [
    ('ko', '내일 제출할 보고서를 아직 못 끝냈어!'),
    ('en', 'Pneumonoultramicroscopicsilicovolcanoconiosis!'),
    ('fr', "Je n'ai pas encore fini le rapport à rendre demain !"),
    ('es', '¡Todavía no he terminado el informe que tengo que entregar mañana!'),
    ('pt-BR', 'Ainda não terminei o relatório que preciso entregar amanhã!'),
    ('tr', 'Yarın teslim etmem gereken raporu hâlâ bitiremedim!'),
    ('ar', 'لم أنته بعد من التقرير الذي يجب تسليمه غدا!'),
])
def test_narrow_long_translation_uses_height_without_losing_larger_single_column(
        bubble_layout, monkeypatch, cache_bytes, edge, language, text):
    from types import SimpleNamespace
    from mtu_engine import layout
    from mtu_engine.engine import configuration
    from manga_translator.rendering import auto_linebreak
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    image = np.full((440, 400, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    left = 0 if edge else 168
    mask[50:390, left:left+64] = 255
    if edge:
        mask[195:225, :17] = 0
    source_left = 25 if edge else 186
    region = serialize_region(TextBlock([[[source_left, 75], [source_left+28, 75],
        [source_left+28, 365], [source_left, 365]]], ['source'], font_size=28, direction='v'))
    snapshot = json.loads(json.dumps(region))
    solve = auto_linebreak.solve_no_br_layout

    def single_column_only(*args, **kwargs):
        config = kwargs.get('config')
        if config is not None and getattr(config, '_current_region', None) is None:
            # Disable only the new copy-local column alternative. Native
            # source-region layout remains real, including its one-column rule.
            assert not kwargs['horizontal']
            return SimpleNamespace(text_with_br=kwargs['text'])
        return solve(*args, **kwargs)

    with monkeypatch.context() as baseline:
        baseline.setattr(auto_linebreak, 'solve_no_br_layout', single_column_only)
        baseline.setattr(native.text_render, 'select_hyphenator', lambda *_: None)
        baseline.setattr(layout, '_wrap_words', lambda value, *_: value)
        renderer.render(image, image, [region], [text], language, mask,
                        mask_cache_bytes=cache_bytes)
    before = observed.pop()
    rectangles, candidates = [], []
    rectangle, resize = native.find_largest_inscribed_rect, native.resize_regions_to_font_size

    def counted_rectangle(value):
        rectangles.append(value.shape)
        return rectangle(value)

    def capture_candidates(*args, **kwargs):
        points = resize(*args, **kwargs)
        config = args[2]
        if config.render.layout_mode == 'balloon_fill' and not config.render.balloon_fill_mask_layout:
            if any(candidate.vertical for candidate in args[1]):
                assert not config.render.bubble_layout_english
            candidates.extend(args[1])
        return points

    monkeypatch.setattr(native, 'find_largest_inscribed_rect', counted_rectangle)
    monkeypatch.setattr(native, 'resize_regions_to_font_size', capture_candidates)
    output = renderer.render(image, image, [region], [text], language, mask,
                             mask_cache_bytes=cache_bytes)
    after = observed.pop()
    assert region == snapshot and after.original_font_size == region['font_size']
    np.testing.assert_array_equal(after.lines, np.asarray(region['lines']))
    if language == 'ko' and edge:
        # The pinned fixture's old single column is 18px; a more square
        # multi-column alternative must not replace it with a smaller size.
        assert before.vertical and before.font_size >= .5 * region['font_size']
        assert after.font_size >= before.font_size
    elif language == 'ar':
        # Mask shrinking also rescues the disabled-word-wrap control. Its
        # different breaks are no longer a smaller-font baseline; measure
        # the shaped, whole-word layout against its actual safe font budget.
        assert_maximum_scaled_font(after, erode_bubble_mask(mask, .02))
    else:
        assert after.font_size > before.font_size
    if language == 'ko' and not edge:
        assert before.vertical and '[BR]' not in before.translation
        assert after.vertical and '[BR]' in after.translation
    if len(text.split()) == 1:
        from manga_translator.rendering.rich_text import legacy_line_breaks_to_document
        # A long rich horizontal word can legitimately continue across native
        # vertical columns, but only BR may be inserted and direction stays v.
        assert before.vertical and '[BR]' not in before.translation
        assert after.vertical and '[BR]' in after.translation
        assert after.translation.replace('[BR]', '') == text
        # Native painting normalizes the new BR text to a document; it must
        # not retain the original unbroken horizontal rich paragraph.
        assert after.translation_rich == legacy_line_breaks_to_document(after.translation).to_dict()
    assert 1 <= len(candidates) <= 3  # h, original v, at most one reflowed v.
    assert len([shape for shape in rectangles if shape != image.shape[:2]]) == 1
    maximum = native._apply_final_font_constraints(region['font_size'], configuration())
    assert after.font_size <= maximum
    assert all(candidate.font_size <= maximum for candidate in candidates)
    restored = re.sub(r'-\[BR\]', '', after.translation).replace('[BR]', '')
    assert ''.join(restored.split()) == ''.join(text.split())
    if language == 'ar':
        assert after.horizontal and all(candidate.horizontal for candidate in candidates)
        assert after.translation.replace('[BR]', ' ').split() == text.split()
    points = after.dst_points.reshape(-1, 2)
    assert np.isfinite(points).all()
    assert (points >= (1, 1)).all() and (points <= (399, 439)).all()
    inset = erode_bubble_mask(mask, .02)
    assert native._polygon_fully_inside_mask(points, inset)
    painted = np.any(output != image, axis=2)
    assert painted.any() and not np.any(painted & (inset == 0))


@pytest.mark.parametrize(('text', 'whole_words'), [
    ('Astral 😀 characters remain intact.', False),
    ('E\u0301clair cafe\u0301 déjà vu', True),
    ('Family 👨\u200d👩\u200d👧\u200d👦 together', False),
    ('لم أنته بعد من التقرير الذي يجب تسليمه غدا!', True),
    ('A\u00a0B stay together', False),
])
def test_qt_word_recovery_preserves_utf16_graphemes_and_shaped_words(
        bubble_layout, text, whole_words):
    from PyQt6.QtCore import QTextBoundaryFinder
    from mtu_engine.layout import _wrap_words
    renderer, _, native = bubble_layout
    native.text_render.set_font(renderer.fonts[0])
    wrapped = _wrap_words(text, 28, 45, 1.0)
    assert '[BR]' in wrapped
    assert ''.join(wrapped.replace('[BR]', '').split()) == ''.join(text.split())
    boundaries = QTextBoundaryFinder(QTextBoundaryFinder.BoundaryType.Grapheme, text)
    position = 0
    for line in wrapped.split('[BR]'):
        start = text.index(line, position)
        assert not text[position:start].strip()
        position = start + len(line)
        for boundary in (start, position):
            boundaries.setPosition(len(text[:boundary].encode('utf-16-le')) // 2)
            assert boundaries.isAtBoundary()
    assert not text[position:].strip()
    if whole_words:
        assert wrapped.replace('[BR]', ' ').split() == text.split()
    if '\u00a0' in text:
        assert 'A\u00a0B' in wrapped  # A no-break space is not a permitted line boundary.


@pytest.mark.parametrize(('language', 'text'), [
    ('en', 'Extraordinary E\u0301clair circumstances'),
    ('fr', 'Extraordinaire A\u200dB maintenant'),
    ('en', 'Extraordinary سلام circumstances'),
])
def test_complex_text_recovery_uses_qt_words_not_codepoint_hyphenation(
        bubble_layout, monkeypatch, language, text):
    from mtu_engine import layout
    from manga_translator.rendering import auto_linebreak
    from manga_translator.utils import TextBlock, erode_bubble_mask
    renderer, observed, native = bubble_layout
    image = np.full((440, 260, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[30:410, 108:152] = 255
    region = serialize_region(TextBlock([[[116, 45], [144, 45], [144, 395], [116, 395]]],
        ['source'], font_size=28, direction='v'))
    calls, wrap = [], layout._wrap_words

    def record_wrap(value, *args):
        calls.append(value)
        return wrap(value, *args)

    monkeypatch.setattr(layout, '_wrap_words', record_wrap)
    monkeypatch.setattr(auto_linebreak, '_layout_horizontal_eng',
        lambda *args, **kwargs: pytest.fail('Complex text must not use codepoint hyphenation fallback'))
    output = renderer.render(image, image, [region], [text], language, mask)
    block = observed.pop()
    assert calls == [text]  # Recovery ran, rather than passing via the ordinary fast path.
    assert block.horizontal
    assert block.translation.replace('[BR]', ' ').split() == text.split()
    np.testing.assert_array_equal(block.lines, np.asarray(region['lines']))
    inset = erode_bubble_mask(mask, .02)
    assert native._polygon_fully_inside_mask(block.dst_points[0], inset)
    painted = np.any(output != image, axis=2)
    assert painted.any() and not np.any(painted & (inset == 0))


def _shared_reflow_page(source_sizes=(28, 19)):
    """A generic L-shaped bubble, not a private page or translated checkpoint."""
    from manga_translator.utils import TextBlock
    image = np.full((320, 280, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[25:250, 75:230] = 255
    mask[170:250, 25:220] = 255
    lines = [
        [[[130, 80], [215, 80], [215, 230], [130, 230]]],
        [[[40, 180], [59, 180], [59, 240], [40, 240]]],
    ]
    regions = [serialize_region(TextBlock(value, ['source'], font_size=size, direction='v'))
               for value, size in zip(lines, source_sizes)]
    texts = ['The library is open from nine until six.',
             'Ask the receptionist about the updated timetable.']
    return image, mask, regions, texts


def _assert_shared_reflow_pixels(image, output, mask, regions, texts, observed, native):
    from manga_translator.utils import erode_bubble_mask
    from mtu_engine.engine import configuration
    by_source = {tuple(np.asarray(block.lines).ravel()): block for block in observed}
    assert len(by_source) == len(regions)
    blocks = [by_source[tuple(np.asarray(region['lines']).ravel())] for region in regions]
    inset = erode_bubble_mask(mask, .02)
    for i, (block, region, text) in enumerate(zip(blocks, regions, texts)):
        assert block.original_font_size == region['font_size']
        assert 0 < block.font_size <= native._apply_final_font_constraints(
            region['font_size'], configuration())
        restored = re.sub(r'-\[BR\]', '', block.translation).replace('[BR]', '')
        assert ''.join(restored.split()) == ''.join(text.replace('[BR]', '').split())
        np.testing.assert_array_equal(block.lines, np.asarray(region['lines']))
        vertices = block.dst_points.reshape(-1, 2)
        assert np.isfinite(vertices).all() and (vertices >= (1, 1)).all()
        assert (vertices <= (image.shape[1]-1, image.shape[0]-1)).all()
        assert native._polygon_fully_inside_mask(vertices, inset)
        assert all(not native._polygons_overlap(block.dst_points, other.dst_points)
                   for other in blocks[i+1:])
    painted = np.any(output != image, axis=2)
    assert painted.any() and not np.any(painted & (inset == 0))
    return blocks


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize(('language', 'texts', 'source_sizes'), [
    ('en', None, (28, 19)),
    ('en', None, (26, 20)),
    ('fr', ['La bibliothe\u0300que ouvre chaque jour a\u0300 neuf heures.',
            'Le calendrier de\u0301taille les horaires de chaque atelier.'], (28, 19)),
    ('ar', ['تفتح المكتبة في التاسعة كل صباح.',
            'يرجى مراجعة الجدول لمعرفة مواعيد الأنشطة خلال الأسبوع القادم.'], (28, 19)),
])
def test_shared_bubble_reflow_balances_source_sizes_without_splitting_shaped_words(
        bubble_layout, monkeypatch, reverse, language, texts, source_sizes):
    from mtu_engine.engine import configuration
    renderer, observed, native = bubble_layout
    image, mask, regions, defaults = _shared_reflow_page(source_sizes)
    texts = defaults if texts is None else texts
    if reverse:
        regions, texts = regions[::-1], texts[::-1]
    snapshot = json.loads(json.dumps(regions))
    rectangles, candidates = [], []
    rectangle, resize = native.find_largest_inscribed_rect, native.resize_regions_to_font_size

    def counted_rectangle(value):
        if value.shape != image.shape[:2]:
            rectangles.append(value.shape)
        return rectangle(value)

    def counted_resize(*args, **kwargs):
        result = resize(*args, **kwargs)
        if not args[2].render.balloon_fill_mask_layout:
            candidates.extend(args[1])
        return result

    monkeypatch.setattr(native, 'find_largest_inscribed_rect', counted_rectangle)
    monkeypatch.setattr(native, 'resize_regions_to_font_size', counted_resize)
    outputs = []
    for cache_bytes in (0, None):
        observed.clear()
        rectangles.clear()
        candidates.clear()
        output = renderer.render(image, image, regions, texts, language, mask,
                                 mask_cache_bytes=cache_bytes)
        blocks = _assert_shared_reflow_pixels(image, output, mask, regions, texts, observed, native)
        # Compare final rendered sizes with the same final-scale constraint;
        # the native integer rounding is not a raw 75% source-size promise.
        assert all(block.font_size >= native._apply_final_font_constraints(
            .75 * region['font_size'], configuration()) for block, region in zip(blocks, regions))
        assert all(block.horizontal for block in blocks)
        # Either shared-cell axis is valid, but its source order must survive.
        ordered_axes = []
        for axis in (0, 1):
            source_order = sorted(blocks, key=lambda block:
                np.asarray(block.lines)[..., axis].mean())
            if (source_order[0].dst_points[..., axis].max() <
                    source_order[1].dst_points[..., axis].min()):
                ordered_axes.append(axis)
        assert ordered_axes
        assert len(rectangles) <= 6  # Two ordinary ROIs + at most two two-cell plans.
        assert len(candidates) <= 22  # Six ordinary fits + four shared cells with at most four modes.
        if language == 'en':
            # Independent fitting leaves this caption below the threshold.
            # This positive reflow fixture must also exceed the raw threshold.
            assert min(block.font_size / region['font_size']
                       for block, region in zip(blocks, regions)) >= .75
            assert 1 in ordered_axes  # Retain explicit top-to-bottom coverage.
            assert len(rectangles) >= 2  # Exercise actual joint allocation, not a fast-path case.
        else:
            assert all(block.horizontal for block in candidates)
            for block, text in zip(blocks, texts):
                assert block.translation.replace('[BR]', ' ').split() == text.split()
        assert regions == snapshot
        outputs.append(output)
    np.testing.assert_array_equal(outputs[0], outputs[1])


@pytest.mark.parametrize('boundary', ['hole', 'edge', 'occupied'])
def test_shared_bubble_reflow_respects_holes_page_edges_and_external_paragraphs(
        bubble_layout, boundary):
    from manga_translator.utils import TextBlock
    renderer, observed, native = bubble_layout
    image, mask, regions, texts = _shared_reflow_page()
    if boundary == 'hole':
        mask[110:130, 90:108] = 0
    elif boundary == 'edge':
        mask[:, :-25] = mask[:, 25:]
        mask[:, -25:] = 0
        for region in regions:
            points = np.asarray(region['lines'])
            points[..., 0] -= 25
            region['lines'] = points.tolist()
    else:
        free = serialize_region(TextBlock([[[190, 190], [205, 190], [205, 205], [190, 205]]],
            ['outside the pair'], font_size=12, direction='h'))
        free['bubble_enclosed'] = False
        regions.append(free)
        texts.append('!')
    snapshot = json.loads(json.dumps(regions))
    output = renderer.render(image, image, regions, texts, 'en', mask)
    _assert_shared_reflow_pixels(image, output, mask, regions, texts, observed, native)
    assert regions == snapshot


@pytest.mark.parametrize('explicit', [False, True])
def test_shared_bubble_reflow_preserves_normal_pairs_and_explicit_breaks(
        bubble_layout, monkeypatch, explicit):
    from manga_translator.utils import TextBlock
    renderer, observed, native = bubble_layout
    image = np.full((320, 380, 3), 255, np.uint8)
    mask = np.zeros(image.shape[:2], np.uint8)
    mask[20:300, 20:360] = 255
    lines = [[[[40, 50], [160, 50], [160, 130], [40, 130]]],
             [[[190, 170], [330, 170], [330, 260], [190, 260]]]]
    regions = [serialize_region(TextBlock(value, ['source'], font_size=size, direction='h'))
               for value, size in zip(lines, (28, 19))]
    texts = (['This is a deliberately long explicit first line[BR]Follow the existing break.',
              'Keep this existing[BR]paragraph as written.'] if explicit else
             ['Hello there!', 'See you soon.'])
    candidates, resize = [], native.resize_regions_to_font_size

    def record(*args, **kwargs):
        result = resize(*args, **kwargs)
        if not args[2].render.balloon_fill_mask_layout:
            candidates.extend(args[1])
        return result

    monkeypatch.setattr(native, 'resize_regions_to_font_size', record)
    output = renderer.render(image, image, regions, texts, 'en', mask)
    blocks = _assert_shared_reflow_pixels(image, output, mask, regions, texts, observed, native)
    # The ordinary pass may resolve initially overlapping native boxes. Neither
    # case needs extra shared-cell fitting beyond one horizontal fit per block.
    assert len(candidates) <= len(regions)
    if explicit:
        assert min(block.font_size / region['font_size']
                   for block, region in zip(blocks, regions)) < .75
        assert [block.translation for block in blocks] == texts
    else:
        assert all(block.font_size >= .75 * region['font_size']
                   for block, region in zip(blocks, regions))


def test_shared_bubble_reflow_rolls_back_both_paragraphs_without_a_joint_gain(
        bubble_layout, monkeypatch):
    renderer, observed, native = bubble_layout
    image, mask, regions, texts = _shared_reflow_page()
    snapshot = json.loads(json.dumps(regions))
    rectangle = native.find_largest_inscribed_rect
    # Keep the native initial layouts but make every optional recovery budget
    # empty. This gives the fallback pixels without another layout implementation.
    with monkeypatch.context() as unavailable:
        unavailable.setattr(native, 'find_largest_inscribed_rect', lambda value:
            rectangle(value) if value.shape == image.shape[:2] else (0, 0, 0, 0))
        expected = renderer.render(image, image, regions, texts, 'en', mask)
    baseline = [(block.font_size, block.translation, block.dst_points.copy()) for block in observed]
    observed.clear()
    candidates, resize = [], native.resize_regions_to_font_size

    def undersized_caption(*args, **kwargs):
        result = resize(*args, **kwargs)
        if not args[2].render.balloon_fill_mask_layout:
            for block in args[1]:
                candidates.append(block.original_font_size)
                if block.original_font_size == regions[1]['font_size']:
                    block.font_size = 1  # Main-paragraph changes alone cannot commit a pair.
        return result

    monkeypatch.setattr(native, 'resize_regions_to_font_size', undersized_caption)
    actual = renderer.render(image, image, regions, texts, 'en', mask)
    assert set(candidates) == {region['font_size'] for region in regions}
    np.testing.assert_array_equal(actual, expected)
    for block, (size, text, polygon) in zip(observed, baseline):
        assert (block.font_size, block.translation) == (size, text)
        np.testing.assert_array_equal(block.dst_points, polygon)
    assert regions == snapshot
