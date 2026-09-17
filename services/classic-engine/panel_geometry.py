"""Bounded in-memory Kumiko adapter, preserving pinned split candidate order.

Page initializer and cached_split adapted from manga-image-translator
95227a2bb0fd306cd4f0c104d57284026f991b3a, GPL-3.0; see
licenses/manga-image-translator-GPL-3.0.txt. Source hashes: third_party/analysis-sources.json.
"""
import math
import threading
import time
import cv2 as cv
import numpy as np
from manga_translator.utils.panel.lib.page import Page
from manga_translator.utils.panel.lib.panel import Panel, Split
from manga_translator.utils.panel.lib.segment import Segment
from manga_translator.utils.panel.lib.debug import Debug

_LOCK = threading.RLock()


def nearby_vertices(polygon, min_hops, max_dist_x, max_dist_y):
    # One O(vertices) row at a time, never a vertices-squared dense matrix.
    points = polygon[:, 0, :]
    result = []
    for i in range(len(points) - min_hops):
        start = i + min_hops
        delta = np.abs(points[start:] - points[i])
        indices = np.flatnonzero((delta[:, 0] <= max_dist_x) & (delta[:, 1] <= max_dist_y))
        result.extend((i, int(j) + start) for j in indices)
    return result


def cached_split(self):
    if self.polygon is None:
        return None

    if self.is_small(extra_ratio = 2):  # panel should be splittable in two non-small subpanels
        return None

    min_hops = 3
    max_dist_x = int(self.w() / 3)
    max_dist_y = int(self.h() / 3)
    max_diagonal = math.sqrt(max_dist_x**2 + max_dist_y**2)
    dots_along_lines_dist = max_diagonal / 5
    min_dist_between_dots_x = max_dist_x / 10
    min_dist_between_dots_y = max_dist_y / 10

    # Compose modified polygon to optimise splits
    original_polygon = np.copy(self.polygon)
    polygon = np.ndarray(shape = (0, 1, 2), dtype = int, order = 'F')
    intermediary_dots = []
    extra_dots = []

    for i in range(len(original_polygon)):
        j = (i + 1) % len(original_polygon)
        dot1 = tuple(original_polygon[i][0])
        dot2 = tuple(original_polygon[j][0])
        seg = Segment(dot1, dot2)

        # merge nearby dots together
        if seg.dist_x() < min_dist_between_dots_x and seg.dist_y() < min_dist_between_dots_y:
            original_polygon[j][0] = seg.center()
            continue

        polygon = np.append(polygon, [[dot1]], axis = 0)

        # Add dots on *long* edges, by projecting other polygon dots on this segment
        add_dots = []

        # should be splittable in [dot1, dot1b(?), projected_dot3, dot2b(?), dot2]
        if seg.dist() < dots_along_lines_dist * 2:
            continue

        for k, dot3 in enumerate(original_polygon):
            if abs(k - i) < min_hops:
                continue

            projected_dot3 = seg.projected_point(dot3)

            # Segment should be able to contain projected_dot3
            if not seg.may_contain(projected_dot3):
                continue

            # dot3 should be close to current segment − distance(dot3, projected_dot3) should be short
            project = Segment(dot3[0], projected_dot3)
            if project.dist_x() > max_dist_x or project.dist_y() > max_dist_y:
                continue

            # append dot3 as intermediary dot on segment(dot1, dot2)
            add_dots.append(projected_dot3)
            intermediary_dots.append(projected_dot3)

        # Add also a dot near each end of the segment (provoke segment matching)
        alpha_x = math.acos(seg.dist_x(keep_sign = True) / seg.dist())
        alpha_y = math.asin(seg.dist_y(keep_sign = True) / seg.dist())
        dist_x = int(math.cos(alpha_x) * dots_along_lines_dist)
        dist_y = int(math.sin(alpha_y) * dots_along_lines_dist)

        dot1b = (dot1[0] + dist_x, dot1[1] + dist_y)
        # if len(intermediary_dots) == 0 or Segment(dot1b, intermediary_dots[0]).dist() > dots_along_lines_dist:
        add_dots.append(dot1b)
        extra_dots.append(dot1b)

        dot2b = (dot2[0] - dist_x, dot2[1] - dist_y)
        # if len(intermediary_dots) == 0 or Segment(dot2b, intermediary_dots[-1]).dist() > dots_along_lines_dist:
        add_dots.append(dot2b)
        extra_dots.append(dot2b)

        for dot in sorted(add_dots, key = lambda dot: Segment(dot1, dot).dist()):
            polygon = np.append(polygon, [[dot]], axis = 0)

    # Re-merge nearby dots together
    original_polygon = np.copy(polygon)
    polygon = np.ndarray(shape = (0, 1, 2), dtype = int, order = 'F')

    for i in range(len(original_polygon)):
        j = (i + 1) % len(original_polygon)
        dot1 = tuple(original_polygon[i][0])
        dot2 = tuple(original_polygon[j][0])
        seg = Segment(dot1, dot2)

        # merge nearby dots together
        if seg.dist_x() < min_dist_between_dots_x and seg.dist_y() < min_dist_between_dots_y:
            intermediary_dots = [dot for dot in intermediary_dots if dot not in [dot1, dot2]]
            extra_dots = [dot for dot in extra_dots if dot not in [dot1, dot2]]
            original_polygon[j][0] = seg.center()
            continue

        polygon = np.append(polygon, [[dot1]], axis = 0)

    Debug.draw_polygon(polygon)
    Debug.draw_dots(intermediary_dots, Debug.colours['red'])
    Debug.draw_dots(extra_dots, Debug.colours['yellow'])
    Debug.add_image(f"Composed polygon {self} ({len(polygon)} dots, {len(intermediary_dots)} intermediary)")

    # Find dots nearby one another
    nearby_dots = nearby_vertices(polygon, min_hops, max_dist_x, max_dist_y)

    if len(nearby_dots) == 0:
        return None

    Debug.draw_nearby_dots(polygon, nearby_dots)
    Debug.add_image(f"Nearby dots ({len(nearby_dots)})")

    splits = []
    for dots in nearby_dots:
        poly1len = len(polygon) - dots[1] + dots[0]
        poly2len = dots[1] - dots[0]

        # A panel should have at least three edges
        if min(poly1len, poly2len) <= 2:
            continue

        # Construct two subpolygons by distributing the dots around our nearby dots
        poly1 = np.concatenate((polygon[:dots[0] + 1], polygon[dots[1] + 1:]))
        poly2 = polygon[dots[0] + 1:dots[1] + 1].copy()

        panel1 = Panel(self.page, polygon = poly1)
        panel2 = Panel(self.page, polygon = poly2)

        if panel1.is_small() or panel2.is_small():
            continue

        if panel1 == self or panel2 == self:
            continue

        if panel1.overlaps(panel2):
            continue

        split_segment = Segment.along_polygon(polygon, dots[0], dots[1])
        split = Split(self, panel1, panel2, split_segment)
        if split not in splits:
            splits.append(split)

    Debug.draw_segments([split.segment for split in splits], Debug.colours['red'], size = 2)
    Debug.add_image(f"Splits ({len(splits)})")

    splits = list(filter(lambda split: split.segments_coverage() > 50 / 100, splits))

    if len(splits) == 0:
        return None

    # return the split that best matches segments (~panel edges)
    best_split = max(splits, key = lambda split: split.covered_dist)

    return best_split


