"""Pinned maximal-rectangle search: exact geometry, bounded per-render reuse."""
import ast
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
import weakref

import cv2
import numpy as np
import pytest

from mtu_engine.assets import LOCK
from tools.prepare_mtu import apply_source_patches


@pytest.fixture
def helpers(tmp_path, monkeypatch):
    render_path = 'manga_translator/rendering/__init__.py'
    bubble_path = 'manga_translator/utils/bubble.py'
    rectangle = next(p for p in LOCK['source']['patches'][render_path]
                     if p['before'].startswith('def find_largest_inscribed_rect('))
    patches = {render_path: [rectangle], bubble_path: LOCK['source']['patches'][bubble_path]}
    for name, edits in patches.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(p['before'] for p in edits), encoding='utf-8')
    monkeypatch.setitem(LOCK['source'], 'patches', patches)
    apply_source_patches(tmp_path)
    bubble = {'np': np, 'cv2': cv2}
    exec(compile((tmp_path / bubble_path).read_text(encoding='utf-8'), bubble_path, 'exec'), bubble)
    render = {'np': np, 'cv2': cv2, 'cached_largest_inscribed_rect': bubble['cached_largest_inscribed_rect']}
    prepared = (tmp_path / render_path).read_text(encoding='utf-8')
    assert prepared == rectangle['after']
    exec(compile(prepared, render_path, 'exec'), render)
    baseline = {'np': np}
    exec(compile(rectangle['before'], render_path, 'exec'), baseline)
    return SimpleNamespace(rect=render['find_largest_inscribed_rect'],
        original=baseline['find_largest_inscribed_rect'], cache=bubble['reference_mask_cache'],
        build=bubble['build_region_reference_mask'], render=render, bubble=bubble,
        source=rectangle)


@pytest.mark.parametrize('dtype', [np.bool_, np.uint8, np.int16, np.float32])
def test_cropped_search_matches_native_rectangles_and_ties(helpers, dtype):
    rng = np.random.default_rng(20261007)
    for _ in range(150):
        h, w = map(int, rng.integers(1, 45, size=2))
        pixels = (rng.random((h, w)) > rng.uniform(0, 1)).astype(dtype)
        if dtype in (np.int16, np.float32):
            pixels[pixels == 0] = -1  # Only positive pixels are foreground.
        pixels = np.pad(pixels, ((3, 8), (5, 2)))
        snapshot = pixels.copy()
        assert helpers.rect(pixels) == helpers.original(pixels)
        np.testing.assert_array_equal(pixels, snapshot)
        assert helpers.rect(pixels[::-1, ::-1]) == helpers.original(pixels[::-1, ::-1])


@pytest.mark.parametrize('shape', [(), (0, 0), (0, 3), (3, 0), (1, 1), (3,), (2, 3, 1)])
def test_empty_and_non_2d_inputs_keep_native_fallback(helpers, shape):
    for value in (0, 1):
        mask = np.full(shape, value, np.uint8)
        assert helpers.rect(mask) == helpers.original(mask)


def test_disconnected_components_holes_and_equal_area_order(helpers):
    mask = np.zeros((80, 100), np.uint8)
    mask[5:15, 7:27] = 255
    mask[5:15, 47:67] = 255  # Same area: keep the native leftmost winner.
    mask[35:55, 7:17] = 255  # Same area: keep the native first-row winner.
    assert helpers.rect(mask) == helpers.original(mask) == (7, 5, 20, 10)
    mask[30:75, 35:90] = 255
    mask[32:73, 37:88] = 0  # Large bounding box, but its hole must not be filled.
    assert helpers.rect(mask) == helpers.original(mask)


