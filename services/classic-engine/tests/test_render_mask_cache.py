"""Execute the shipped renderer patches without Qt, models, assets or network."""
import ast
import asyncio
from concurrent.futures import ThreadPoolExecutor
import gc
from threading import Barrier
from types import SimpleNamespace
import weakref

import cv2
import numpy as np
import pytest

from mtu_engine.assets import LOCK
from tools.prepare_mtu import apply_source_patches


RENDER_PATH = 'manga_translator/rendering/__init__.py'
BUBBLE_PATH = 'manga_translator/utils/bubble.py'


def execute(source, filename):
    # The exact pinned snippets contain only geometry helpers and cache state;
    # executing the full upstream rendering module would unnecessarily load Qt.
    values = {'np': np, 'cv2': cv2}
    exec(compile(ast.parse(source), filename, 'exec'), values)
    return values


@pytest.fixture
def helpers(tmp_path, monkeypatch):
    patches = {path: LOCK['source']['patches'][path][0] for path in (RENDER_PATH, BUBBLE_PATH)}
    for path, patch in patches.items():
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(patch['before'], encoding='utf-8')
    # Exercise the real preparation path, scoped to the files this fixture owns.
    monkeypatch.setitem(LOCK['source'], 'patches', {path: [patch] for path, patch in patches.items()})
    apply_source_patches(tmp_path)
    loaded = {}
    for path, patch in patches.items():
        source = (tmp_path / path).read_text(encoding='utf-8')
        assert source == patch['after']
        loaded[path] = execute(source, path)
    baseline = {path: execute(patch['before'], path) for path, patch in patches.items()}
    return SimpleNamespace(
        inside=loaded[RENDER_PATH]['_polygon_fully_inside_mask'],
        original_inside=baseline[RENDER_PATH]['_polygon_fully_inside_mask'],
        build=loaded[BUBBLE_PATH]['build_region_reference_mask'],
        original_build=baseline[BUBBLE_PATH]['build_region_reference_mask'],
        cache=loaded[BUBBLE_PATH]['reference_mask_cache'],
        bubble_globals=loaded[BUBBLE_PATH],
    )


def region(x1=3, y1=3, x2=12, y2=12, dtype=np.float64):
    polygon = np.array([[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]], dtype=dtype)
    return SimpleNamespace(lines=polygon, min_rect=polygon.copy())


@pytest.fixture
def bubbles():
    mask = np.zeros((36, 48), np.uint8)
    mask[2:21, 2:19] = 255
    mask[2:21, 24:44] = 255
    mask[26:33, 4:12] = 255
    mask[8:12, 7:11] = 0
    _, labels = cv2.connectedComponents((mask > 0).astype(np.uint8), connectivity=8)
    return mask, labels


@pytest.mark.parametrize('dtype', [np.int32, np.int64, np.float64])
def test_roi_matches_pinned_integer_clipping_and_input_side_effects(helpers, dtype):
    rng = np.random.default_rng(20261007)
    for index in range(400):
        height, width = map(int, rng.integers(1, 97, size=2))
        mask = (rng.random((height, width)) > (0, .03, .5, 1)[index % 4]).astype(np.uint8) * 255
        points = rng.uniform([-width, -height], [2 * width, 2 * height],
                             size=(int(rng.integers(3, 10)), 2)).astype(dtype)
        if index % 7 == 0:
            points[:, 1] = points[0, 1]  # Degenerate polygons still have native raster semantics.
        baseline_points, candidate_points = points.copy(), points.copy()
        assert helpers.inside(candidate_points, mask) == helpers.original_inside(baseline_points, mask)
        np.testing.assert_array_equal(candidate_points, baseline_points)


@pytest.mark.parametrize('points', [None, np.zeros((0, 2)), np.zeros((2, 2)), np.zeros(3)])
@pytest.mark.parametrize('shape', [(0, 0), (0, 3), (3, 0), (1, 1), (12, 15)])
def test_roi_invalid_and_empty_inputs_keep_upstream_result(helpers, points, shape):
    mask = np.ones(shape, np.uint8)
    assert helpers.inside(points, mask) == helpers.original_inside(points, mask)
    assert helpers.inside(points, None) is False


