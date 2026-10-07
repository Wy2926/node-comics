"""Color adapter wiring and bounded crops; no neural model or CUDA execution."""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

import numpy as np
import pytest

from mtu_engine.colors import Colors, _CpuColorModel, ensure_stroke_contrast
from mtu_engine.engine import serialize_region
from mtu_engine.ocr import OCR_BATCH_SIZE, OCR_MAX_WIDTH


def region(lines, texts=None, language='unknown'):
    value = SimpleNamespace(lines=lines, texts=texts if texts is not None else ['original OCR'],
                            text='original OCR', language=language, updates=[])
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
    model = SimpleNamespace(model=SimpleNamespace(dictionary=['<S>', 'A', '</S>']), device='cuda', use_gpu=True)
    adapter = Colors(model)
    assert adapter.predictor.color_model.model is model.model
    assert adapter.predictor.color_model.dictionary is model.model.dictionary
    assert adapter.predictor.device == 'cuda' and adapter.predictor.use_gpu
    return adapter, native


def test_color_model_returns_detached_cpu_tensors_without_changing_inference(colors):
    torch = pytest.importorskip('torch')
    adapter, native = colors
    proxy = native.color_model
    indices = torch.tensor([1, 2], dtype=torch.int64)
    # Boundary-adjacent values keep dtype and exact bits: no color re-rounding.
    channels = torch.tensor([[89.99 / 255, 90 / 255, 1.], [0., .5, .25]], requires_grad=True)
    flags = torch.tensor([[1., 0.], [0., 1.]], requires_grad=True)
    predictions = [(indices, .95, channels, channels + .1, flags, flags + .1)]
    calls = []

    def infer(*args, **kwargs):
        calls.append((args, kwargs))
        return predictions

    proxy.model.infer_beam_batch_tensor = infer
    pixels, widths = object(), [240]
    for _ in range(2):
        result = proxy.infer_beam_batch_tensor(pixels, widths, beams_k=5, max_seq_length=255)
        assert result[0][1] is predictions[0][1]
        for original, actual in zip(predictions[0], result[0], strict=True):
            if torch.is_tensor(original):
                assert actual.device.type == 'cpu' and not actual.requires_grad
                assert actual.dtype == original.dtype and torch.equal(actual, original)
        # No result cache: the second call must use the model's next predictions.
        predictions = [(indices, .8, channels + .2, channels + .3, flags, flags)]
    assert len(calls) == 2
    assert all(args == (pixels, widths) and kwargs == {'beams_k': 5, 'max_seq_length': 255}
               for args, kwargs in calls)
    assert proxy.model.infer_beam_batch_tensor is infer
    assert channels.requires_grad and flags.requires_grad


def test_color_model_preserves_native_exception_for_upstream_fallback(colors, monkeypatch):
    _, native = colors
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(is_tensor=lambda value: False))
    failure = RuntimeError('fixture inference failure')
    calls = []

    def fail(*args, **kwargs):
        calls.append(True)
        raise failure

    native.color_model.model.infer_beam_batch_tensor = fail
    with pytest.raises(RuntimeError) as caught:
        native.color_model.infer_beam_batch_tensor(object(), [240], beams_k=5, max_seq_length=255)
    assert caught.value is failure and len(calls) == 1
    assert not native.color_model._lock.locked()


@pytest.mark.parametrize('fail_transfer', [False, True])
def test_color_model_keeps_cpu_transfer_inside_lock_and_releases_on_failure(monkeypatch, fail_transfer):
    failure = RuntimeError('fixture transfer failure')

    class Tensor:
        def detach(self):
            assert proxy._lock.locked()
            return self

        def cpu(self):
            assert proxy._lock.locked()
            if fail_transfer:
                raise failure
            return 'cpu result'

    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(is_tensor=lambda value: isinstance(value, Tensor)))
    proxy = _CpuColorModel(SimpleNamespace(infer_beam_batch_tensor=lambda: [(Tensor(), .9)]))
    if fail_transfer:
        with pytest.raises(RuntimeError) as caught:
            proxy.infer_beam_batch_tensor()
        assert caught.value is failure
    else:
        assert proxy.infer_beam_batch_tensor() == [('cpu result', .9)]
    assert not proxy._lock.locked()


