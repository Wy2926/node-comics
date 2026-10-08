"""Page-local arrays avoid checkpoint decoding without changing persisted identity."""
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from classic_node import runtime as module
from classic_node.protocol import NodeFailure, digest, png64
from classic_node.runtime import Runtime


def fixture(monkeypatch, *, bubbles=True):
    rgb = np.full((16, 24, 3), 230, np.uint8)
    mask = np.zeros(rgb.shape[:2], np.uint8)
    mask[2:8, 3:12] = 255
    raw = mask.copy()
    bubble = np.full(rgb.shape[:2], 255, np.uint8) if bubbles else None
    runtime = Runtime.__new__(Runtime)
    runtime.version, runtime.render_pool = 'mask-fixture', None
    region = SimpleNamespace(text='Hello')
    monkeypatch.setattr(module, 'serialize_region', lambda _: {'lines': []})
    runtime.engine = SimpleNamespace(analyze=lambda _: ([region], mask, raw, bubble),
        inpaint=lambda original, *_, **__: original.copy(),
        renderer=SimpleNamespace(render=lambda original, cleaned, *_args, **_kwargs: cleaned))
    return runtime, rgb, (mask, raw, bubble)


def translated(analysis):
    return {'analysis_hash': digest(analysis), 'language': 'en', 'revision': 'r1',
            'translations': {'0': 'Translated'}}


@pytest.mark.parametrize('bubbles', [False, True])
def test_fresh_native_masks_are_read_only_and_reused_without_decoding(monkeypatch, bubbles):
    runtime, rgb, arrays = fixture(monkeypatch, bubbles=bubbles)
    masks = {}
    analysis = runtime.analyze(rgb, 'a' * 64, masks=masks)
    identity = digest(analysis)
    assert set(masks) == ({'mask', 'raw_mask', 'bubble_mask'} if bubbles else {'mask', 'raw_mask'})
    for name, array in zip(('mask', 'raw_mask', 'bubble_mask'), arrays):
        if array is not None:
            assert masks[name] is array and not array.flags.writeable
    assert sum(array.nbytes for array in masks.values()) == rgb.shape[0] * rgb.shape[1] * len(masks)
    seen = []

    def inpaint(original, mask, raw, bubble, regions, *, cache):
        assert cache is masks
        assert mask is masks['mask'] and raw is masks['raw_mask']
        assert bubble is masks['bubble_mask'] if bubbles else not bubble.any()
        seen.append('inpaint')
        cleaned = original.copy()
        cleaned[3, 4] = (10, 20, 30)
        return cleaned

    def render(original, cleaned, regions, texts, language, bubble, **kwargs):
        assert bubble is (masks['bubble_mask'] if bubbles else None)
        seen.append('render')
        return cleaned

    runtime.engine.inpaint = inpaint
    runtime.engine.renderer.render = render
    monkeypatch.setattr(module, 'mask_image', lambda *_a, **_k: pytest.fail('No checkpoint re-decode'))
    cleaned = runtime.inpaint(rgb, analysis, masks=masks)
    packed = runtime.render(rgb, cleaned, analysis, translated(analysis), 'en', None, masks=masks)
    assert seen == ['inpaint', 'render'] and packed['result']['representation'] == 'overlay-v1'
    assert digest(analysis) == identity and 'masks' not in analysis


def test_recovered_masks_decode_once_then_match_uncached_output(monkeypatch):
    runtime, rgb, _ = fixture(monkeypatch)
    analysis = runtime.analyze(rgb, 'a' * 64)
    cleaned = rgb.copy()
    cleaned[3, 4] = (10, 20, 30)
    texts = translated(analysis)
    baseline = runtime.render(rgb, cleaned, analysis, texts, 'en', None)
    masks, calls = {}, []
    decode = module.mask_image

    def counted(*args, **kwargs):
        calls.append(True)
        return decode(*args, **kwargs)

    monkeypatch.setattr(module, 'mask_image', counted)
    runtime.restore_masks(analysis, (24, 16), masks)
    assert len(calls) == 3 and all(not value.flags.writeable for value in masks.values())
    runtime.inpaint(rgb, analysis, masks=masks)
    assert runtime.render(rgb, cleaned, analysis, texts, 'en', None, masks=masks) == baseline
    assert len(calls) == 3


