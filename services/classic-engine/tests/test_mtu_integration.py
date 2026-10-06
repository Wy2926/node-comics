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


def test_cuda_models_warmup_and_local_inpaint_offline(assets, offline, monkeypatch):
    models, fonts = assets
    engine = Engine(models, fonts)
    try:
        engine.warmup()
        assert engine.ocr.session.get_providers()[0] == 'CUDAExecutionProvider'
        assert int(engine.ocr.session.get_provider_options()['CUDAExecutionProvider']['device_id']) == engine.gpu
        assert engine.ocr.session.get_session_options().intra_op_num_threads == 2
        # Known line geometry isolates recognition from detector crop failures.
        import asyncio
        from PIL import Image, ImageDraw, ImageFont
        from manga_translator.utils import Quadrilateral
        font = ImageFont.truetype(str(models.parent / 'fonts/NotoSansCJKsc-Regular.otf'), 36)
        for text in ('WHERE ARE YOU GOING?', '明日はきっと晴れる。', '曾經有一名偉大的魔術師'):
            image = Image.new('RGB', (600, 100), 'white')
            draw = ImageDraw.Draw(image)
            draw.text((12, 8), text, font=font, fill='black')
            x1, y1, x2, y2 = draw.textbbox((12, 8), text, font=font)
            line = Quadrilateral(np.array([[x1-3,y1-3],[x2+3,y1-3],[x2+3,y2+3],[x1-3,y2+3]]), '', 1)
            asyncio.run(engine.ocr.recognize(np.array(image), [line], engine.config.ocr))
            assert ''.join(line.text.split()) == ''.join(text.split())
        # Exercise the real detector at the page boundary and cross the old
        # 16+remainder batch boundary without changing ORT convolution shapes.
        shapes = []
        infer = engine.ocr.session.run
        def capture(outputs, feed, *args, **kwargs):
            shapes.append(next(iter(feed.values())).shape)
            return infer(outputs, feed, *args, **kwargs)
        monkeypatch.setattr(engine.ocr.session, 'run', capture)
        edge_font = ImageFont.truetype(str(models.parent / 'fonts/NotoSans-Regular.ttf'), 26)
        sentence = 'BUT UNLIKE ME'
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
        assert len(shapes) >= 21
        assert set(shapes) == {(1, 3, 48, 320)}
        source = np.full((256, 256, 3), 220, dtype=np.uint8)
        source[110:135, 110:135] = 0
        mask = np.zeros(source.shape[:2], dtype=np.uint8)
        mask[100:145, 100:145] = 255
        cleaned = engine.inpaint(source, mask, mask, np.zeros_like(mask), [])
        assert cleaned.shape == source.shape and cleaned.dtype == np.uint8
        assert np.array_equal(cleaned[mask == 0], source[mask == 0])
        assert np.any(cleaned[mask != 0] != source[mask != 0])
    finally:
        engine.close()


def test_missing_cuda_fails_before_loading_an_alternate_backend(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, 'is_available', lambda: False)
    with pytest.raises(RuntimeError, match='NVIDIA CUDA GPU is required'):
        Engine('missing', [])


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
