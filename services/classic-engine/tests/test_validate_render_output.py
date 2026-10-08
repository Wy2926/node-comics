"""The local output harness must verify wire pixels without GPU assets."""
import json
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from classic_node.protocol import pack_result, png64
from classic_node import render_pool
from tools.validate_render_output import SharedTracker, fingerprint, main, make_case, private_case, reconstruct, synthetic


@pytest.mark.parametrize(('height', 'alpha_kind'), [(20, None), (20, 'mixed'), (17000, None)])
def test_reconstruct_wire_pixels_and_source_alpha(height, alpha_kind):
    source = np.full((height, 4, 3), 210, np.uint8)
    final = source.copy()
    final[1, 1] = (10, 20, 30)
    final[-2, 2] = (50, 60, 70)
    alpha = None
    if alpha_kind:
        alpha = np.full(source.shape[:2], 128, np.uint8)
        alpha[1, 1] = 0
    case = make_case('wire', source, final, [], 'en', np.zeros(source.shape[:2], np.uint8), alpha)
    packed = pack_result(final, source, **case['kwargs'])
    restored = reconstruct(packed, source, alpha)
    expected = final.copy()
    if alpha is not None:
        expected[alpha == 0] = source[alpha == 0]
        np.testing.assert_array_equal(restored[..., 3], alpha)
        restored = restored[..., :3]
    np.testing.assert_array_equal(restored, expected)
    if height > 16383:
        assert packed['result']['representation'] == 'overlay-tiles-v1'
    assert fingerprint(packed, case)['output_bytes'] == len(packed['output_bytes'])


def test_original_and_fingerprint_exclude_diagnostic_timings():
    case = synthetic('original', 'en')
    packed = pack_result(case['args'][0], case['args'][0], **case['kwargs'])
    assert packed['result']['representation'] == 'original'
    before = fingerprint(packed, case)
    packed['timings'] = {'render_layout': 99}
    assert before == fingerprint(packed, case)
    assert before['output_bytes'] == 0


def test_alpha_synthetic_has_nonbinary_source_alpha_and_independent_input_arrays():
    case = synthetic('alpha', 'ar')
    assert set(np.unique(case['kwargs']['alpha'])) == {0, 128, 255}
    assert not np.shares_memory(*case['args'][:2])
    assert len(case['args'][2]) == len(case['args'][3]) == 3
    assert case['kwargs']['allow_tiles']


def test_shared_tracker_checks_actual_segment_removal():
    module = SimpleNamespace(SharedMemory=render_pool.SharedMemory, _dispose=render_pool._dispose)
    original = module.SharedMemory
    with SharedTracker(module) as tracker:
        segment = module.SharedMemory(create=True, size=64)
        assert tracker.peak == 64
        module._dispose(segment)
        assert tracker.cleaned == 1 and not tracker.live
    assert module.SharedMemory is original


def test_private_manifest_uses_local_checkpoint_and_anonymous_case_name(tmp_path):
    rgba = np.full((8, 10, 4), 180, np.uint8)
    Image.fromarray(rgba).save(tmp_path / 'original.png')
    Image.fromarray(rgba[..., :3]).save(tmp_path / 'clean.png')
    mask = np.full((8, 10), 255, np.uint8)
    analysis = {'regions': [], 'bubble_mask': png64(Image.fromarray(mask)), 'input_hash': 'f' * 64}
    (tmp_path / 'analysis.json').write_text(json.dumps(analysis), encoding='utf-8')
    case = private_case({'original': 'original.png', 'cleaned': 'clean.png', 'analysis': 'analysis.json'},
                        tmp_path, 4, 'en')
    assert case['name'] == 'private-4'
    assert case['kwargs']['analysis'] == {'input_hash': 'f' * 64}
    np.testing.assert_array_equal(case['kwargs']['alpha'], rgba[..., 3])
    np.testing.assert_array_equal(case['args'][5], mask)


@pytest.mark.parametrize('option', ['--workers', '--threads', '--pages', '--rounds', '--max-shared-mib'])
def test_invalid_counts_fail_before_loading_assets(tmp_path, option):
    with pytest.raises(ValueError, match='must be positive'):
        main(['--output', str(tmp_path / 'metrics.json'), option, '0'])
    assert not (tmp_path / 'metrics.json').exists()


def test_negative_cache_fails_before_loading_assets(tmp_path):
    with pytest.raises(ValueError, match='nonnegative'):
        main(['--output', str(tmp_path / 'metrics.json'), '--mask-cache-bytes', '-1'])
