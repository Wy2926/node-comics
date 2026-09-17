"""Bounded LaMa crops. Every prediction reads the original, never another crop's output."""
import cv2
import numpy as np


def _bounds(mask, box):
    x0, y0, x1, y1 = box
    view = mask[y0:y1, x0:x1]
    rows = np.flatnonzero(np.any(view, axis=1))
    if not len(rows):
        return None
    cols = np.flatnonzero(np.any(view, axis=0))
    return x0 + int(cols[0]), y0 + int(rows[0]), x0 + int(cols[-1]) + 1, y0 + int(rows[-1]) + 1


def _union(a, b):
    return min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])


def _merge_overlaps(boxes):
    # Component rectangles can overlap even when the component pixels do not.
    # Merge them so every erased pixel has exactly one output owner.
    merged = []
    for box in boxes:
        index = 0
        while index < len(merged):
            other = merged[index]
            if box[0] < other[2] and other[0] < box[2] and box[1] < other[3] and other[1] < box[3]:
                box = _union(box, merged.pop(index))
                index = 0
            else:
                index += 1
        merged.append(box)
    return merged


def plan_regions(mask, max_size, padding, merge_gap):
    """Return (owned core, context crop) rectangles, with exclusive right/bottom edges."""
    if mask.ndim != 2 or mask.dtype != np.uint8:
        raise ValueError('Invalid inpainting mask')
    if not (128 <= max_size <= 1024 and 8 <= padding < max_size // 4 and 0 <= merge_gap <= 64):
        raise ValueError('Invalid crop configuration')
    height, width = mask.shape
    bounds = _bounds(mask, (0, 0, width, height))
    if bounds is None:
        return []
    binary = (mask > 0).astype(np.uint8)
    grouped = cv2.dilate(binary, np.ones((merge_gap + 1, merge_gap + 1), dtype=np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(grouped, connectivity=8)
    del labels, grouped, binary
    # Bound planning work on pathological masks without dropping any text pixels.
    if count > 513:
        boxes = [bounds]
    else:
        boxes = _merge_overlaps([(int(x), int(y), int(x + w), int(y + h)) for x, y, w, h, _ in stats[1:]])
    core_limit = max_size - 2 * padding
    pending = boxes
    cores = []
    while pending:
        box = _bounds(mask, pending.pop())
        if box is None:
            continue
        x0, y0, x1, y1 = box
        w, h = x1 - x0, y1 - y0
        if max(w, h) <= core_limit:
            cores.append(box)
            continue
        # Prefer a gap near the middle to avoid splitting letters. Dense oversized
        # regions still split, with surrounding context supplied on both sides.
        vertical = w >= h
        length = w if vertical else h
        occupied = np.count_nonzero(mask[y0:y1, x0:x1], axis=0 if vertical else 1)
        candidates = range(max(1, length // 3), min(length, 2 * length // 3 + 1))
        cut = min(candidates, key=lambda n: (int(occupied[n]), abs(n - length // 2), n))
        if vertical:
            pending.extend([(x0, y0, x0 + cut, y1), (x0 + cut, y0, x1, y1)])
        else:
            pending.extend([(x0, y0, x1, y0 + cut), (x0, y0 + cut, x1, y1)])
    return [(core, (max(0, core[0] - padding), max(0, core[1] - padding),
                    min(width, core[2] + padding), min(height, core[3] + padding)))
            for core in sorted(cores, key=lambda b: (b[1], b[0], b[3], b[2]))]


def prepare_crop(image, mask, crop):
    x0, y0, x1, y1 = crop
    return image[y0:y1, x0:x1].copy(), mask[y0:y1, x0:x1].copy()


def paste_crop(output, mask, predicted, core, crop):
    x0, y0, x1, y1 = crop
    if predicted.shape != (y1 - y0, x1 - x0, 3) or predicted.dtype != np.uint8:
        raise ValueError('Invalid inpainting crop result')
    cx0, cy0, cx1, cy1 = core
    owned = mask[cy0:cy1, cx0:cx1] > 0
    target = output[cy0:cy1, cx0:cx1]
    result = predicted[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
    target[owned] = result[owned]


async def inpaint_regions(image, mask, predict, *, max_size, padding, merge_gap, run_cpu=None):
    async def cpu(function, *args, **kwargs):
        return await run_cpu(function, *args, **kwargs) if run_cpu else function(*args, **kwargs)

    if image.ndim != 3 or image.shape[2] != 3 or image.dtype != np.uint8 or image.shape[:2] != mask.shape:
        raise ValueError('Invalid inpainting image')
    output = await cpu(image.copy)
    for core, crop in await cpu(plan_regions, mask, max_size, padding, merge_gap):
        # Include all masked text in the context, so nearby letters are not treated
        # as background. Only this core's mask is pasted back, once.
        crop_image, crop_mask = await cpu(prepare_crop, image, mask, crop)
        predicted = await predict(crop_image, crop_mask)
        await cpu(paste_crop, output, mask, predicted, core, crop)
    return output
