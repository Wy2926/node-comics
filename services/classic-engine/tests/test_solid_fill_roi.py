"""Component-local solid fill must preserve the pinned upstream pixel decisions."""
import ast
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from mtu_engine.assets import LOCK

# Original pinned function. Executed without the unrelated Qt/LaMa imports.
NATIVE = '''def solid_fill_pure_bubbles(
    img: np.ndarray,
    mask: np.ndarray,
    text_regions: list,
    mask_tight: np.ndarray,
    bubble_mask: np.ndarray,
    overlap_threshold: float,
):
    """
    对匹配的纯色气泡，只在修复蒙版与气泡蒙版的交集内直接用背景中位色填充，避免覆盖修复蒙版之外的气泡内容。

    Args:
        img: RGB 或 RGBA 工作图
        mask: 精修（膨胀）后的修复掩码，与 img 同高宽；填色区域会从中清零
        text_regions: 文本区域列表，用现有模型气泡重叠逻辑选择对应气泡
        mask_tight: 膨胀后的原始文字蒙版，仅用于从气泡中扣除文字像素、采样背景色
        bubble_mask: 已按比例内缩的气泡模型输出蒙版，用于识别匹配的气泡连通块
        overlap_threshold: 文本框位于模型气泡内的最小重叠率

    Returns:
        (filled_img, remaining_mask, filled_region_count)，不修改输入。
    """
    filled_img = img.copy()
    remaining_mask = mask.copy()
    rgb = filled_img[:, :, :3] if filled_img.ndim == 3 and filled_img.shape[2] == 4 else filled_img
    tight_bin = np.where(mask_tight >= 127, 255, 0).astype(np.uint8)
    bubble_bin = np.where(bubble_mask > 0, 255, 0).astype(np.uint8)
    if not np.any(bubble_bin):
        return filled_img, remaining_mask, 0

    num_labels, label_map = cv2.connectedComponents(
        np.where(bubble_bin > 0, 1, 0).astype(np.uint8),
        connectivity=8,
    )
    overlap_threshold = max(0.0, min(float(overlap_threshold), 1.0))

    region_bboxes = []
    for region in text_regions:
        try:
            x1, y1, x2, y2 = [int(round(float(v))) for v in region.xyxy]
        except Exception:
            continue
        if x2 > x1 and y2 > y1:
            region_bboxes.append((x1, y1, x2 - x1, y2 - y1))

    filled_regions = set()
    for label_idx in range(1, num_labels):
        region_bubble = np.where(label_map == label_idx, 255, 0).astype(np.uint8)
        matched_regions = {
            idx for idx, bbox in enumerate(region_bboxes)
            if calc_bbox_mask_overlap_ratio(bbox, region_bubble) >= overlap_threshold
        }
        if not matched_regions:
            continue

        non_text_mask = cv2.bitwise_and(region_bubble, 255 - tight_bin)
        non_text_px = rgb[non_text_mask > 0]
        if not non_text_px.size:
            continue
        average_bg_color = np.median(non_text_px, axis=0)
        std_rgb = np.std(non_text_px - average_bg_color, axis=0)
        inpaint_thresh = 7 if np.std(std_rgb) > 1 else 10
        if np.max(std_rgb) >= inpaint_thresh:
            continue

        # 气泡蒙版只负责识别候选气泡；实际填色严格限制在修复蒙版内。
        fill_region = (region_bubble > 0) & (mask > 0)
        if not np.any(fill_region):
            continue
        rgb[fill_region] = np.clip(np.round(average_bg_color), 0, 255).astype(np.uint8)
        remaining_mask[fill_region] = 0
        filled_regions.update(matched_regions)

    return filled_img, remaining_mask, len(filled_regions)
'''


def versions():
    bubble = {'np': np, 'cv2': cv2}
    exec(LOCK['source']['patches']['manga_translator/utils/bubble.py'][0]['before'], bubble)
    scope = {'np': np, 'cv2': cv2, 'calc_bbox_mask_overlap_ratio': bubble['calc_bbox_mask_overlap_ratio']}
    baseline = dict(scope)
    exec(compile(ast.parse(NATIVE), '<pinned-solid-fill>', 'exec'), baseline)
    patched = NATIVE
    for patch in LOCK['source']['patches']['manga_translator/inpainting/ballon_fill.py']:
        assert patched.count(patch['before']) == 1
        patched = patched.replace(patch['before'], patch['after'], 1)
    candidate = dict(scope)
    exec(compile(ast.parse(patched), '<roi-solid-fill>', 'exec'), candidate)
    return baseline['solid_fill_pure_bubbles'], candidate['solid_fill_pure_bubbles']


@pytest.mark.parametrize('channels', [3, 4])
@pytest.mark.parametrize('threshold', [0, .2, .5, .9, 1, -1, 2])
def test_roi_solid_fill_matches_native_and_keeps_inputs(channels, threshold):
    before, after = versions()
    rng = np.random.default_rng(301)
    for index in range(12):
        height, width = 90, 73
        img = rng.integers(0, 256, (height, width, channels), dtype=np.uint8)
        bubbles = np.zeros((height, width), np.uint8)
        for y, x in [(0, 0), (19, 35), (58, 2), (75, 61)]:
            bubbles[y:y + 18, x:x + 22] = 255
            if index % 3 != 0:
                img[y:y + 18, x:x + 22, :3] = rng.integers(10, 240, 3)
        bubbles[8:10, 9:12] = 0  # Hole in a border-touching bubble.
        tight = (rng.random((height, width)) > .7).astype(np.uint8) * 255
        mask = (rng.random((height, width)) > .5).astype(np.uint8) * 255
        regions = [SimpleNamespace(xyxy=b) for b in
                   [(-4.6, -2.4, 20.5, 18.1), (36, 20, 48, 30),
                    (0, 50, 24, 76), (60, 80, 77, 96), (80, 80, 90, 90), (2, 2, 1, 1)]]
        if index == 10:
            tight.fill(255)  # No background pixels.
        if index == 11:
            bubbles.fill(0)
        inputs = (img, mask, regions, tight, bubbles, threshold)
        copies = [value.copy() for value in (img, mask, tight, bubbles)]
        expected, actual = before(*inputs), after(*inputs)
        assert expected[2] == actual[2]
        np.testing.assert_array_equal(expected[0], actual[0])
        np.testing.assert_array_equal(expected[1], actual[1])
        for value, copy in zip((img, mask, tight, bubbles), copies):
            np.testing.assert_array_equal(value, copy)
        assert not np.shares_memory(actual[0], img)
        assert not np.shares_memory(actual[1], mask)
