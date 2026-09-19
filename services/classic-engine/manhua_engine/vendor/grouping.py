#!/usr/bin/env python3
# vendored from manga_translator/utils/generic.py + manga_translator/textline_merge/__init__.py @ d5a3eee
# 自含複本：只保留「把偵測到的文字行(quad)分組成區域」所需邏輯，依賴僅 numpy/networkx/shapely。
# 這是 §7 的 grouping 規格本：兩階段 = 寬鬆連邊(quadrilateral_can_merge_region) + MST 分裂(split_text_region)。
# 動 Kotlin Grouping.kt 前先讀這裡；參數/演算法照搬（§4 第一/二層）。
import itertools
from collections import Counter
from typing import List, Set

import numpy as np
import networkx as nx
from shapely.geometry import Polygon, MultiPoint


def dist(x1, y1, x2, y2):
    return np.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


def distance_point_point(a: np.ndarray, b: np.ndarray) -> float:
    return np.linalg.norm(a - b)


def distance_point_lineseg(p: np.ndarray, p1: np.ndarray, p2: np.ndarray):
    x, y = p[0], p[1]
    x1, y1 = p1[0], p1[1]
    x2, y2 = p2[0], p2[1]
    A, B, C, D = x - x1, y - y1, x2 - x1, y2 - y1
    dot = A * C + B * D
    len_sq = C * C + D * D
    param = dot / len_sq if len_sq != 0 else -1
    if param < 0:
        xx, yy = x1, y1
    elif param > 1:
        xx, yy = x2, y2
    else:
        xx, yy = x1 + param * C, y1 + param * D
    dx, dy = x - xx, y - yy
    return np.sqrt(dx * dx + dy * dy)


def sort_pnts(pts: np.ndarray):
    if isinstance(pts, list):
        pts = np.array(pts)
    assert isinstance(pts, np.ndarray) and pts.shape == (4, 2)
    pairwise_vec = (pts[:, None] - pts[None]).reshape((16, -1))
    pairwise_vec_norm = np.linalg.norm(pairwise_vec, axis=1)
    long_side_ids = np.argsort(pairwise_vec_norm)[[8, 10]]
    long_side_vecs = pairwise_vec[long_side_ids]
    inner_prod = (long_side_vecs[0] * long_side_vecs[1]).sum()
    if inner_prod < 0:
        long_side_vecs[0] = -long_side_vecs[0]
    struc_vec = np.abs(long_side_vecs.mean(axis=0))
    is_vertical = struc_vec[0] <= struc_vec[1]
    if is_vertical:
        pts = pts[np.argsort(pts[:, 1])]
        pts = pts[[*np.argsort(pts[:2, 0]), *np.argsort(pts[2:, 0])[::-1] + 2]]
        return pts, is_vertical
    else:
        pts = pts[np.argsort(pts[:, 0])]
        pts_sorted = np.zeros_like(pts)
        pts_sorted[[0, 3]] = sorted(pts[[0, 1]], key=lambda x: x[1])
        pts_sorted[[1, 2]] = sorted(pts[[2, 3]], key=lambda x: x[1])
        return pts_sorted, is_vertical


class BBox(object):
    def __init__(self, x, y, w, h):
        self.x, self.y, self.w, self.h = x, y, w, h


