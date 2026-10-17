"""Pinned CRF parity and source-mask protection without model assets."""
from types import SimpleNamespace
from textwrap import dedent

import cv2
import numpy as np
import pytest
from shapely.geometry import Polygon
from shapely.geometry.base import BaseGeometry

from mtu_engine.assets import LOCK


def extend_rect(x, y, w, h, max_x, max_y, extend_size):
    # Pinned upstream geometry, including its right/bottom exclusive margin.
    x1, y1 = max(x - extend_size, 0), max(y - extend_size, 0)
    return x1, y1, min(w + extend_size * 2, max_x - x1 - 1), min(h + extend_size * 2, max_y - y1 - 1)


def core_versions():
    patch = LOCK['source']['patches']['manga_translator/mask_refinement/text_mask_utils.py'][0]
    functions, inputs = [], []
    for version in ('before', 'after'):
        captured = []

        def refine(rgb, mask, captured=captured):
            captured.append((rgb.copy(), mask.copy()))
            return np.where((mask > 0) & (rgb[:, :, 0] > 100), 255, 0).astype(np.uint8)

        scope = dict(np=np, cv2=cv2, Polygon=Polygon, List=list, Quadrilateral=object,
                     tqdm=lambda items, *a, **k: items, extend_rect=extend_rect, refine_mask=refine)
        exec(patch[version], scope)
        functions.append(scope['_complete_mask_core'])
        inputs.append(captured)
    return functions, inputs


@pytest.mark.parametrize('threshold', [.01, .75])
def test_local_filter_and_lazy_geometry_preserve_native_crf_inputs(threshold, monkeypatch):
    (before, after), captured = core_versions()
    rng = np.random.default_rng(905)
    distance, calls = BaseGeometry.distance, []

    def counted(poly, point):
        calls.append(True)
        return distance(poly, point)

    monkeypatch.setattr(BaseGeometry, 'distance', counted)
    for index in range(16):
        rgb = rng.integers(0, 256, (87, 123, 3), dtype=np.uint8)
        if index % 2:
            rgb = rgb[::-1, ::-1]  # Strided inputs and original image edges.
        mask = np.zeros(rgb.shape[:2], np.uint8)
        lines = []
        for x, y, w, h in ((0, 0, 45, 27), (30, 20, 39, 20), (88, 60, 34, 26), (70, 4, 12, 9)):
            pts = np.array([[x, y], [x + w, y], [x + w - 3, y + h], [x + 2, y + h]], np.float32)
            lines.append(SimpleNamespace(pts=pts, aabb=SimpleNamespace(xywh=(x, y, w, h)), font_size=18))
            if x != 70:  # A valid line with no components must still be skipped.
                mask[y + 2:y + h - 2:6, x + 2:x + w - 2] = 255
                mask[y + 3:y + h - 2:6, x + 2:x + w - 2] = 255
        if index == 15:
            mask.fill(0)
        snapshot = rgb.copy()
        for entries in captured:
            entries.clear()
        expected = before(rgb, mask.copy(), lines, keep_threshold=threshold, show_progress=False)
        calls.clear()
        actual = after(rgb, mask.copy(), lines, keep_threshold=threshold, show_progress=False)
        if threshold == .01:
            assert calls == []
        if expected is None:
            assert actual is None
        else:
            np.testing.assert_array_equal(actual, expected)
            assert captured[0] and len(captured[0]) == len(captured[1])
            for native, local in zip(*captured):
                for a, b in zip(native, local):
                    np.testing.assert_array_equal(a, b)
        np.testing.assert_array_equal(rgb, snapshot)


def test_fallback_distance_is_still_evaluated_when_threshold_requires_it(monkeypatch):
    (before, after), _ = core_versions()
    rgb = np.full((40, 60, 3), 180, np.uint8)
    mask = np.zeros(rgb.shape[:2], np.uint8)
    mask[10:14, 3:16] = 255
    line = SimpleNamespace(pts=np.array([[10, 5], [35, 5], [35, 30], [10, 30]]),
                           aabb=SimpleNamespace(xywh=(5, 2, 35, 32)), font_size=20)
    expected = before(rgb, mask.copy(), [line], keep_threshold=.75)
    calls, distance = [], BaseGeometry.distance

    def counted(poly, point):
        calls.append(True)
        return distance(poly, point)

    monkeypatch.setattr(BaseGeometry, 'distance', counted)
    actual = after(rgb, mask.copy(), [line], keep_threshold=.75)
    assert calls
    np.testing.assert_array_equal(actual, expected)