def test_contrast_guard_import_does_not_load_torch_in_cpu_render_workers():
    subprocess.run([sys.executable, '-c',
        "import sys; from mtu_engine.colors import ensure_stroke_contrast; assert 'torch' not in sys.modules"],
        check=True, capture_output=True, text=True)


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


@pytest.fixture
def text_colors(monkeypatch):
    calls, requests = [], []

    class Predictor:
        def _get_rotate_crop_image(self, image, points):
            return points

        def _estimate_colors_batch(self, crops):
            requests.append(self)
            return self.color_model.infer_beam_batch_tensor(crops, [crop.shape[1] for crop in crops],
                                                           beams_k=5, max_seq_length=255)

    monkeypatch.setitem(sys.modules, 'manga_translator.ocr.model_paddleocr',
                        SimpleNamespace(ModelPaddleOCR=Predictor))
    monkeypatch.setitem(sys.modules, 'manga_translator.utils', SimpleNamespace(
        chunks=lambda items, size: (items[i:i+size] for i in range(0, len(items), size))))
    dictionary = ['<PAD>', '<S>', '</S>', '<SP>', 'A', 'B', '中', '文', '日', '本', '한']
    adapter = Colors(SimpleNamespace(model=SimpleNamespace(dictionary=dictionary), device='cuda', use_gpu=True))
    model = adapter.predictor.color_model

    def predict(pixels, widths, **kwargs):
        calls.append((pixels, widths, kwargs))
        return [(*crop[0, 0, ::-1].tolist(), 90, 100, 110) for crop in pixels]

    # This fixture tests request wiring, not tensor inference (covered separately).
    model.infer_with_text = predict
    model.infer_beam_batch_tensor = predict
    return adapter, model, calls, requests


@pytest.mark.parametrize('language,text,tokens', [
    ('en', 'A B', [4, 3, 5]), ('ch', '中文', [6, 7]), ('japan', '日本', [8, 9]),
    ('korean', '한', [10]), ('en', ' A ', [3, 4, 3]), ('en', 'A' * 255, [4] * 255),
])
def test_aligned_text_reuses_native_aggregation_with_request_local_tokens(text_colors, language, text, tokens):
    adapter, model, calls, requests = text_colors
    crop = np.full((48, 120, 3), [210, 30, 50], dtype=np.uint8)
    block = region([crop], [text], language)
    adapter.apply(None, [block])
    assert calls[0][2] == {'text_indices': [tokens], 'beams_k': 5, 'max_seq_length': 255}
    assert requests[0] is not adapter.predictor
    assert requests[0].device == 'cuda' and requests[0].use_gpu
    assert requests[0].color_model.dictionary is model.dictionary
    assert adapter.predictor.color_model is model
    assert block.updates == [([210, 30, 50], [90, 100, 110])]
    assert block.texts == [text] and block.text == 'original OCR'


@pytest.mark.parametrize('language,texts,count', [
    ('japan', ['日本', ''], 2),  # Paragraph text must not condition the first line.
    ('japan', ['日', '本'], 2), ('unknown', ['A'], 1),
    ('en', ['A'], 2), ('en', [''], 1), ('en', ['   '], 1),
    ('en', ['A😀B'], 1), ('en', ['A\nB'], 1), ('en', ['A' * 256], 1),
])
def test_unaligned_or_unrepresentable_text_keeps_native_fallback(text_colors, language, texts, count):
    adapter, model, calls, requests = text_colors
    block = region([np.zeros((48, 120, 3), dtype=np.uint8)] * count, texts, language)
    adapter.apply(None, [block])
    assert len(calls) == 1 and 'text_indices' not in calls[0][2]
    assert requests == [adapter.predictor] and adapter.predictor.color_model is model
    assert block.texts == texts and len(block.updates) == count


def test_mixed_texts_invalid_crops_and_multiple_owners_stay_aligned(text_colors):
    adapter, _, calls, _ = text_colors
    red = np.full((48, 100, 3), [200, 30, 40], dtype=np.uint8)
    blue = np.full((48, 300, 3), [20, 40, 220], dtype=np.uint8)
    first = region([None, red, blue], ['A', 'B', ''], 'en')
    second = region([red, blue], ['A', '😀'], 'en')
    adapter.apply(None, [first, second])
    assert len(calls) == 1  # Do not repad known/fallback groups separately.
    assert calls[0][1] == [100, 300, 100, 300]
    assert calls[0][2]['text_indices'] == [[5], None, [4], None]
    assert first.updates == [([0, 0, 0], [255, 255, 255]),
                             ([200, 30, 40], [90, 100, 110]), ([20, 40, 220], [90, 100, 110])]
    assert second.updates == first.updates[1:]