class Quadrilateral(object):
    """偵測到的一條文字行（四邊形）。只保留 grouping 用到的幾何屬性。"""

    def __init__(self, pts, text="", prob=1.0, fg=(0, 0, 0), bg=(255, 255, 255)):
        self.pts, is_vertical = sort_pnts(np.array(pts, dtype=np.float64))
        self.direction = 'v' if is_vertical else 'h'
        self.text = text
        self.prob = prob
        self.fg_r, self.fg_g, self.fg_b = fg
        self.bg_r, self.bg_g, self.bg_b = bg
        self.assigned_direction = None  # 合併階段時 m-i-t 此值為 None（OCR 才設）→ distance 走 v 模式
        self._cache = {}

    def _c(self, k, f):
        if k not in self._cache:
            self._cache[k] = f()
        return self._cache[k]

    @property
    def structure(self):
        def f():
            p1 = ((self.pts[0] + self.pts[1]) / 2).astype(int)
            p2 = ((self.pts[2] + self.pts[3]) / 2).astype(int)
            p3 = ((self.pts[1] + self.pts[2]) / 2).astype(int)
            p4 = ((self.pts[3] + self.pts[0]) / 2).astype(int)
            return [p1, p2, p3, p4]
        return self._c('structure', f)

    @property
    def aspect_ratio(self):
        def f():
            l1a, l1b, l2a, l2b = [a.astype(np.float32) for a in self.structure]
            return np.linalg.norm(l2b - l2a) / np.linalg.norm(l1b - l1a)
        return self._c('ar', f)

    @property
    def font_size(self):
        def f():
            l1a, l1b, l2a, l2b = [a.astype(np.float32) for a in self.structure]
            return min(np.linalg.norm(l2b - l2a), np.linalg.norm(l1b - l1a))
        return self._c('fs', f)

    @property
    def aabb(self):
        def f():
            mx = np.max(self.pts, axis=0)
            mn = np.min(self.pts, axis=0)
            return BBox(mn[0], mn[1], mx[0] - mn[0], mx[1] - mn[1])
        return self._c('aabb', f)

    @property
    def cosangle(self):
        def f():
            l1a, l1b, _, _ = [a.astype(np.float32) for a in self.structure]
            v1 = l1b - l1a
            return np.dot(v1 / np.linalg.norm(v1), np.array([1, 0]))
        return self._c('cos', f)

    @property
    def angle(self):
        return self._c('ang', lambda: np.fmod(np.arccos(self.cosangle) + np.pi, np.pi))

    @property
    def centroid(self):
        return self._c('cen', lambda: np.average(self.pts, axis=0))

    @property
    def is_approximate_axis_aligned(self):
        def f():
            l1a, l1b, l2a, l2b = [a.astype(np.float32) for a in self.structure]
            u1 = (l1b - l1a) / np.linalg.norm(l1b - l1a)
            u2 = (l2b - l2a) / np.linalg.norm(l2b - l2a)
            e1, e2 = np.array([0, 1]), np.array([1, 0])
            return (abs(np.dot(u1, e1)) < 0.05 or abs(np.dot(u1, e2)) < 0.05 or
                    abs(np.dot(u2, e1)) < 0.05 or abs(np.dot(u2, e2)) < 0.05)
        return self._c('aa', f)

    @property
    def polygon(self):
        return self._c('poly', lambda: MultiPoint([tuple(p) for p in self.pts]).convex_hull)

    def poly_distance(self, other):
        return self.polygon.distance(other.polygon)

    def distance(self, other, rho=0.5):
        return self.distance_impl(other, rho)

    def distance_impl(self, other, rho=0.5):
        fs = max(self.font_size, other.font_size)
        if self.assigned_direction == 'h':
            poly1 = MultiPoint([tuple(self.pts[0]), tuple(self.pts[3]), tuple(other.pts[0]), tuple(other.pts[3])]).convex_hull
            poly2 = MultiPoint([tuple(self.pts[2]), tuple(self.pts[1]), tuple(other.pts[2]), tuple(other.pts[1])]).convex_hull
            poly3 = MultiPoint([tuple(self.structure[0]), tuple(self.structure[1]),
                                tuple(other.structure[0]), tuple(other.structure[1])]).convex_hull
            dist1, dist2, dist3 = poly1.area / fs, poly2.area / fs, poly3.area / fs
            pattern = 'h_left'
            if dist1 < fs * rho:
                pattern = 'h_left'
            if dist2 < fs * rho and dist2 < dist1:
                pattern = 'h_right'
            if dist3 < fs * rho and dist3 < dist1 and dist3 < dist2:
                pattern = 'h_middle'
            if pattern == 'h_left':
                return dist(self.pts[0][0], self.pts[0][1], other.pts[0][0], other.pts[0][1])
            elif pattern == 'h_right':
                return dist(self.pts[1][0], self.pts[1][1], other.pts[1][0], other.pts[1][1])
            else:
                return dist(self.structure[0][0], self.structure[0][1], other.structure[0][0], other.structure[0][1])
        else:
            poly1 = MultiPoint([tuple(self.pts[0]), tuple(self.pts[1]), tuple(other.pts[0]), tuple(other.pts[1])]).convex_hull
            poly2 = MultiPoint([tuple(self.pts[2]), tuple(self.pts[3]), tuple(other.pts[2]), tuple(other.pts[3])]).convex_hull
            dist1, dist2 = poly1.area / fs, poly2.area / fs
            pattern = 'v_top'
            if dist1 < fs * rho:
                pattern = 'v_top'
            if dist2 < fs * rho and dist2 < dist1:
                pattern = 'v_bottom'
            if pattern == 'v_top':
                return dist(self.pts[0][0], self.pts[0][1], other.pts[0][0], other.pts[0][1])
            else:
                return dist(self.pts[2][0], self.pts[2][1], other.pts[2][0], other.pts[2][1])