def test_long_page_only_runs_native_row_loop_on_nonempty_bounds(helpers):
    mask = np.zeros((34545, 690), np.uint8)
    mask[33700:33740, 120:190] = 255
    native_range, row_counts = range, []

    def traced_range(*args):
        if len(args) == 1 and args[0] == 40:
            row_counts.append(args[0])
        assert args[0] not in (34545, 691)
        return native_range(*args)

    helpers.render['range'] = traced_range
    assert helpers.rect(mask) == (120, 33700, 70, 40)
    assert row_counts == [40]
    # The histogram/stack loop remains verbatim, apart from coordinate rebasing.
    old = ast.parse(helpers.source['before']).body[0]
    new = ast.parse(helpers.source['after']).body[1]
    old_loop = next(node for node in old.body if isinstance(node, ast.For))
    new_loop = next(node for node in new.body if isinstance(node, ast.For))
    rebased = ast.unparse(new_loop).replace('origin_x + left', 'left').replace(
        'origin_y + y - rect_height + 1', 'y - rect_height + 1')
    assert rebased == ast.unparse(old_loop)


def reference(helpers, mask, left=3):
    _, labels = cv2.connectedComponents((mask > 0).astype(np.uint8))
    block = SimpleNamespace(lines=np.array([[[left, 3], [left + 4, 3],
                                            [left + 4, 8], [left, 8]]]))
    return helpers.build(block, mask, labels)


def counted_search(helpers):
    calls = []
    native = helpers.render['_find_largest_inscribed_rect']

    def counted(mask):
        calls.append(1)
        return native(mask)

    helpers.render['_find_largest_inscribed_rect'] = counted
    return calls


def test_reuses_only_budgeted_readonly_masks_and_releases_metadata(helpers):
    mask = np.full((24, 30), 255, np.uint8)
    calls = counted_search(helpers)
    with helpers.cache(mask.nbytes):
        stored = reference(helpers, mask)
        state = helpers.bubble['_reference_masks'].get()
        assert helpers.rect(stored) == helpers.rect(stored) == (0, 0, 30, 24)
        assert len(calls) == 1
        assert state['used'] == mask.nbytes
        assert state['rectangles'] == {id(stored): (0, 0, 30, 24)}
        uncached = reference(helpers, mask, left=12)
        released = weakref.ref(uncached)
        assert helpers.rect(uncached) == helpers.rect(uncached) == (0, 0, 30, 24)
        assert len(calls) == 3
        del uncached
        assert released() is None  # Rectangle metadata never retains extra masks.
    assert state['rectangles'] == state['entries'] == {}
    assert helpers.rect(stored) == (0, 0, 30, 24)
    assert len(calls) == 4  # No reuse across render invocations.


def test_mask_change_mutable_inputs_and_exception_cleanup(helpers):
    mask = np.full((24, 30), 255, np.uint8)
    with pytest.raises(RuntimeError, match='cancelled'):
        with helpers.cache(mask.nbytes):
            state = helpers.bubble['_reference_masks'].get()
            first = reference(helpers, mask)
            assert helpers.rect(first) == (0, 0, 30, 24)
            other = mask.copy()
            other[:, 20:] = 0
            second = reference(helpers, other)
            assert id(first) not in state['rectangles']
            assert helpers.rect(second) == (0, 0, 20, 24)
            assert helpers.rect(mask) == (0, 0, 30, 24)
            mask[:, 10:] = 0
            assert helpers.rect(mask) == (0, 0, 10, 24)
            raise RuntimeError('cancelled')
    assert state['rectangles'] == state['entries'] == {}
    assert helpers.bubble['_reference_masks'].get() is None


def test_nested_and_concurrent_render_caches_are_isolated(helpers):
    barrier = Barrier(2)

    def render(width):
        mask = np.ones((24, width), np.uint8)
        with helpers.cache(mask.nbytes):
            stored = reference(helpers, mask)
            expected = helpers.rect(stored)
            outer = helpers.bubble['_reference_masks'].get()
            with helpers.cache(0):
                assert helpers.rect(stored) == expected
                assert not helpers.bubble['_reference_masks'].get()['rectangles']
            barrier.wait(timeout=10)
            assert helpers.bubble['_reference_masks'].get() is outer
            assert helpers.rect(stored) == expected == (0, 0, width, 24)
            return outer

    with ThreadPoolExecutor(2) as pool:
        left, right = list(pool.map(render, (20, 30)))
    assert left is not right
    assert left['rectangles'] == right['rectangles'] == {}
