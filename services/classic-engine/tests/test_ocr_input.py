"""Check OCR adapter bounds and mapping without loading a neural network."""
from types import SimpleNamespace

import numpy as np
import pytest
from rapidocr.ch_ppocr_rec import TextRecognizer
from rapidocr.ch_ppocr_rec.typings import TextRecOutput

from classic_node.config import ENGINE_DEFAULTS
from classic_node.timing import collect
from mtu_engine.ocr import OCR_IMAGE_SHAPE, OCR_MAX_WIDTH, Recognizer


@pytest.mark.parametrize(('height', 'width'), [(48, 180), (32, 600), (48, 3200), (90, 120)])
def test_native_resize_is_not_overridden_and_preserves_long_line_width(height, width):
    assert Recognizer.__call__ is TextRecognizer.__call__
    image = np.full((height, width, 3), 255, dtype=np.uint8)
    ratio = max(OCR_IMAGE_SHAPE[2] / OCR_IMAGE_SHAPE[1], width / height)
    result = Recognizer.resize_norm_img(SimpleNamespace(rec_image_shape=OCR_IMAGE_SHAPE), image, ratio)
    assert result.shape == (3, 48, int(48 * ratio))
    assert result.shape[-1] <= OCR_MAX_WIDTH
    assert result.dtype == np.float32
    used_width = int(np.ceil(48 * width / height))
    assert np.all(result[:, :, :used_width] == 1)
    assert not np.any(result[:, :, used_width:])


def test_adapter_preserves_order_confidence_and_skips_unsupported_crops(monkeypatch):
    model = SimpleNamespace(session=object(), _decode_ctc=lambda pred: ('unused', 1),
                            _get_rotate_crop_image=lambda image, pts: pts)
    monkeypatch.setattr('mtu_engine.ocr.OrtInferSession', lambda cfg: cfg['session'])
    recognizer = Recognizer(model)
    assert recognizer.rec_batch_num == ENGINE_DEFAULTS['ocr_batch_size']
    assert recognizer.session._session is model.session
    assert recognizer.postprocess_op([0])[0] == [('unused', 1)]
    crops = [np.full((24, 200, 3), [20, 30, 40], dtype=np.uint8),
             np.zeros((0, 10, 3), dtype=np.uint8),
             np.zeros((48, OCR_MAX_WIDTH + 1, 3), dtype=np.uint8),
             np.ones((48, 600, 3), dtype=np.uint8)]
    lines = [SimpleNamespace(pts=crop, text='stale', prob=1) for crop in crops]
    def infer(self, args):
        assert len(args.img) == 2
        assert args.img[0][0, 0].tolist() == [40, 30, 20]
        return TextRecOutput(txts=('long text', 'uncertain'), scores=(0.99, 0.49))
    monkeypatch.setattr(TextRecognizer, '__call__', infer)
    assert recognizer.recognize(None, lines, 0.5) is lines
    assert [line.text for line in lines] == ['long text', '', '', '']
    assert [line.prob for line in lines] == [0.99, 0, 0, 0.49]


def test_empty_lines_do_not_call_inference(monkeypatch):
    model = SimpleNamespace(session=object(), _decode_ctc=None, _get_rotate_crop_image=None)
    monkeypatch.setattr('mtu_engine.ocr.OrtInferSession', lambda cfg: cfg['session'])
    recognizer = Recognizer(model)
    monkeypatch.setattr(TextRecognizer, '__call__', lambda *args: pytest.fail('empty inference'))
    assert recognizer.recognize(None, [], 0.5) == []


def test_short_and_long_inputs_use_two_native_groups_with_original_order(monkeypatch):
    recognizer = Recognizer.__new__(Recognizer)
    crops = [np.full((48, width, 3), index, dtype=np.uint8)
             for index, width in enumerate((720, 40, 321, 320, 3200, 3201, 100))]
    batches = []
    def infer(self, args):
        batches.append([image.shape[1] for image in args.img])
        return TextRecOutput(txts=tuple(str(image[0, 0, 0]) for image in args.img),
                             scores=tuple(.9 for _ in args.img))
    monkeypatch.setattr(TextRecognizer, '__call__', infer)
    rows = recognizer.read(crops)
    assert batches == [[40, 320, 100], [720, 321, 3200]]
    assert [row['text'] for row in rows] == ['0', '1', '2', '3', '4', '', '6']


