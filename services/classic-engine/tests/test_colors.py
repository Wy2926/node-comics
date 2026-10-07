"""Color adapter wiring and bounded crops; no neural model or CUDA execution."""
import json
import sys
from types import SimpleNamespace

import numpy as np
import pytest

from mtu_engine.colors import Colors
from mtu_engine.engine import serialize_region
from mtu_engine.ocr import OCR_BATCH_SIZE, OCR_MAX_WIDTH


def region(lines):
    value = SimpleNamespace(lines=lines, texts=['original OCR'], text='original OCR', updates=[])
    def set_colors(fg, bg):
        value.fg_colors, value.bg_colors = fg, bg
        value.updates.clear()
    value.set_font_colors = set_colors
    value.update_font_colors = lambda fg, bg: value.updates.append((fg.tolist(), bg.tolist()))
    return value


@pytest.fixture
def colors(monkeypatch):
    native = SimpleNamespace(_get_rotate_crop_image=lambda image, points: points)
    monkeypatch.setitem(sys.modules, 'manga_translator.ocr.model_paddleocr',
                        SimpleNamespace(ModelPaddleOCR=lambda: native))
    monkeypatch.setitem(sys.modules, 'manga_translator.utils', SimpleNamespace(
        chunks=lambda items, size: (items[i:i+size] for i in range(0, len(items), size))))
    model = SimpleNamespace(model=object(), device='cuda', use_gpu=True)
    adapter = Colors(model)
    assert adapter.predictor.color_model is model.model
    assert adapter.predictor.device == 'cuda' and adapter.predictor.use_gpu
    return adapter, native


def test_native_prediction_receives_bounded_bgr_crops_and_preserves_ocr(colors):
    adapter, native = colors
    first = region([np.full((48, 120, 3), [20, 70, 180], dtype=np.uint8)] * (OCR_BATCH_SIZE + 1))
    second = region([np.full((48, 220, 3), [180, 30, 40], dtype=np.uint8)] * OCR_BATCH_SIZE)
    sizes = []
    def predict(crops):
        sizes.append(len(crops))
        return [(*crop[0, 0, ::-1].tolist(), 90, 100, 110) for crop in crops]
    native._estimate_colors_batch = predict
    adapter.apply(None, [first, second])
    assert sizes == [OCR_BATCH_SIZE, OCR_BATCH_SIZE, 1]
    assert first.updates == [([20, 70, 180], [90, 100, 110])] * len(first.lines)
    assert second.updates == [([180, 30, 40], [90, 100, 110])] * len(second.lines)
    assert first.texts == second.texts == ['original OCR']
    assert first.text == second.text == 'original OCR'
    adapter.apply(None, [first])
    assert len(first.updates) == len(first.lines)


def test_invalid_crops_use_native_default_without_losing_other_lines(colors):
    adapter, native = colors
    block = region([None, np.zeros((0, 20, 3), dtype=np.uint8),
                    np.zeros((48, OCR_MAX_WIDTH + 1, 3), dtype=np.uint8),
                    np.zeros((48, 100, 3), dtype=np.uint8)])
    def predict(crops):
        assert len(crops) == 1
        return [(200, 50, 60, 70, 80, 90)]
    native._estimate_colors_batch = predict
    adapter.apply(None, [block])
    assert block.updates == [([0, 0, 0], [255, 255, 255])] * 3 + [([200, 50, 60], [70, 80, 90])]
    assert len(block.lines) == 4 and block.text == 'original OCR'


def test_empty_regions_do_not_crop_or_predict_and_close_releases_reference(colors):
    adapter, native = colors
    native._get_rotate_crop_image = lambda *args: pytest.fail('empty crop')
    native._estimate_colors_batch = lambda *args: pytest.fail('empty prediction')
    adapter.apply(None, [])
    adapter.close()
    assert adapter.predictor is None


def test_color_checkpoint_preserves_raw_style_without_contrast_adjustment():
    block = SimpleNamespace(lines=np.zeros((1, 4, 2)), texts=['source'], font_size=36,
        angle=0, fg_colors=np.array([210, 40, 60]), bg_colors=np.array([120, 120, 120]),
        prob=.9, _direction='h', default_stroke_width=.1, adjust_bg_color=False,
        line_spacing=1., letter_spacing=1.)
    restored = json.loads(json.dumps(serialize_region(block)))
    assert restored['fg_color'] == [210, 40, 60]
    assert restored['bg_color'] == [120, 120, 120]
    assert restored['default_stroke_width'] == .1
    assert restored['adjust_bg_color'] is False


def test_color_assets_are_pinned():
    from mtu_engine.assets import LOCK
    models = {item['file']: item for item in LOCK['models']}
    assert models['ocr/ocr_ar_48px.ckpt']['sha256'] == '29daa46d080818bb4ab239a518a88338cbccff8f901bef8c9db191a7cb97671d'
    assert models['ocr/alphabet-all-v7.txt']['sha256'] == 'f5722368146aa0fbcc9f4726866e4efc3203318ebb66c811d8cbbe915576538a'
