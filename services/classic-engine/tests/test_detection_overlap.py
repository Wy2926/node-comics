"""Pinned preparation edit and long-page overlap geometry; no GPU required."""
import textwrap

import numpy as np
import pytest

from mtu_engine.assets import LOCK, verify
from tools.prepare_mtu import apply_source_patches


PATCH_PATH = 'manga_translator/utils/generic.py'
PATCH = LOCK['source']['patches'][PATCH_PATH]


def test_preparation_applies_only_the_pinned_edit(tmp_path):
    target = tmp_path / PATCH_PATH
    target.parent.mkdir(parents=True)
    source = '# Upstream license retained\n' + PATCH['before'] + '# Packing and merging retained\n'
    target.write_text(source, encoding='utf-8')
    apply_source_patches(tmp_path)
    assert target.read_text(encoding='utf-8') == source.replace(PATCH['before'], PATCH['after'])
    # Do not silently double-patch an already prepared or drifted source tree.
    with pytest.raises(ValueError, match='target changed'):
        apply_source_patches(tmp_path)


@pytest.mark.parametrize('source', ['unrelated source', PATCH['before'] * 2])
def test_preparation_rejects_missing_or_ambiguous_anchor(tmp_path, source):
    target = tmp_path / PATCH_PATH
    target.parent.mkdir(parents=True)
    target.write_text(source, encoding='utf-8')
    with pytest.raises(ValueError, match='target changed'):
        apply_source_patches(tmp_path)
    assert target.read_text(encoding='utf-8') == source


def test_preparation_rejects_patch_outside_bundle(tmp_path, monkeypatch):
    monkeypatch.setitem(LOCK['source'], 'patches', {'../outside.py': PATCH})
    with pytest.raises(ValueError, match='Unsafe upstream patch'):
        apply_source_patches(tmp_path)


@pytest.mark.parametrize('height,width', [(12930, 720), (12960, 720), (16000, 320), (10000, 1024)])
def test_exact_patch_expression_keeps_full_coverage_and_minimum_overlap(height, width):
    # Execute the shipped lockfile expression, not a duplicate implementation.
    ph = width * 3
    values = {'np': np, 'h': height, 'ph': ph}
    exec(textwrap.dedent(PATCH['after']), values)
    starts = np.rint(np.linspace(0, height - ph, values['ph_num'])).astype(int)
    assert starts[0] == 0 and starts[-1] + ph == height
    assert np.all(np.diff(starts) > 0)
    assert np.all(ph - np.diff(starts) >= ph // 5)
    if height == 12930:
        assert values['ph_num'] == 8
        assert min(ph - np.diff(starts)) == 621


def test_previous_asset_lock_is_rejected_before_model_loading(tmp_path):
    import json
    manifest = {'upstream': LOCK['source']['revision'], 'lock_sha256': 'previous-unpatched-lock'}
    (tmp_path / 'mtu-assets.json').write_text(json.dumps(manifest), encoding='utf-8')
    with pytest.raises(ValueError, match='do not match'):
        verify(tmp_path / 'models')