def test_short_text_tensor_padding_is_independent_of_a_long_peer():
    recognizer = Recognizer.__new__(Recognizer)
    recognizer.rec_batch_num = ENGINE_DEFAULTS['ocr_batch_size']
    recognizer.rec_image_shape = OCR_IMAGE_SHAPE
    recognizer.cfg = SimpleNamespace(lang_type='ch', font_path=None)
    recognizer.RTL_LANGS = set()
    tensors = []
    def infer(batch):
        tensors.append(batch.copy())
        return batch
    recognizer.session = infer
    recognizer.postprocess_op = lambda batch, *args, **kwargs: ([('read', .9)] * len(batch), [])
    short = np.full((32, 90, 3), [20, 30, 40], np.uint8)
    long = np.ones((48, 2500, 3), np.uint8)
    recognizer.read([short, long])
    recognizer.read([short])
    assert [batch.shape for batch in tensors] == [(1, 3, 48, 320), (1, 3, 48, 2500), (1, 3, 48, 320)]
    np.testing.assert_array_equal(tensors[0], tensors[2])


@pytest.mark.parametrize('minimum,succeeds,expected', [(1, True, [4, 2, 1, 1, 1, 1]),
                                                       (2, False, [4, 2]), (4, False, [4])])
def test_oom_reuses_native_batches_with_bounded_request_local_retry(monkeypatch, minimum, succeeds, expected):
    attempts, releases = [], []
    def infer(batch):
        attempts.append(len(batch))
        if len(batch) > 1:
            raise RuntimeError('bfc_arena.cc: Failed to allocate memory for requested buffer of size 108545280')
        return np.rint((batch[:, 0, 0, 0] + 1) * 127.5).astype(int)
    monkeypatch.setattr('mtu_engine.ocr.OrtInferSession', lambda cfg: cfg['session'])
    recognizer = Recognizer(SimpleNamespace(session=infer, _decode_ctc=lambda value: (str(value), .9)),
                            batch_size=4, min_batch_size=minimum, recover=lambda: releases.append(1))
    crops = [np.full((48, width, 3), i, np.uint8) for i, width in enumerate((200, 50, 100, 90))]
    with collect() as values:
        if succeeds:
            assert [row['text'] for row in recognizer.read(crops)] == ['0', '1', '2', '3']
        else:
            with pytest.raises(RuntimeError, match='Failed to allocate'):
                recognizer.read(crops)
    assert attempts == expected
    assert recognizer.rec_batch_num == 4 and recognizer.min_batch_size == minimum
    assert len(releases) == (minimum < 4)
    assert values.get('ocr_oom_retries', 0) == ({1: 2, 2: 1, 4: 0}[minimum])
    assert values['ocr_batch_max'] == 4 and values['ocr_batches'] == len(attempts)
    assert values['ocr_width_max'] == 320


@pytest.mark.parametrize('message', ['CUDA illegal memory access', 'shape mismatch', 'private text',
                                     'CPU out of memory'])
def test_non_allocation_failure_never_retries_or_reclaims(monkeypatch, message):
    calls = []
    def infer(batch):
        calls.append(1)
        raise RuntimeError(message)
    monkeypatch.setattr('mtu_engine.ocr.OrtInferSession', lambda cfg: cfg['session'])
    reader = Recognizer(SimpleNamespace(session=infer, _decode_ctc=None),
                        recover=lambda: pytest.fail('must not clear allocator'))
    with pytest.raises(RuntimeError, match=message):
        reader.read([np.zeros((48, 48, 3), np.uint8)] * 4)
    assert len(calls) == 1
