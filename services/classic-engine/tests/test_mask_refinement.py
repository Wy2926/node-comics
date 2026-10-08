"""Pinned refinement parity without model assets; CRF inputs must be identical."""
from types import SimpleNamespace

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
