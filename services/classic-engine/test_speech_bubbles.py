"""Synthetic boundaries: no weights, source comics or network required."""
from types import SimpleNamespace
import cv2
import numpy as np
from speech_bubbles import find_bubble
from pathlib import Path
import hashlib
import json


def region(x=130, y=110, w=60, h=80):
    return SimpleNamespace(min_rect=np.array([[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]], dtype=float),
                           center=np.array([x+w/2, y+h/2]))


def page():
    image = np.full((300, 320, 3), 120, np.uint8)
    cv2.ellipse(image, (160, 150), (100, 115), 0, 0, 360, (255,255,255), -1)
    cv2.ellipse(image, (160, 150), (100, 115), 0, 0, 360, (0,0,0), 4)
    return image


def test_closed_bubble_has_inset_mask_and_rejects_outside_glyphs():
    bubble = find_bubble(page(), region(), [])
    assert bubble is not None
    changed = np.zeros((300,320), bool)
    changed[150,160] = True
    assert bubble.contains(changed)
    changed[40,60] = True
    assert not bubble.contains(changed)
    assert bubble.contains(np.ones((3, 3), bool), (159, 149))
    assert not bubble.contains(np.ones((3, 3), bool), (-1, 149))


def test_unbounded_background_and_ambiguous_shared_bubble_fall_back():
    assert find_bubble(np.full((300,320,3),255,np.uint8), region(), []) is None
    assert find_bubble(page(), region(), [region(170,120,20,20)]) is None


def test_open_border_falls_back_instead_of_treating_page_as_bubble():
    image = page()
    image[140:160, 50:162] = 255
    image[:, :65] = 255
    assert find_bubble(image, region(), []) is None


def test_page_edge_crop_does_not_assign_neighboring_bubble():
    image = np.full((300, 320, 3), 120, np.uint8)
    cv2.ellipse(image, (65, 150), (40, 85), 0, 0, 360, (255, 255, 255), -1)
    cv2.ellipse(image, (65, 150), (40, 85), 0, 0, 360, (0, 0, 0), 4)
    assert find_bubble(image, region(0, 110, 20, 80), []) is None


def test_top_page_bubble_keeps_its_source_center_when_enlarging():
    image = np.full((1000, 600, 3), 120, np.uint8)
    cv2.ellipse(image, (250, 145), (140, 100), 0, 0, 360, (255, 255, 255), -1)
    cv2.ellipse(image, (250, 145), (140, 100), 0, 0, 360, (0, 0, 0), 4)
    assert find_bubble(image, region(170, 100, 160, 90), []) is not None


def test_irregular_interior_does_not_require_a_centroid_rectangle(monkeypatch):
    import speech_bubbles
    interior = np.zeros((120, 120), np.uint8)
    cv2.rectangle(interior, (10, 10), (109, 109), 255, -1)
    cv2.rectangle(interior, (38, 38), (81, 81), 0, -1)
    monkeypatch.setattr(speech_bubbles, 'extract_ballon_region', lambda *a, **k: (interior, None, None))
    # This closed interior contains the complete source, but its centroid is in
    # a hole. The unused old centered-rectangle search rejected it outright.
    bubble = speech_bubbles._extract_window(np.zeros((120, 120, 3), np.uint8),
        region(16, 35, 16, 50), [], (0, 0, 120, 120), np.array([16, 50]))
    assert bubble is not None
    assert bubble.contains(np.ones((10, 8), bool), (20, 45))


def test_vendored_ballons_translator_source_and_license_integrity():
    root = Path(__file__).parent
    manifest = json.loads((root/'third_party/ballons-translator.json').read_text())
    code = (root/'third_party/ballons_translator.py').read_text(encoding='utf-8')
    license = (root/'licenses/BallonsTranslator-GPL-3.0.txt').read_text(encoding='utf-8')
    assert hashlib.sha256(code.encode()).hexdigest() == manifest['vendored_sha256_lf']
    assert hashlib.sha256(license.encode()).hexdigest() == manifest['license_sha256']