def test_text_context_is_isolated_between_pages(text_colors):
    adapter, model, _, requests = text_colors
    entered = Barrier(2, timeout=5)

    def predict(pixels, widths, *, text_indices, **kwargs):
        entered.wait()
        assert adapter.predictor.color_model is model
        return [(text_indices[0][0], 0, 0, 255, 255, 255)]

    model.infer_with_text = predict
    blocks = [region([np.zeros((48, 120, 3), dtype=np.uint8)], [text], 'en') for text in ('A', 'B')]
    with ThreadPoolExecutor(2) as workers:
        futures = [workers.submit(adapter.apply, None, [block]) for block in blocks]
        for future in futures:
            future.result(timeout=5)
    assert [block.updates for block in blocks] == [
        [([4, 0, 0], [255, 255, 255])], [([5, 0, 0], [255, 255, 255])]]
    assert len(requests) == 2 and requests[0] is not requests[1]
    assert all(request is not adapter.predictor for request in requests)


def test_color_checkpoint_preserves_prediction_until_rendering():
    block = SimpleNamespace(lines=np.zeros((1, 4, 2)), texts=['source'], font_size=36,
        angle=0, fg_colors=np.array([210, 40, 60]), bg_colors=np.array([120, 120, 120]),
        prob=.9, _direction='h', default_stroke_width=.1, adjust_bg_color=False,
        line_spacing=1., letter_spacing=1.)
    restored = json.loads(json.dumps(serialize_region(block)))
    assert restored['fg_color'] == [210, 40, 60]
    assert restored['bg_color'] == [120, 120, 120]
    assert restored['default_stroke_width'] == .1
    assert restored['adjust_bg_color'] is False


@pytest.mark.parametrize('fg,bg,expected', [
    ([0, 0, 0], [0, 0, 0], [255, 255, 255]),
    ([5, 8, 12], [18, 22, 28], [255, 255, 255]),
    ([0, 0, 0], [0, 0, 100], [255, 255, 255]),
    ([255, 255, 255], [240, 240, 240], [0, 0, 0]),
    ([210, 40, 60], [205, 38, 58], [255, 255, 255]),
    ([0, 0, 255], [0, 0, 250], [255, 255, 255]),
    ([0, 255, 0], [0, 250, 0], [0, 0, 0]),
    ([255, 255, 0], [250, 250, 0], [0, 0, 0]),
    ([120, 120, 120], [120, 120, 120], [0, 0, 0]),
    ([0, 0, 0], [255, 255, 255], [255, 255, 255]),
    ([245, 245, 245], [20, 40, 130], [20, 40, 130]),
    ([220, 30, 50], [255, 255, 255], [255, 255, 255]),
    # Check the 3:1 boundary after the same integer conversion as Qt.
    ([0, 0, 0], [89.99, 89.99, 89.99], [255, 255, 255]),
    ([0, 0, 0], [90, 90, 90], [90, 90, 90]),
])
@pytest.mark.parametrize('adjust', [False, True])
def test_render_color_guard_preserves_fill_and_only_fixes_low_contrast(fg, bg, expected, adjust):
    block = SimpleNamespace(fg_colors=np.array(fg), bg_colors=np.array(bg),
                            adjust_bg_color=adjust, default_stroke_width=.1)
    for _ in range(2):  # Repeated rendering must not flip colors.
        ensure_stroke_contrast(block)
        np.testing.assert_array_equal(block.fg_colors, fg)
        np.testing.assert_array_equal(block.bg_colors, expected)
        assert not block.adjust_bg_color and block.default_stroke_width == .1


def test_color_assets_are_pinned():
    from mtu_engine.assets import LOCK
    models = {item['file']: item for item in LOCK['models']}
    assert models['ocr/ocr_ar_48px.ckpt']['sha256'] == '29daa46d080818bb4ab239a518a88338cbccff8f901bef8c9db191a7cb97671d'
    assert models['ocr/alphabet-all-v7.txt']['sha256'] == 'f5722368146aa0fbcc9f4726866e4efc3203318ebb66c811d8cbbe915576538a'