def test_roi_raster_pixels_match_full_page_without_full_page_temporary(helpers, monkeypatch):
    captured = []

    def fill(image, polygons, *args, **kwargs):
        result = cv2.fillPoly(image, polygons, *args, **kwargs)
        captured.append(image.copy())
        return result

    monkeypatch.setitem(helpers.inside.__globals__, 'cv2',
                        SimpleNamespace(fillPoly=fill, boundingRect=cv2.boundingRect))
    rng = np.random.default_rng(927)
    for _ in range(200):
        mask = np.full((60, 90), 255, np.uint8)
        points = rng.uniform([-20, -20], [110, 80], size=(6, 2))
        clipped = points.astype(np.int32)
        clipped[:, 0] = np.clip(clipped[:, 0], 0, mask.shape[1] - 1)
        clipped[:, 1] = np.clip(clipped[:, 1], 0, mask.shape[0] - 1)
        expected = np.zeros_like(mask)
        cv2.fillPoly(expected, [clipped], 255)
        assert helpers.inside(points, mask)
        x, y, width, height = cv2.boundingRect(clipped)
        actual = np.zeros_like(mask)
        actual[y:y + height, x:x + width] = captured.pop()
        np.testing.assert_array_equal(actual, expected)
    helpers.inside(np.array([[11, 21], [20, 21], [20, 37], [11, 37]]),
                   np.ones((300, 1500), np.uint8))
    assert captured.pop().shape == (17, 10)


def test_cached_reference_keeps_complete_intersecting_components_and_holes(helpers, bubbles):
    mask, labels = bubbles
    block = region(14, 4, 28, 17)  # Intersects two bubbles, but not the lower third one.
    expected = helpers.original_build(block, mask, labels)
    with helpers.cache(mask.nbytes):
        actual = helpers.build(block, mask, labels)
        repeated = helpers.build(block, mask, labels)
        assert repeated is actual
        assert not actual.flags.writeable
        with pytest.raises(ValueError, match='read-only'):
            actual[3, 3] = 0
    np.testing.assert_array_equal(actual, expected)
    assert actual[3, 3] == actual[3, 40] == 255  # Complete components, not just region crop.
    assert actual[9, 8] == actual[28, 6] == 0  # Hole and untouched component retained.
    assert mask.flags.writeable  # Making the cache immutable must not freeze the caller's mask.