@pytest.mark.parametrize('dtype', [np.uint8, np.int16, np.float32])
def test_bubble_clipping_keeps_holes_negative_values_and_owned_output(dtype):
    patches = LOCK['source']['patches']['manga_translator/mask_refinement/__init__.py']
    patch = next(p for p in patches if p['before'].startswith('def _clip_refined_components'))
    versions = []
    for key in ('before', 'after'):
        scope = dict(np=np, cv2=cv2, Tuple=tuple)
        exec(patch[key], scope)
        versions.append(scope['_clip_refined_components_by_bubble_mask'])
    rng = np.random.default_rng(904)
    for _ in range(20):
        mask = (rng.random((43, 61)) > .7).astype(dtype) * 255
        bubble = (rng.random(mask.shape) > .4).astype(dtype) * 255
        if dtype != np.uint8:
            mask[mask == 0] = -1
            bubble[bubble == 0] = -1
        snapshots = mask.copy(), bubble.copy()
        expected, actual = (fn(mask, bubble) for fn in versions)
        assert expected[1:] == actual[1:]
        np.testing.assert_array_equal(expected[0], actual[0])
        assert actual[0].dtype == np.uint8 and not np.shares_memory(actual[0], mask)
        np.testing.assert_array_equal(mask, snapshots[0])
        np.testing.assert_array_equal(bubble, snapshots[1])


def protected_refinement(raw, refined, lines, bubble=None):
    """Execute the shipped patch snippets without importing model dependencies."""
    patches = LOCK['source']['patches']['manga_translator/mask_refinement/__init__.py']
    support = next(p['after'] for p in patches if p['before'].startswith('    if use_model_bubble'))
    scope = dict(np=np, cv2=cv2, raw_mask=raw, final_mask=refined.copy(), text_regions=[],
                 kernel_size=3, _build_line_protect_mask=lambda regions, shape, expand_px: lines)
    exec(dedent(support[:support.rindex('    if use_model_bubble')]), scope)
    if bubble is None:
        return scope['final_mask']
    clip = next(p['after'] for p in patches if p['before'].startswith('def _clip_refined_components'))
    scope['Tuple'] = tuple
    exec(clip, scope)
    scope['mask_before_clip'] = scope['final_mask']
    scope['clipped_mask'] = scope['_clip_refined_components_by_bubble_mask'](scope['final_mask'], bubble)[0]
    restore = next(p['after'] for p in patches if 'protected_restore_mask =' in p['before'])
    exec(dedent(restore), scope)
    scope['clipped_mask'][scope['protected_restore_mask']] = 255
    return scope['clipped_mask']


@pytest.mark.parametrize('resized', [False, True])
def test_refinement_restores_detected_strokes_not_entire_selected_line_boxes(resized):
    raw = np.zeros((40, 60), np.uint8)
    raw[14:17, 16:26] = 255
    raw[30:33, 45:50] = 255  # An unselected paragraph must not be erased.
    raw[3, 3] = 80  # Weak support outside selected text must not be added either.
    raw = cv2.resize(raw, (120, 80), interpolation=cv2.INTER_NEAREST) if resized else raw
    raw.flags.writeable = False
    lines = np.zeros((40, 60), np.uint8)
    lines[9:23, 10:32] = 255
    refined = np.zeros_like(lines)
    refined[12:20, 12:30] = 255
    refined[15, :] = 0  # Component splitting/CRF left a seam through known text.
    snapshots = raw.copy(), refined.copy(), lines.copy()
    result = protected_refinement(raw, refined, lines)
    assert np.all(result[14:17, 16:26] == 255)
    assert result[15, 14] == 255  # Native 2px guard closes the seam beside the stroke.
    assert result[9, 10] == 0 and result[31, 47] == 0 and result[3, 3] == 0
    assert not np.any((result > 0) & (refined == 0) & (lines == 0))
    for actual, original in zip((raw, refined, lines), snapshots):
        np.testing.assert_array_equal(actual, original)


@pytest.mark.parametrize('edge', range(4))
def test_bubble_clip_preserves_source_at_page_edges_but_keeps_holes_and_unselected_text(edge):
    raw = np.zeros((50, 50), np.uint8)
    raw[1:7, 12:33] = 255
    raw[1:3, 21:24] = 0  # A short gap in the raw mask must not seed LaMa ghosts.
    raw[38:42, 12:33] = 255  # A separate unselected paragraph.
    refined = np.zeros_like(raw)
    refined[:30, 10:36] = 255
    lines = np.zeros_like(raw)
    lines[4:10, 12:33] = 255
    bubble = np.zeros_like(raw)
    bubble[3:36, 8:38] = 255
    bubble[19:23, 19:25] = 0
    raw, refined, lines, bubble = (np.rot90(a, edge).copy() for a in (raw, refined, lines, bubble))
    result = np.rot90(protected_refinement(raw, refined, lines, bubble), -edge)
    assert np.all(result[:3, 12:33] == 255)
    assert result[20, 21] == 0  # A genuine bubble hole, without text support.
    assert result[0, 35] == 0  # Unsupported dilation is still clipped.
    assert not np.any(result[38:42])
