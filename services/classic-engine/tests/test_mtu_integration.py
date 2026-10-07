"""Real Qt and CUDA acceptance; opt in with a prepared MTU_TEST_ASSETS directory."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import socket

import numpy as np
import pytest

from classic_node.runtime import LANGUAGE_PROBES
from mtu_engine.engine import Engine, Renderer, serialize_region
from mtu_engine.ocr import OCR_BATCH_SIZE, OCR_IMAGE_SHAPE, OCR_MAX_WIDTH


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
        english = Paddle(models, 'en', 0, 2)
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


@pytest.mark.parametrize('enclosed', [False, True])
@pytest.mark.parametrize('fg,bg', [([235, 35, 60], [80, 80, 80]), ([245, 245, 245], [20, 40, 130]),
                                  ([210, 40, 60], [205, 38, 58])])
def test_qt_retains_predicted_fill_and_stroke_through_checkpoint(assets, offline, enclosed, fg, bg):
    models, fonts = assets
    renderer = Renderer(models, fonts)
    from manga_translator.utils import TextBlock
    block = TextBlock([[[100, 80], [500, 80], [500, 210], [100, 210]]], ['source'],
        font_size=48, fg_color=fg, bg_color=bg, default_stroke_width=.1, adjust_bg_color=False)
    data = json.loads(json.dumps(serialize_region(block)))
    restored = TextBlock(**data)
    assert restored.get_font_colors() == (tuple(fg), tuple(bg))
    assert restored.stroke_width == .1 and not restored.adjust_bg_color
    cleaned = np.full((300, 600, 3), [240, 220, 190], dtype=np.uint8)
    bubble = np.zeros(cleaned.shape[:2], dtype=np.uint8)
    if enclosed:
        bubble[30:260, 40:560] = 255
    result = renderer.render(cleaned, cleaned, [data], ['COLOR TEST'], 'en', bubble)
    assert np.count_nonzero(np.all(result == fg, axis=2)) > 20
    assert np.count_nonzero(np.all(result == bg, axis=2)) > 20
    assert data['fg_color'] == fg and data['bg_color'] == bg


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


def test_native_color_aggregation_preserves_raw_channels(assets):
    from mtu_engine.assets import activate
    models, _ = assets
    activate(models)
    from manga_translator.utils import TextBlock
    from mtu_engine.colors import Colors
    from types import SimpleNamespace
    predictor = SimpleNamespace(_get_rotate_crop_image=lambda *args: np.zeros((48, 100, 3), dtype=np.uint8),
        _estimate_colors_batch=lambda crops: [(180, 20, 40, 80, 80, 80), (220, 40, 60, 120, 120, 120)])
    colors = Colors.__new__(Colors)
    colors.predictor = predictor
    block = TextBlock([[[0, 0], [100, 0], [100, 48], [0, 48]]] * 2, ['first', 'second'],
                      adjust_bg_color=False)
    colors.apply(None, [block])
    assert block.get_font_colors() == ((200., 30., 50.), (100., 100., 100.))
    assert block.texts == ['first', 'second']


def test_native_48px_colors_and_failure_fallback_offline(assets, offline, monkeypatch):
    import asyncio
    import torch
    from PIL import Image, ImageDraw, ImageFont
    from mtu_engine.colors import Colors
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
                          ['selected OCR text'], adjust_bg_color=False)
        colors.apply(np.array(image), [block])
        fg, bg = block.get_font_colors()
        np.testing.assert_allclose(fg, [235, 35, 60], atol=35, rtol=0)
        np.testing.assert_allclose(bg, [80, 80, 80], atol=35, rtol=0)
        assert block.texts == ['selected OCR text']
        def failed(*args, **kwargs):
            raise RuntimeError('Injected color prediction failure')
        monkeypatch.setattr(native.model, 'infer_beam_batch_tensor', failed)
        colors.apply(np.array(image), [block])
        assert block.get_font_colors() == ((0., 0., 0.), (255., 255., 255.))
        assert block.texts == ['selected OCR text']
    finally:
        colors.close()
        asyncio.run(native.unload())


def test_cuda_models_warmup_and_local_inpaint_offline(assets, offline, monkeypatch):
    models, fonts = assets
    engine = Engine(models, fonts)
    try:
        engine.warmup()
        for probe in engine.probes.values():
            assert probe.session.get_providers()[0] == 'CUDAExecutionProvider'
            assert int(probe.session.get_provider_options()['CUDAExecutionProvider']['device_id']) == engine.gpu
            assert probe.session.get_session_options().intra_op_num_threads == 2
        assert engine.recognizers['ch'].model.device.type == 'cuda'
        assert engine.japanese.model.model.device.type == 'cuda'
        assert engine.color_model.use_gpu
        assert next(engine.color_model.model.parameters()).device.type == 'cuda'
        assert engine.colors.predictor.color_model is engine.color_model.model
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
            assert engine.router.classify(np.array(image), [block]) == [language]
            line = Quadrilateral(quad, '', 1)
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
        assert sum(shape[0] for shape in shapes) >= 21  # Includes representative-line probes.
        assert all(1 <= shape[0] <= OCR_BATCH_SIZE and shape[1:3] == OCR_IMAGE_SHAPE[:2] and
                   OCR_IMAGE_SHAPE[2] <= shape[3] <= OCR_MAX_WIDTH for shape in shapes)
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
                    assert edge_mask is not None and edge_mask[-8:].any()
        assert all(1 <= shape[0] <= OCR_BATCH_SIZE and shape[1:3] == OCR_IMAGE_SHAPE[:2] and
                   OCR_IMAGE_SHAPE[2] <= shape[3] <= OCR_MAX_WIDTH for shape in shapes)
    finally:
        engine.close()


def test_missing_cuda_fails_before_loading_an_alternate_backend(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, 'is_available', lambda: False)
    with pytest.raises(RuntimeError, match='NVIDIA CUDA GPU is required'):
        Engine('missing', [])


def test_long_lines_and_partial_ocr_continue_at_different_positions(assets, offline, monkeypatch):
    from PIL import Image, ImageDraw, ImageFont
    models, fonts = assets
    engine = Engine(models, fonts)
    sentences = ['We read a new story together at the library.',
                 'The evening sky was full of distant stars.',
                 'Our next adventure begins early tomorrow.']
    font = ImageFont.truetype(str(models.parent / 'fonts/NotoSans-Regular.ttf'), 24)
    recognize = engine.recognizers['en'].recognize
    failure = None

    async def incomplete(*args, **kwargs):
        result = await recognize(*args, **kwargs)
        for line in args[1]:
            if failure == 'all-empty' or (failure and 'evening' in line.text):
                # The OCR adapter already drops text below its line threshold.
                line.text = ''
                line.prob = 0.1 if failure == 'low-confidence' else 0.0
        return result

    monkeypatch.setattr(engine.recognizers['en'], 'recognize', incomplete)
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
    ('Lalezar-Regular.ttf', 'Lalezar'),
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
    from manga_translator.utils import TextBlock
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
    # A narrow CJK source box must not force one tiny word per line forever.
    assert observed[0].font_size >= 26
    assert observed[0].translation.count('[BR]') < (4 if language == 'vi' else 8)


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
