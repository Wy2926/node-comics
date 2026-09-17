"""Bounded adapter for BallonsTranslator's pinned manga balloon extractor.

The upstream module owns segmentation; this adapter validates inset masks.
The page typesetter owns rectangle fitting and handles shared balloons.
"""
from dataclasses import dataclass
import cv2
import numpy as np
from third_party.ballons_translator import extract_ballon_region


@dataclass
class Bubble:
    origin: tuple[int, int]
    interior: np.ndarray
    def contains(self, changed, origin=(0, 0)):
        # Limit all work to the supplied ink layer, never its surrounding page.
        left, top, width, height = cv2.boundingRect(changed.astype(np.uint8, copy=False))
        if not width or not height:
            return True
        x, y = self.origin
        h, w = self.interior.shape
        dx, dy = origin[0] + left - x, origin[1] + top - y
        if dx < 0 or dy < 0 or dx + width > w or dy + height > h:
            return False
        return not np.any(changed[top:top+height, left:left+width]
                          & ~self.interior[dy:dy+height, dx:dx+width])


def find_bubble(image, region, others):
    """Try bounded upstream search windows, retaining a complete source region."""
    points = region.min_rect.reshape(-1, 2)
    if not np.isfinite(points).all():
        return None
    height, width = image.shape[:2]
    low = np.maximum(0, np.floor(points.min(axis=0))).astype(int)
    high = np.minimum([width, height], np.ceil(points.max(axis=0))).astype(int)
    size = high - low
    if np.any(size < 3):
        return None
    center = (low + high) / 2
    max_radius = min(512, center[0], center[1], width - center[0], height - center[1])
    windows = set()
    for scale in (.75, 1, 1.5):
        radius = min(max_radius, max(48, float(size.max()) * scale))
        bounds = tuple(np.rint([*(center - radius), *(center + radius)]).astype(int))
        if bounds in windows:
            continue
        windows.add(bounds)
        bubble = _extract_window(image, region, others, bounds, size)
        if bubble is not None:
            return bubble
    return None


def _extract_window(image, region, others, bounds, size):
    points = region.min_rect.reshape(-1, 2)
    low, high = points.min(axis=0), points.max(axis=0)
    center = (low + high) / 2
    x0, y0, x1, y1 = bounds
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
    if area > .85 * interior.size:
        return None
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
    # An extracted fragment is not a usable balloon for this complete text block.
    source = np.zeros(interior.shape, np.uint8)
    polygons = np.asarray(getattr(region, 'lines', region.min_rect)).reshape(-1, 4, 2)
    polygons = (polygons - [x0, y0]).astype(np.int32)
    cv2.fillPoly(source, list(polygons), 255)
    if np.any((source > 0) & ~interior):
        return None
    return Bubble((x0, y0), interior)