class ArrayPage(Page):
    def __init__(
        self,
        image,
        numbering = None,
        debug = False,
        url = None,
        min_panel_size_ratio = None,
        panel_expansion = True
    ):
        self.filename = '<memory>'
        self.panels = []
        self.segments = []

        self.processing_time = None
        t1 = time.time_ns()

        self.img = image.copy()
        if not isinstance(self.img, np.ndarray) or self.img.size == 0:
            raise ValueError('Invalid panel image')

        self.numbering = numbering or "ltr"
        if not (numbering in ['ltr', 'rtl']):
            raise Exception('Fatal error, unknown numbering: ' + str(numbering))

        self.small_panel_ratio = min_panel_size_ratio or Page.DEFAULT_MIN_PANEL_SIZE_RATIO
        self.panel_expansion = panel_expansion
        self.url = url

        self.img_size = list(self.img.shape[:2])
        self.img_size.reverse()  # get a [width,height] list

        Debug.contour_size = 3

        # get license for this file
        self.license = None
        Debug.set_base_img(self.img)

        Debug.add_step('Initial state', self.get_infos())
        Debug.add_image('Input image')

        self.gray = cv.cvtColor(self.img, cv.COLOR_BGR2GRAY)
        Debug.add_image('Shades of gray', img = self.gray)
        Debug.show_time("Shades of gray")

        # https://docs.opencv.org/3.4/d2/d2c/tutorial_sobel_derivatives.html
        ddepth = cv.CV_16S
        grad_x = cv.Sobel(self.gray, ddepth, 1, 0, ksize = 3, scale = 1, delta = 0, borderType = cv.BORDER_DEFAULT)
        # Gradient-Y
        # grad_y = cv.Scharr(self.gray,ddepth,0,1)
        grad_y = cv.Sobel(self.gray, ddepth, 0, 1, ksize = 3, scale = 1, delta = 0, borderType = cv.BORDER_DEFAULT)

        abs_grad_x = cv.convertScaleAbs(grad_x)
        abs_grad_y = cv.convertScaleAbs(grad_y)

        self.sobel = cv.addWeighted(abs_grad_x, 0.5, abs_grad_y, 0.5, 0)
        Debug.add_image('Sobel filter applied', img = self.sobel)
        Debug.show_time("Sobel filter")

        self.get_contours()
        self.get_segments()
        self.get_initial_panels()
        self.group_small_panels()
        self.split_panels()
        self.exclude_small_panels()
        self.merge_panels()
        self.deoverlap_panels()
        self.exclude_small_panels()

        if self.panel_expansion:
            self.panels.sort()  # TODO: move this below before panels sort-fix, when panels expansion is smarter
            self.expand_panels()

        if len(self.panels) == 0:
            self.panels.append(Panel(page = self, xywh = [0, 0, self.img_size[0], self.img_size[1]]))

        self.group_big_panels()

        self.fix_panels_numbering()

        self.processing_time = int((time.time_ns() - t1) / 10**7) / 100


def get_panels_from_array(image, rtl=True):
    # Upstream Debug/Panel globals are non-reentrant. Production owns a dedicated
    # bounded CPU process; this lock also protects serial/thread test callers.
    with _LOCK:
        original = Panel._cached_split
        Panel._cached_split = cached_split
        Debug.debug = False
        try:
            page = ArrayPage(image, numbering='rtl' if rtl else 'ltr')
            return page.get_infos()['panels']
        finally:
            Panel._cached_split = original
