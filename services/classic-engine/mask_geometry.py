"""Exact mask-component matching with bounds pruning and lazy distances.

complete_mask adapted from manga-image-translator
95227a2bb0fd306cd4f0c104d57284026f991b3a, GPL-3.0; see
licenses/manga-image-translator-GPL-3.0.txt. Source hashes: third_party/analysis-sources.json.
"""
from typing import List
import cv2
import numpy as np
import shapely
from shapely.geometry import Polygon
from tqdm import tqdm
from manga_translator.utils import Quadrilateral
from manga_translator.mask_refinement.text_mask_utils import extend_rect, refine_mask


def assign_component(polys, areas, bounds, component, area, threshold):
    x0, y0, x1, y1 = component.bounds
    candidates = np.flatnonzero((bounds[:, 0] < x1) & (bounds[:, 2] > x0)
                               & (bounds[:, 1] < y1) & (bounds[:, 3] > y0))
    # Float32 and original array order preserve the upstream argmax/argmin ties.
    ratios = np.zeros(len(polys), dtype=np.float32)
    if candidates.size:
        ratios[candidates] = shapely.area(shapely.intersection(polys[candidates], component)) / np.minimum(area, areas[candidates])
    best = int(np.argmax(ratios))
    ratio = ratios[best]
    if area >= areas[best]:
        return None
    if ratio > threshold:
        return best, ratio, None
    distances = np.asarray(shapely.distance(polys, component.centroid), dtype=np.float32)
    return int(np.argmin(distances)), ratio, float(distances.min())


def complete_mask(img: np.ndarray, mask: np.ndarray, textlines: List[Quadrilateral], keep_threshold = 1e-2, dilation_offset = 0,kernel_size=3):
    bboxes = [txtln.aabb.xywh for txtln in textlines]
    polys = np.array([Polygon(txtln.pts) for txtln in textlines], dtype=object)
    areas = shapely.area(polys)
    bounds = shapely.bounds(polys)
    for (x, y, w, h) in bboxes:
        cv2.rectangle(mask, (x, y), (x + w, y + h), (0), 1)
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(mask)

    M = len(textlines)
    textline_ccs = [np.zeros_like(mask) for _ in range(M)]
    iinfo = np.iinfo(labels.dtype)
    textline_rects = np.full(shape = (M, 4), fill_value = [iinfo.max, iinfo.max, iinfo.min, iinfo.min], dtype = labels.dtype)
    valid = False
    for label in range(1, num_labels):
        # skip area too small
        if stats[label, cv2.CC_STAT_AREA] <= 9:
            continue

        x1 = stats[label, cv2.CC_STAT_LEFT]
        y1 = stats[label, cv2.CC_STAT_TOP]
        w1 = stats[label, cv2.CC_STAT_WIDTH]
        h1 = stats[label, cv2.CC_STAT_HEIGHT]
        area1 = stats[label, cv2.CC_STAT_AREA]
        cc_pts = np.array([[x1, y1], [x1 + w1, y1], [x1 + w1, y1 + h1], [x1, y1 + h1]])
        cc_poly = Polygon(cc_pts)

        assignment = assign_component(polys, areas, bounds, cc_poly, area1, keep_threshold)
        if assignment is None:
            continue
        avg, ratio, distance = assignment
        if ratio <= keep_threshold:
            unit = max(min([textlines[avg].font_size, w1, h1]), 10)
            if distance >= 0.5 * unit:
                continue

        textline_ccs[avg][y1:y1+h1, x1:x1+w1][labels[y1:y1+h1, x1:x1+w1] == label] = 255
        textline_rects[avg, 0] = min(textline_rects[avg, 0], x1)
        textline_rects[avg, 1] = min(textline_rects[avg, 1], y1)
        textline_rects[avg, 2] = max(textline_rects[avg, 2], x1 + w1)
        textline_rects[avg, 3] = max(textline_rects[avg, 3], y1 + h1)
        valid = True

    if not valid:
        return None

    # tblr to xywh
    textline_rects[:, 2] -= textline_rects[:, 0]
    textline_rects[:, 3] -= textline_rects[:, 1]

    final_mask = np.zeros_like(mask)
    img = cv2.bilateralFilter(img, 17, 80, 80)
    for i, cc in enumerate(tqdm(textline_ccs, '[mask]')):
        x1, y1, w1, h1 = textline_rects[i]
        text_size = min(w1, h1, textlines[i].font_size)
        x1, y1, w1, h1 = extend_rect(x1, y1, w1, h1, img.shape[1], img.shape[0], int(text_size * 0.1))
        dilate_size = max((int((text_size + dilation_offset) * 0.3) // 2) * 2 + 1, 3)
        kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_size, dilate_size))
        cc_region = np.ascontiguousarray(cc[y1: y1 + h1, x1: x1 + w1])
        if cc_region.size == 0:
            continue
        img_region = np.ascontiguousarray(img[y1: y1 + h1, x1: x1 + w1])
        cc_region = refine_mask(img_region, cc_region)
        cc[y1: y1 + h1, x1: x1 + w1] = cc_region
        x2, y2, w2, h2 = extend_rect(x1, y1, w1, h1, img.shape[1], img.shape[0], -(-dilate_size // 2))
        cc[y2:y2+h2, x2:x2+w2] = cv2.dilate(cc[y2:y2+h2, x2:x2+w2], kern)
        final_mask[y2:y2+h2, x2:x2+w2] = cv2.bitwise_or(final_mask[y2:y2+h2, x2:x2+w2], cc[y2:y2+h2, x2:x2+w2])
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    return cv2.dilate(final_mask, kern)
