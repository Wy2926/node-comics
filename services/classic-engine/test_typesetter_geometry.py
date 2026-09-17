"""Exact rectangle and deterministic tie parity with the pinned renderer."""
import ast
from itertools import product
from pathlib import Path

import numpy as np
import pytest

from typesetter_geometry import find_largest_inscribed_rect


@pytest.fixture(scope='module')
def upstream():
    source = Path(__file__).resolve().parents[2] / 'engines/manga-typesetter/manga_translator/rendering/__init__.py'
    if not source.exists():
        pytest.skip('Pinned typesetter source is not installed')
    tree = ast.parse(source.read_text(encoding='utf-8'))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'find_largest_inscribed_rect')
    namespace = {'np': np}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
    return namespace['find_largest_inscribed_rect']


def brute_force(mask):
    candidates = []
    h, w = mask.shape
    for top in range(h):
        for bottom in range(top + 1, h + 1):
            for left in range(w):
                for right in range(left + 1, w + 1):
                    if np.all(mask[top:bottom, left:right] > 0):
                        height, width = bottom - top, right - left
                        candidates.append(((-height * width, bottom, right, -height), (left, top, width, height)))
    return min(candidates)[1] if candidates else (0, 0, 0, 0)


def test_all_small_masks_against_independent_exhaustive_search():
    for values in product((0, 1), repeat=9):
        mask = np.array(values, dtype=np.uint8).reshape(3, 3)
        assert find_largest_inscribed_rect(mask) == brute_force(mask)


def test_all_three_by_four_masks_match_upstream_including_ties(upstream):
    for values in product((0, 1), repeat=12):
        mask = np.array(values, dtype=np.uint8).reshape(3, 4)
        assert find_largest_inscribed_rect(mask) == upstream(mask)


def test_random_holes_disconnected_regions_and_strides(upstream):
    rng = np.random.default_rng(814)
    for density in (.05, .3, .7, .95):
        for shape in ((1, 100), (100, 1), (16, 31), (39, 27)):
            for _ in range(12):
                mask = (rng.random(shape) < density).astype(np.uint8) * 255
                for view in (mask, mask.T, mask[::-1, ::-1]):
                    original = view.copy()
                    assert find_largest_inscribed_rect(view) == upstream(view)
                    np.testing.assert_array_equal(view, original)


def test_repeated_rows_preserve_earliest_bottom_and_taller_ties(upstream):
    rng = np.random.default_rng(91)
    for _ in range(100):
        seed = rng.random((7, 19)) < .7
        mask = np.repeat(seed, rng.integers(1, 18, size=7), axis=0)
        padded = np.pad(mask, ((4, 9), (8, 11)))
        assert find_largest_inscribed_rect(padded) == upstream(padded)


def test_large_page_sparse_geometry():
    mask = np.zeros((6000, 4000), np.uint8)
    mask[2150:2350, 1600:1750] = 255
    assert find_largest_inscribed_rect(mask) == (1600, 2150, 150, 200)
    mask[2200:2250, 1600:1620] = 0
    assert find_largest_inscribed_rect(mask) == (1620, 2150, 130, 200)


@pytest.mark.parametrize('language', ['en', 'ja', 'zh-Hans', 'zh-Hant'])
def test_complete_long_text_layout_is_pixel_identical(upstream, language):
    from unittest.mock import patch
    from test_lettering import sample, run, TEXTS, ROOT
    from hyphenation import DictionaryStore
    from typesetter import initialize
    renderer = initialize(DictionaryStore(ROOT / 'engines/mit-models/hyphenation', list(TEXTS)))
    image, mask, analysis = sample()
    analysis['unrecognized_regions'] = [[[240, 120], [280, 120], [280, 165], [240, 165]]]
    with patch.object(renderer, 'find_largest_inscribed_rect', upstream):
        before, before_layout = run(image, mask, analysis, {'b001': TEXTS[language]}, language)
    with patch.object(renderer, 'find_largest_inscribed_rect', find_largest_inscribed_rect):
        after, after_layout = run(image, mask, analysis, {'b001': TEXTS[language]}, language)
    np.testing.assert_array_equal(before[0], after[0])
    np.testing.assert_array_equal(before[1], after[1])
    assert before[2:] == after[2:]
    assert before_layout == after_layout


@pytest.mark.parametrize('mask', [np.zeros((0, 0)), np.zeros((4, 0)), np.zeros((0, 4)), np.zeros((7, 9)), np.zeros((2, 3, 4))])
def test_empty_and_invalid_geometry(mask):
    assert find_largest_inscribed_rect(mask) == (0, 0, 0, 0)
