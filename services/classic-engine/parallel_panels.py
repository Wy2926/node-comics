"""Overlap original panel detection with OCR without changing reading order.

Sorting adapted from manga-image-translator@95227a2bb0fd306cd4f0c104d57284026f991b3a
utils/sort.py, GPL-3.0; see licenses/manga-image-translator-GPL-3.0.txt.
"""
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
import multiprocessing

from panel_geometry import get_panels_from_array
from manga_translator.utils.sort import _simple_sort, _sort_panels_fill, sort_regions


def detect_panels(image, right_to_left, opencv_threads):
    import cv2
    cv2.setNumThreads(opencv_threads)
    return get_panels_from_array(image, rtl=right_to_left)


class ParallelPanels:
    """One bounded CPU worker; upstream panel options/debug state is not reentrant.

    The caller owns the device/stage lock. Finish each future before releasing it,
    including no-text and failed pages, so images cannot accumulate in the queue.
    """
    def __init__(self, mode='process', opencv_threads=2):
        self.opencv_threads = opencv_threads
        if mode == 'thread':
            self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='panels')
        else:
            self.executor = ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn'))

    def submit(self, image, right_to_left):
        return self.executor.submit(detect_panels, image, right_to_left, self.opencv_threads)

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)


def sort_with_panels(regions, future, right_to_left):
    if not regions:
        return []
    try:
        panels = [(x, y, x+w, y+h) for x, y, w, h in future.result()]
        panels = _sort_panels_fill(panels, right_to_left)
        for region in regions:
            cx, cy = region.center
            region.panel_index = -1
            for index, (x1, y1, x2, y2) in enumerate(panels):
                if x1 <= cx <= x2 and y1 <= cy <= y2:
                    region.panel_index = index
                    break
            if region.panel_index < 0:
                distances = [((max(x1-cx, 0, cx-x2))**2 + (max(y1-cy, 0, cy-y2))**2, i)
                             for i, (x1, y1, x2, y2) in enumerate(panels)]
                if distances:
                    region.panel_index = min(distances)[1]
        grouped = {}
        for region in regions:
            grouped.setdefault(region.panel_index, []).append(region)
        return [region for index in sorted(grouped)
                for region in sort_regions(grouped[index], right_to_left, img=None, force_simple_sort=False)]
    except Exception:
        # Match the upstream failure path; don't log image content or filenames.
        return _simple_sort(regions, right_to_left)
