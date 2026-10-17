"""Bounded bubble recovery using MTU's geometry, line breaking and font search."""
from copy import copy

import numpy as np


def associate_bubbles(blocks, mask):
    has_mask = mask is not None and np.any(mask)
    if has_mask:
        from manga_translator.rendering import _region_lines_fully_inside_mask
    for block in blocks:
        if getattr(block, 'bubble_enclosed', None) is None:
            block.bubble_enclosed = bool(has_mask and
                _region_lines_fully_inside_mask(block, mask))


def fit_bubbles(image, original, blocks, texts, config, mask, labels, occupied=()):
    """Keep the native layout; bound recovery to one alternative per paragraph.

    Source lines/checkpoints are immutable. Only a layout copy's native anchor
    and wrap budget change; Qt still measures, breaks, sizes and paints the text.
    """
    import cv2
    from manga_translator import rendering as native
    from manga_translator.utils import build_region_reference_mask
    from manga_translator.utils.bubble import reference_mask_bounds

    if mask is None or labels is None:
        raise ValueError('No safe bubble layout')
    points = native.resize_regions_to_font_size(image, blocks, config, original,
        bubble_mask=mask, skip_text_replacements=True)
    height, width = image.shape[:2]
    boxes = np.array([np.concatenate((np.asarray(p).reshape(-1, 2).min(axis=0),
                                     np.asarray(p).reshape(-1, 2).max(axis=0)))
                      for p in [*points, *occupied]])

    def safe(polygon, reference):
        if polygon is None:
            return False
        vertices = np.asarray(polygon).reshape(-1, 2)
        # Native mask membership clips polygons; it cannot alone prove that
        # rotated glyphs/outline fit on the physical page.
        return bool(np.isfinite(vertices).all() and
            (vertices >= (1, 1)).all() and (vertices <= (width - 1, height - 1)).all() and
            native._polygon_fully_inside_mask(vertices, reference))

    def avoid(block, polygon, reference, obstacles):
        if polygon is None:
            return None
        if native._layout_regions_conflict(polygon, reference, obstacles):
            config._current_region = block
            native.text_render.set_font(block.font_family)
            size, polygon = native._shrink_font_for_layout_collisions(
                region=block, start_font_size=block.font_size, min_font_size=1,
                render_horizontally=block.horizontal, line_spacing_multiplier=block.line_spacing,
                letter_spacing_multiplier=block.letter_spacing, config=config, anchor_mode='center',
                bubble_mask=reference, placed_regions=obstacles)
            if size is not None:
                block.font_size = size
        return polygon if safe(polygon, reference) else None

    for index, block in enumerate(blocks):
        reference = build_region_reference_mask(block, mask, labels)
        x, y, w, h = reference_mask_bounds(reference) or cv2.boundingRect(reference)
        # Reserve both already chosen layouts and pending native layouts. A
        # moved paragraph must not occupy another paragraph's eventual glyphs.
        # Cheap bounds reject unrelated bubbles before native polygon checks.
        nearby = np.flatnonzero((boxes[:, 0] < x+w) & (boxes[:, 2] > x) &
                                (boxes[:, 1] < y+h) & (boxes[:, 3] > y))
        all_points = [*points, *occupied]
        obstacles = [(all_points[i], None) for i in nearby if i != index]
        collision = native._layout_regions_conflict(points[index], reference, obstacles)
        # Whole-word layout can be safe yet unreadably small in a tall caption.
        # Try native hyphenation after width-limited shrink, with a dictionary;
        # normal bubbles, single rich words and explicit breaks stay unchanged.
        hyphenate = (config.render.balloon_fill_mask_layout and block.horizontal and
            h > 2 * w and 2 * block.font_size < block.original_font_size and
            2 * (boxes[index, 3] - boxes[index, 1]) < h and
            not block.translation_rich and not native._has_explicit_line_breaks(texts[index]))
        if hyphenate:
            from manga_translator.rendering.text_render_eng import _resolve_english_layout_language
            layout_language = _resolve_english_layout_language(block.target_lang)
            hyphenate = native.text_render.select_hyphenator(layout_language) is not None
        if (safe(points[index], reference) and not collision and
                native._polygon_fully_inside_mask(block.min_rect[0], reference) and not hyphenate):
            continue
        chosen = copy(block)
        chosen_points = avoid(chosen, points[index], reference, obstacles)

        # Work on this component's ROI, not another full-page mask. The native
        # maximal-rectangle search keeps holes; pending/placed boxes are holes
        # too. A single alternative bounds CPU work even on difficult pages.
        available = reference[y:y+h, x:x+w].copy()
        if w and h:
            if x == 0:
                available[:, 0] = 0
            if y == 0:
                available[0, :] = 0
            if x + w == width:
                available[:, -1] = 0
            if y + h == height:
                available[-1, :] = 0
            for polygon, _ in obstacles:
                cv2.fillPoly(available, [np.rint(np.asarray(polygon).reshape(-1, 2) - (x, y)).astype(np.int32)], 0)
            rx, ry, rw, rh = native.find_largest_inscribed_rect(available)
            if rw > 2 and rh > 2:
                candidate = copy(block)
                candidate.center = np.array([x + rx + rw / 2, y + ry + rh / 2])
                candidate.unrotated_size = (rw - 2, rh - 2)
                rich = block.translation_rich
                candidate.translation = texts[index]
                candidate.translation_rich = rich
                candidate.font_size = block.original_font_size
                native.text_render.set_font(candidate.font_family)
                config._current_region = candidate
                if hyphenate:
                    from manga_translator.rendering.auto_linebreak import _layout_horizontal_eng
                    lines, _ = _layout_horizontal_eng(round(candidate.font_size), texts[index], rw - 2,
                        language=layout_language, hyphenate=True, letter_spacing=candidate.letter_spacing)
                    candidate.translation = '[BR]'.join(lines)
                else:
                    native._apply_default_english_line_break_method(candidate, round(candidate.font_size), None, config)
                # The spare rectangle is the wrap budget. Mask-layout would
                # replace it with the whole shared bubble's rectangle again.
                mask_layout = config.render.balloon_fill_mask_layout
                config.render.balloon_fill_mask_layout = False
                try:
                    polygon = native.resize_regions_to_font_size(image, [candidate], config, original,
                        bubble_mask=mask, skip_text_replacements=True)[0]
                finally:
                    config.render.balloon_fill_mask_layout = mask_layout
                polygon = avoid(candidate, polygon, reference, obstacles)
                if polygon is not None and (chosen_points is None or candidate.font_size > chosen.font_size):
                    chosen, chosen_points = candidate, polygon
        if chosen_points is None:
            # Existing page-failure handling preserves the original. Never
            # publish a cleaned page with missing or clipped translated text.
            raise ValueError('No safe bubble layout')
        blocks[index], points[index] = chosen, chosen_points
        vertices = np.asarray(chosen_points).reshape(-1, 2)
        boxes[index] = np.concatenate((vertices.min(axis=0), vertices.max(axis=0)))
    return blocks, points
