"""Bounded adapter for BallonsTranslator's pinned manga balloon extractor.

The upstream module owns segmentation; this adapter validates masks and derives
an inset layout rectangle. Ambiguous/shared balloons fall back to OCR layout.
"""
from dataclasses import dataclass
import cv2
import numpy as np
from third_party.ballons_translator import extract_ballon_region


@dataclass
class Bubble:
    origin: tuple[int, int]
    interior: np.ndarray
    rectangle: np.ndarray

    def contains(self, changed):
        x, y = self.origin
        h, w = self.interior.shape
        inside = changed[y:y+h, x:x+w]
        return (np.count_nonzero(inside) == np.count_nonzero(changed)
                and not np.any(inside & ~self.interior))


def find_bubble(image, region, others):
    points = region.min_rect.reshape(-1, 2)
    if not np.isfinite(points).all():
        return None
    low, high = points.min(axis=0), points.max(axis=0)
    size = high - low
    if np.any(size < 3):
        return None
    height, width = image.shape[:2]
    center = (low + high) / 2
    # Bound work/memory independently of full-page dimensions.
    reach = min(512, max(96, float(size.max()) * 1.5))
    x0, y0 = np.maximum(0, np.floor(center - reach)).astype(int)
    x1, y1 = np.minimum([width, height], np.ceil(center + reach)).astype(int)
    crop = image[y0:y1, x0:x1]
    if not crop.size:
        return None
    try:
        interior, _, _ = extract_ballon_region(crop, [0, 0, crop.shape[1], crop.shape[0]], enlarge_ratio=1)
    except (ValueError, ZeroDivisionError, cv2.error):
        return None
    interior = np.where(interior > 127, 255, 0).astype(np.uint8)
    # Upstream can return the entire crop as a fallback. That is not a bubble.
    if (interior[:2].any() or interior[-2:].any() or interior[:, :2].any() or interior[:, -2:].any()):
        return None
    area = np.count_nonzero(interior)
    x, y, w, h = cv2.boundingRect(interior)
    if not (.8 * np.prod(size) <= area <= 16 * np.prod(size)) or area < .4 * w * h:
        return None
    if any(0 <= int(other.center[0]) - x0 < crop.shape[1]
           and 0 <= int(other.center[1]) - y0 < crop.shape[0]
           and interior[int(other.center[1]) - y0, int(other.center[0]) - x0] for other in others):
        return None
    inset = max(2, min(8, round(min(w, h) * .04)))
    interior = cv2.erode(interior, np.ones((2 * inset + 1, 2 * inset + 1), np.uint8)) > 0
    # Clipping a search crop at the page edge moves upstream's flood-fill seed.
    # Require the resulting balloon to belong to this OCR region, not a neighbor.
    seed_x, seed_y = np.rint(center - [x0, y0]).astype(int)
    if not (0 <= seed_x < interior.shape[1] and 0 <= seed_y < interior.shape[0]
            and interior[seed_y, seed_x]):
        return None
    moments = cv2.moments(interior.astype(np.uint8))
    if not moments['m00']:
        return None
    cx, cy = moments['m10'] / moments['m00'], moments['m01'] / moments['m00']
    for scale in np.arange(.95, .34, -.05):
        left, top = int(cx - w * scale / 2), int(cy - h * scale / 2)
        right, bottom = int(cx + w * scale / 2), int(cy + h * scale / 2)
        if left < 0 or top < 0 or right >= crop.shape[1] or bottom >= crop.shape[0]:
            continue
        if right - left < 10 or bottom - top < 10 or not interior[top:bottom+1, left:right+1].all():
            continue
        rectangle = np.array([[[left+x0, top+y0], [right+x0, top+y0],
                               [right+x0, bottom+y0], [left+x0, bottom+y0]]], dtype=np.float32)
        return Bubble((x0, y0), interior, rectangle)
    return None