def quadrilateral_can_merge_region(a, b, ratio=1.9, discard_connection_gap=2, char_gap_tolerance=0.6,
                                   char_gap_tolerance2=1.5, font_size_ratio_tol=1.5, aspect_ratio_tol=2):
    b1, b2 = a.aabb, b.aabb
    char_size = min(a.font_size, b.font_size)
    x1, y1, w1, h1 = b1.x, b1.y, b1.w, b1.h
    x2, y2, w2, h2 = b2.x, b2.y, b2.w, b2.h
    dist_ = Polygon(a.pts).distance(Polygon(b.pts))
    if dist_ > discard_connection_gap * char_size:
        return False
    if max(a.font_size, b.font_size) / char_size > font_size_ratio_tol:
        return False
    if a.aspect_ratio > aspect_ratio_tol and b.aspect_ratio < 1. / aspect_ratio_tol:
        return False
    if b.aspect_ratio > aspect_ratio_tol and a.aspect_ratio < 1. / aspect_ratio_tol:
        return False
    a_aa, b_aa = a.is_approximate_axis_aligned, b.is_approximate_axis_aligned
    if a_aa and b_aa:
        if dist_ < char_size * char_gap_tolerance:
            if abs(x1 + w1 // 2 - (x2 + w2 // 2)) < char_gap_tolerance2:
                return True
            if w1 > h1 * ratio and h2 > w2 * ratio:
                return False
            if w2 > h2 * ratio and h1 > w1 * ratio:
                return False
            if w1 > h1 * ratio or w2 > h2 * ratio:  # h
                return abs(x1 - x2) < char_size * char_gap_tolerance2 or abs(x1 + w1 - (x2 + w2)) < char_size * char_gap_tolerance2
            elif h1 > w1 * ratio or h2 > w2 * ratio:  # v
                return abs(y1 - y2) < char_size * char_gap_tolerance2 or abs(y1 + h1 - (y2 + h2)) < char_size * char_gap_tolerance2
            return False
        else:
            return False
    if True:
        if abs(a.angle - b.angle) < 15 * np.pi / 180:
            fs = min(a.font_size, b.font_size)
            if a.poly_distance(b) > fs * char_gap_tolerance2:
                return False
            if abs(a.font_size - b.font_size) / fs > 0.25:
                return False
            return True
    return False


def split_text_region(bboxes: List[Quadrilateral], connected_region_indices: Set[int],
                      width, height, gamma=0.5, sigma=2) -> List[Set[int]]:
    connected_region_indices = list(connected_region_indices)
    if len(connected_region_indices) == 1:
        return [set(connected_region_indices)]
    if len(connected_region_indices) == 2:
        fs1 = bboxes[connected_region_indices[0]].font_size
        fs2 = bboxes[connected_region_indices[1]].font_size
        fs = max(fs1, fs2)
        if bboxes[connected_region_indices[0]].distance(bboxes[connected_region_indices[1]]) < (1 + gamma) * fs \
                and abs(bboxes[connected_region_indices[0]].angle - bboxes[connected_region_indices[1]].angle) < 0.2 * np.pi:
            return [set(connected_region_indices)]
        else:
            return [set([connected_region_indices[0]]), set([connected_region_indices[1]])]
    G = nx.Graph()
    for idx in connected_region_indices:
        G.add_node(idx)
    for (u, v) in itertools.combinations(connected_region_indices, 2):
        G.add_edge(u, v, weight=bboxes[u].distance(bboxes[v]))
    edges = nx.algorithms.tree.minimum_spanning_edges(G, algorithm='kruskal', data=True)
    edges = sorted(edges, key=lambda a: a[2]['weight'], reverse=True)
    distances_sorted = [a[2]['weight'] for a in edges]
    fontsize = np.mean([bboxes[idx].font_size for idx in connected_region_indices])
    distances_std = np.std(distances_sorted)
    distances_mean = np.mean(distances_sorted)
    std_threshold = max(0.3 * fontsize + 5, 5)
    b1, b2 = bboxes[edges[0][0]], bboxes[edges[0][1]]
    max_poly_distance = Polygon(b1.pts).distance(Polygon(b2.pts))
    max_centroid_alignment = min(abs(b1.centroid[0] - b2.centroid[0]), abs(b1.centroid[1] - b2.centroid[1]))
    if (distances_sorted[0] <= distances_mean + distances_std * sigma
            or distances_sorted[0] <= fontsize * (1 + gamma)) \
            and (distances_std < std_threshold
                 or max_poly_distance == 0 and max_centroid_alignment < 5):
        return [set(connected_region_indices)]
    else:
        G = nx.Graph()
        for idx in connected_region_indices:
            G.add_node(idx)
        for edge in edges[1:]:
            G.add_edge(edge[0], edge[1])
        ans = []
        for node_set in nx.algorithms.components.connected_components(G):
            ans.extend(split_text_region(bboxes, node_set, width, height))
        return ans


def merge_bboxes_text_region(bboxes: List[Quadrilateral], width, height):
    """yield (txtlns[排序後], fg, bg)。對齊 m-i-t merge_bboxes_text_region。"""
    G = nx.Graph()
    for i, box in enumerate(bboxes):
        G.add_node(i, box=box)
    for ((u, ubox), (v, vbox)) in itertools.combinations(enumerate(bboxes), 2):
        if quadrilateral_can_merge_region(ubox, vbox, aspect_ratio_tol=1.3, font_size_ratio_tol=2,
                                          char_gap_tolerance=1, char_gap_tolerance2=3):
            G.add_edge(u, v)
    region_indices: List[Set[int]] = []
    for node_set in nx.algorithms.components.connected_components(G):
        region_indices.extend(split_text_region(bboxes, node_set, width, height))
    for node_set in region_indices:
        nodes = list(node_set)
        txtlns = np.array(bboxes)[nodes]
        fg_r = round(np.mean([b.fg_r for b in txtlns]))
        fg_g = round(np.mean([b.fg_g for b in txtlns]))
        fg_b = round(np.mean([b.fg_b for b in txtlns]))
        bg_r = round(np.mean([b.bg_r for b in txtlns]))
        bg_g = round(np.mean([b.bg_g for b in txtlns]))
        bg_b = round(np.mean([b.bg_b for b in txtlns]))
        dirs = [b.direction for b in txtlns]
        majority_dir_top_2 = Counter(dirs).most_common(2)
        if len(majority_dir_top_2) == 1:
            majority_dir = majority_dir_top_2[0][0]
        elif majority_dir_top_2[0][1] == majority_dir_top_2[1][1]:
            max_aspect_ratio = -100
            for box in txtlns:
                if box.aspect_ratio > max_aspect_ratio:
                    max_aspect_ratio = box.aspect_ratio
                    majority_dir = box.direction
                if 1.0 / box.aspect_ratio > max_aspect_ratio:
                    max_aspect_ratio = 1.0 / box.aspect_ratio
                    majority_dir = box.direction
        else:
            majority_dir = majority_dir_top_2[0][0]
        if majority_dir == 'h':
            nodes = sorted(nodes, key=lambda x: bboxes[x].centroid[1])
        elif majority_dir == 'v':
            nodes = sorted(nodes, key=lambda x: -bboxes[x].centroid[0])
        txtlns = np.array(bboxes)[nodes]
        yield txtlns, (fg_r, fg_g, fg_b), (bg_r, bg_g, bg_b)
