"""Exact mask rectangle search without Python loops over page pixels.

The pinned renderer's histogram stack visits every page pixel per text block.
Keep its maximum-area result and tie order (bottom, right, then taller first),
but restrict work to foreground bounds, merge identical rows and resolve each
histogram's nearest-smaller boundaries with NumPy pointer jumping.
"""
import numpy as np


def _left_smaller(heights):
    """Nearest strictly shorter bar on the left, or -1 (all columns at once)."""
    previous = np.arange(len(heights), dtype=np.intp) - 1
    active = np.flatnonzero(previous >= 0)
    while active.size:
        active = active[heights[previous[active]] >= heights[active]]
        if not active.size:
            break
        previous[active] = previous[previous[active]]
        active = active[previous[active] >= 0]
    return previous


def find_largest_inscribed_rect(mask):
    binary = np.asarray(mask) > 0
    if binary.ndim != 2:
        return 0, 0, 0, 0
    occupied_rows = np.flatnonzero(np.any(binary, axis=1))
    if not occupied_rows.size:
        return 0, 0, 0, 0
    top, bottom = int(occupied_rows[0]), int(occupied_rows[-1]) + 1
    occupied_columns = np.flatnonzero(np.any(binary[top:bottom], axis=0))
    left, right = int(occupied_columns[0]), int(occupied_columns[-1]) + 1
    binary = binary[top:bottom, left:right]
    height, width = binary.shape
    if np.all(binary):
        return left, top, width, height

    # Within identical rows, bar ordering/widths stay fixed and positive areas
    # strictly grow. Only the final row can be the global maximum.
    ends = np.r_[np.flatnonzero(np.any(binary[1:] != binary[:-1], axis=1)), height - 1]
    heights = np.zeros(width, dtype=np.int64)
    best_area, best_rect, previous_end = 0, (0, 0, 0, 0), -1
    for end in ends:
        heights = np.where(binary[end], heights + int(end) - previous_end, 0)
        previous_end = int(end)
        lower_left = _left_smaller(heights)
        lower_right = width - 1 - _left_smaller(heights[::-1])[::-1]
        widths = lower_right - lower_left - 1
        areas = heights * widths
        area = int(areas.max())
        if area <= best_area:
            continue
        candidates = np.flatnonzero(areas == area)
        # Upstream pops bars from left to right; at the same right boundary it
        # visits taller bars first. Equal bars describe the same max rectangle.
        index = candidates[np.lexsort((-heights[candidates], lower_right[candidates]))[0]]
        best_area = area
        best_rect = (left + int(lower_left[index]) + 1,
                     top + int(end) - int(heights[index]) + 1,
                     int(widths[index]), int(heights[index]))
    return best_rect