def test_cached_mask_accepts_native_read_only_geometry_consumers(helpers, bubbles):
    mask, labels = bubbles
    with helpers.cache(mask.nbytes):
        result = helpers.build(region(), mask, labels)
        snapshot = result.copy()
        helpers.inside(np.array([[3, 3], [5, 3], [5, 5], [3, 5]]), result)
        assert cv2.boundingRect(result) == (2, 2, 17, 19)
        contours, _ = cv2.findContours(result, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        assert len(contours) == 1
        np.testing.assert_array_equal(result, snapshot)


def test_geometry_key_reuses_equal_regions_but_not_mutated_coordinates(helpers, bubbles, monkeypatch):
    mask, labels = bubbles
    native = helpers.bubble_globals['_build_region_reference_mask']
    calls = []

    def counted(*args):
        calls.append(1)
        return native(*args)

    monkeypatch.setitem(helpers.bubble_globals, '_build_region_reference_mask', counted)
    block = region()
    with helpers.cache(mask.nbytes * 4):
        first = helpers.build(block, mask, labels)
        assert helpers.build(region(), mask, labels) is first
        block.translation, block.font_size = 'changed text and font do not change source geometry', 72
        assert helpers.build(block, mask, labels) is first
        block.lines[..., 0] += 23
        changed = helpers.build(block, mask, labels)
        assert changed is not first
        np.testing.assert_array_equal(changed, helpers.original_build(block, mask, labels))
        assert len(calls) == 2


def test_empty_lines_key_uses_min_rect(helpers, bubbles):
    mask, labels = bubbles
    block = region()
    block.lines = np.empty((0, 4, 2))
    with helpers.cache(mask.nbytes * 2):
        first = helpers.build(block, mask, labels)
        assert helpers.build(block, mask, labels) is first
        block.min_rect[..., 0] += 23
        second = helpers.build(block, mask, labels)
        assert second is not first
        np.testing.assert_array_equal(second, helpers.original_build(block, mask, labels))


def test_multiline_union_and_renumbered_component_map_keep_same_result(helpers, bubbles):
    mask, labels = bubbles
    block = region()
    block.lines = np.concatenate((block.lines, region(26, 4, 36, 12).lines))
    relabeled = np.where(labels > 0, labels * 7 + 5, 0).astype(labels.dtype)
    with helpers.cache(mask.nbytes):
        first = helpers.build(block, mask, labels)
        assert helpers.build(block, mask, relabeled) is first
        np.testing.assert_array_equal(first, helpers.original_build(block, mask, relabeled))
        assert first[3, 3] == first[3, 40] == 255
        assert first[28, 6] == 0


@pytest.mark.parametrize('lines', [np.ones((2, 3)), np.array(['invalid'])])
def test_invalid_region_geometry_preserves_empty_reference_fallback(helpers, bubbles, lines):
    mask, labels = bubbles
    block = region()
    block.lines = lines
    expected = helpers.original_build(block, mask, labels)
    with helpers.cache(mask.nbytes):
        actual = helpers.build(block, mask, labels)
        np.testing.assert_array_equal(actual, expected)
        assert not np.any(actual)


def test_switching_page_mask_does_not_reuse_previous_union(helpers, bubbles):
    mask, labels = bubbles
    other = mask.copy()
    other[14:20, 3:8] = 0
    _, other_labels = cv2.connectedComponents((other > 0).astype(np.uint8))
    block = region()
    with helpers.cache(mask.nbytes * 2):
        first = helpers.build(block, mask, labels)
        second = helpers.build(block, other, other_labels)
        assert second is not first
        np.testing.assert_array_equal(second, helpers.original_build(block, other, other_labels))
        restored = helpers.build(block, mask, labels)
        np.testing.assert_array_equal(restored, first)


@pytest.mark.parametrize('budget', [0, -1, 1])
def test_insufficient_budget_falls_back_without_retaining_result(helpers, bubbles, budget):
    mask, labels = bubbles
    block = region()
    expected = helpers.original_build(block, mask, labels)
    with helpers.cache(budget):
        first = helpers.build(block, mask, labels)
        second = helpers.build(block, mask, labels)
        assert first is not second
        np.testing.assert_array_equal(first, expected)
        np.testing.assert_array_equal(second, expected)
        released = weakref.ref(first)
        del first
        assert released() is None


def test_total_retained_full_masks_stay_within_page_budget(helpers, bubbles):
    mask, labels = bubbles
    references = []
    budget = mask.nbytes * 2
    with helpers.cache(budget):
        for offset in range(6):
            block = region(x1=3 + offset, x2=12 + offset)
            result = helpers.build(block, mask, labels)
            np.testing.assert_array_equal(result, helpers.original_build(block, mask, labels))
            references.append(weakref.ref(result))
            del result
        retained = {id(ref()): ref().nbytes for ref in references if ref() is not None}
        assert sum(retained.values()) <= budget
        assert retained  # This is not merely a disabled-cache test.
    gc.collect()
    assert all(ref() is None for ref in references)


def test_nested_cache_restores_outer_page_and_releases_inner(helpers, bubbles):
    mask, labels = bubbles
    block = region()
    with helpers.cache(mask.nbytes):
        outer = helpers.build(block, mask, labels)
        with helpers.cache(mask.nbytes):
            inner = helpers.build(block, mask, labels)
            assert inner is not outer
            released = weakref.ref(inner)
            del inner
        assert released() is None
        assert helpers.build(block, mask, labels) is outer


def test_exception_exit_releases_cached_masks_and_restores_default(helpers, bubbles):
    mask, labels = bubbles
    block = region()
    with pytest.raises(RuntimeError, match='render failed'):
        with helpers.cache(mask.nbytes):
            released = weakref.ref(helpers.build(block, mask, labels))
            assert released() is not None
            raise RuntimeError('render failed')
    gc.collect()
    assert released() is None
    first = helpers.build(block, mask, labels)
    second = helpers.build(block, mask, labels)
    assert first is not second


def test_page_mask_identity_is_retained_only_until_context_exit(helpers, bubbles):
    mask, labels = bubbles
    block = region()
    with helpers.cache(mask.nbytes):
        transient = mask.copy()
        retained = weakref.ref(transient)
        helpers.build(block, transient, labels)
        del transient
        assert retained() is not None  # Prevent id reuse while cache entries are live.
    assert retained() is None


def test_async_dispatch_inherits_current_page_cache(helpers, bubbles):
    mask, labels = bubbles
    block = region()

    async def dispatch():
        return helpers.build(block, mask, labels)

    with helpers.cache(mask.nbytes):
        first = helpers.build(block, mask, labels)
        assert asyncio.run(dispatch()) is first


def test_simultaneous_threads_have_independent_page_caches(helpers, bubbles):
    mask, labels = bubbles
    block = region()
    barrier = Barrier(2)

    def render():
        with helpers.cache(mask.nbytes):
            first = helpers.build(block, mask, labels)
            barrier.wait(timeout=10)
            assert helpers.build(block, mask, labels) is first
            return first

    with ThreadPoolExecutor(max_workers=2) as pool:
        left = pool.submit(render)
        right = pool.submit(render)
        left, right = left.result(timeout=15), right.result(timeout=15)
    assert left is not right
    np.testing.assert_array_equal(left, right)