def test_prepared_bubble_arrays_bypass_eroded_and_raw_checkpoint_decode(monkeypatch):
    runtime, rgb, _ = fixture(monkeypatch)
    analysis = runtime.analyze(rgb, 'a' * 64)
    inset = np.ones(rgb.shape[:2], np.uint8)
    labels = np.ones(rgb.shape[:2], np.int32)
    stats = np.array([[0, 0, 0, 0, 0], [0, 0, 24, 16, 384]], np.int32)
    masks = {'bubble_inset': inset, 'bubble_labels': labels, 'bubble_stats': stats}
    def render(original, cleaned, regions, texts, language, bubble, **kwargs):
        assert bubble is inset and kwargs['bubble_prepared']
        assert kwargs['bubble_components'][0] is labels and kwargs['bubble_components'][1] is stats
        return cleaned
    runtime.engine.renderer.render = render
    monkeypatch.setattr(module, 'decode_mask', lambda *_: pytest.fail('prepared page must not decode raw bubbles'))
    runtime.render(rgb, rgb, analysis, translated(analysis), 'en', None, masks=masks)


@pytest.mark.parametrize('name', ['mask', 'raw_mask', 'bubble_mask'])
def test_recovered_masks_validate_all_encoded_dimensions(monkeypatch, name):
    runtime, rgb, _ = fixture(monkeypatch)
    analysis = runtime.analyze(rgb, 'a' * 64)
    analysis[name] = png64(Image.new('L', (1, 1), 255))
    with pytest.raises(NodeFailure, match='CLASSIC_OCR_INVALID'):
        runtime.restore_masks(analysis, (24, 16), {})


@pytest.mark.parametrize('value', [None, 'empty'])
def test_recovered_text_requires_a_nonempty_text_mask(monkeypatch, value):
    runtime, rgb, _ = fixture(monkeypatch)
    analysis = runtime.analyze(rgb, 'a' * 64)
    analysis['mask'] = png64(Image.new('L', (24, 16))) if value == 'empty' else None
    with pytest.raises(NodeFailure, match='CLASSIC_OCR_INVALID'):
        runtime.restore_masks(analysis, (24, 16), {})


def test_native_mask_shape_rejected_before_any_cache_is_retained(monkeypatch):
    runtime, rgb, arrays = fixture(monkeypatch)
    runtime.engine.analyze = lambda _: ([SimpleNamespace(text='Hello')], arrays[0], arrays[1][2:3], arrays[2])
    masks = {}
    with pytest.raises(NodeFailure, match='CLASSIC_ANALYZE_FAILED'):
        runtime.analyze(rgb, 'a' * 64, masks=masks)
    assert masks == {}


@pytest.mark.parametrize('contiguous', [False, True])
def test_cached_detector_crops_do_not_retain_a_larger_padded_base(monkeypatch, contiguous):
    runtime, rgb, arrays = fixture(monkeypatch)
    padded = np.full((32, 24 if contiguous else 48), 255, np.uint8)
    raw = padded[:16, :24]
    assert not raw.flags.owndata and raw.flags.c_contiguous == contiguous
    runtime.engine.analyze = lambda _: ([SimpleNamespace(text='Hello')], arrays[0], raw, arrays[2])
    masks = {}
    analysis = runtime.analyze(rgb, 'a' * 64, masks=masks)
    cached = masks['raw_mask']
    assert cached.flags.owndata and cached.flags.c_contiguous and not cached.flags.writeable
    assert cached.base is None and cached.nbytes == 16 * 24
    assert not np.shares_memory(cached, padded)
    np.testing.assert_array_equal(cached, raw)
    assert analysis['raw_mask'] == png64(Image.fromarray(raw))
    padded.fill(0)
    assert cached.all()  # Subsequent engine buffer reuse cannot change this page.


def test_array_packing_does_not_convert_the_full_frame_to_pil(monkeypatch):
    from classic_node.protocol import pack_result
    rgb = np.full((16, 24, 3), 230, np.uint8)
    analysis = {'input_hash': 'a' * 64}
    monkeypatch.setattr(Image, 'fromarray', lambda *_a, **_k: pytest.fail('No full-frame PIL bridge'))
    packed = pack_result(rgb, rgb, None, 'fixture', analysis, translated(analysis))
    assert packed['output_bytes'] is None
