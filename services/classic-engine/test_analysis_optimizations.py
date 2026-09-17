"""CPU/CUDA positional parity, exact mask assignment and panel candidate order."""
import copy
import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import pytest
import shapely
from shapely.geometry import Polygon, box
import torch

from manga_translator.ocr.xpos_relative_position import XPOS
from manga_translator.mask_refinement.text_mask_utils import complete_mask as original_mask
from manga_translator.utils.panel import get_panels_from_array as original_panels
from manga_translator.utils import Quadrilateral
from mask_geometry import assign_component, complete_mask
from panel_geometry import nearby_vertices, get_panels_from_array
from ocr_position_cache import PositionCache


def test_adapted_upstream_sources_match_recorded_revision():
    directory = Path(__file__).resolve().parent
    manifest = json.loads((directory / 'third_party/analysis-sources.json').read_text())
    root = directory.parents[1] / 'engines/mit-native/manga_translator'
    for row in manifest['files']:
        raw = (root / row['path']).read_text(encoding='utf-8').encode()
        assert hashlib.sha256(raw).hexdigest() == row['sha256']


@pytest.mark.parametrize('device', ['cpu', 'cuda:0'])
def test_position_cache_exact_values_devices_invalidation_and_bounds(device):
    if device.startswith('cuda') and not torch.cuda.is_available():
        pytest.skip('CUDA hardware unavailable')
    network = torch.nn.Sequential(XPOS(40), XPOS(40)).to(device)
    originals = [m.forward for m in network]
    cache = PositionCache(network, max_bytes=65536, max_entries=8)
    with torch.no_grad():
        for length, offset in [(1, 0), (13, 2), (24, 15), (101, 0), (1, 21), (3, 0)]:
            for downscale in (True, False):
                x = torch.randn(4, length, 40, device=device)
                for module, original in zip(network, originals):
                    expected = original(x, offset, downscale)
                    actual = module(x, offset, downscale)
                    assert torch.equal(expected, actual)
                    assert cache.size <= cache.max_bytes and len(cache.entries) <= 8
        assert cache.hits > 0
        network[0].scale.add_(.01)
        x = torch.randn(2, 7, 40, device=device)
        assert torch.equal(network[0](x), originals[0](x))
        network.to(dtype=torch.float64)
        x = x.double()
        assert torch.equal(network[0](x, 3), originals[0](x, 3))
    cache.close()
    assert cache.size == 0 and not cache.entries


def test_cache_bypasses_training_and_oversized_entries():
    model = XPOS(40)
    original = model.forward
    cache = PositionCache(model, max_bytes=1, max_entries=1)
    x = torch.randn(2, 7, 40, requires_grad=True)
    model(x).sum().backward()
    assert x.grad is not None and cache.misses == 0
    with torch.no_grad():
        assert torch.equal(model(x), original(x))
    assert not cache.entries and cache.size == 0
    cache.close()


def old_assignment(polys, component, area, threshold):
    ratios = np.array([p.intersection(component).area / min(area, p.area) for p in polys], np.float32)
    distances = np.array([p.distance(component.centroid) for p in polys], np.float32)
    best = int(np.argmax(ratios))
    if area >= polys[best].area:
        return None
    if ratios[best] > threshold:
        return best, ratios[best], None
    return int(np.argmin(distances)), ratios[best], float(distances.min())


def test_mask_matches_full_pairing_for_ties_disjoint_rotated_and_nearest():
    rng = np.random.default_rng(492)
    for _ in range(100):
        centers = rng.integers(-50, 150, size=(12, 2))
        polys = np.array([Polygon([(x, y), (x+10, y-8), (x+23, y+15), (x+4, y+19)]) for x, y in centers], object)
        polys[-1] = polys[0]  # stable tie order
        x, y = rng.integers(-50, 150, size=2)
        component = box(x, y, x+12, y+13)
        for area in (10, 100, 1000):
            expected = old_assignment(polys, component, area, .01)
            actual = assign_component(polys, shapely.area(polys), shapely.bounds(polys), component, area, .01)
            assert actual == expected


def test_far_components_skip_expensive_intersections():
    polys = np.array([box(100, 100, 140, 140), box(200, 200, 240, 240)], object)
    with patch('mask_geometry.shapely.intersection', side_effect=AssertionError('No overlap')):
        assert assign_component(polys, shapely.area(polys), shapely.bounds(polys), box(0, 0, 3, 3), 9, .01)[0] == 0


def test_real_mask_algorithm_matches_pixels():
    rng = np.random.default_rng(80)
    image = rng.integers(0, 256, size=(160, 240, 3), dtype=np.uint8)
    lines = [Quadrilateral(np.array([[x,y],[x+55,y],[x+55,y+22],[x,y+22]]), '', .99)
             for x,y in [(10,20),(140,20),(30,100),(130,100)]]
    mask = np.zeros(image.shape[:2], np.uint8)
    for x,y in [(15,25),(30,25),(145,25),(35,105),(135,105),(180,65)]:
        cv2.rectangle(mask, (x,y), (x+9,y+9), 255, -1)
    for dilation in (0, 3):
        before = original_mask(image.copy(), mask.copy(), copy.deepcopy(lines), dilation_offset=dilation)
        after = complete_mask(image.copy(), mask.copy(), copy.deepcopy(lines), dilation_offset=dilation)
        np.testing.assert_array_equal(before, after)


def test_panel_nearby_pairs_keep_order():
    rng = np.random.default_rng(42)
    for count in (0, 1, 4, 30, 200):
        polygon = rng.integers(-200, 200, size=(count, 1, 2))
        expected = [(i,j) for i in range(count-3) for j in range(i+3,count)
                    if abs(int(polygon[i,0,0])-int(polygon[j,0,0])) <= 40
                    and abs(int(polygon[i,0,1])-int(polygon[j,0,1])) <= 50]
        assert nearby_vertices(polygon, 3, 40, 50) == expected


@pytest.mark.parametrize('rtl', [True, False])
def test_in_memory_panels_match_upstream_without_files(rtl):
    sample = Path(__file__).resolve().parents[2] / 'samples/starlight-bookshop.png'
    image = cv2.cvtColor(cv2.imread(str(sample)), cv2.COLOR_BGR2RGB)
    blank = np.full((400, 300, 3), 255, np.uint8)
    grid = blank.copy()
    for bounds in [((10,10),(140,180)), ((160,10),(290,180)), ((10,210),(290,390))]:
        cv2.rectangle(grid, *bounds, (0,0,0), 4)
    for candidate in (image, blank, grid):
        before = original_panels(candidate, rtl)
        with patch('cv2.imwrite', side_effect=AssertionError('No files')), patch('cv2.imread', side_effect=AssertionError('No files')):
            after = get_panels_from_array(candidate, rtl)
        assert after == before
