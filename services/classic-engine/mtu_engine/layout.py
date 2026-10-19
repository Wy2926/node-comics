"""Bounded bubble recovery using MTU's geometry, line breaking and font search."""
from copy import copy
import unicodedata

import numpy as np


def _can_stack_text(text):
    """MTU stacks code points; do not split graphemes or lose bidi shaping."""
    from PyQt6.QtCore import QTextBoundaryFinder

    boundaries = QTextBoundaryFinder(QTextBoundaryFinder.BoundaryType.Grapheme, text)
    position = 0
    for char in text:
        if unicodedata.bidirectional(char) in ('R', 'AL', 'AN', 'NSM') or unicodedata.category(char) == 'Cf':
            return False
        position += 2 if ord(char) > 0xffff else 1  # Qt positions use UTF-16.
        boundaries.setPosition(position)
        if not boundaries.isAtBoundary():
            return False
    return True


def _wrap_words(text, font_size, width, letter_spacing):
    """Let Qt break at word boundaries, without Manga2Eng's short-word groups."""
    from PyQt6.QtGui import QTextLayout, QTextOption
    from manga_translator.rendering.text_render._fonts import _layout_font

    layout = QTextLayout(text, _layout_font(font_size, letter_spacing))
    option = QTextOption()
    option.setWrapMode(QTextOption.WrapMode.WordWrap)
    layout.setTextOption(option)
    encoded, lines = text.encode('utf-16-le'), []
    layout.beginLayout()
    try:
        while (line := layout.createLine()).isValid():
            line.setLineWidth(width)
            start, length = line.textStart() * 2, line.textLength() * 2
            lines.append(encoded[start:start+length].decode('utf-16-le').strip())
    finally:
        layout.endLayout()
    return '[BR]'.join(lines)


def associate_bubbles(blocks, mask):
    has_mask = mask is not None and np.any(mask)
    if has_mask:
        from manga_translator.rendering import _region_lines_fully_inside_mask
    for block in blocks:
        if getattr(block, 'bubble_enclosed', None) is None:
            block.bubble_enclosed = bool(has_mask and
                _region_lines_fully_inside_mask(block, mask))


def fit_bubbles(image, original, blocks, texts, config, mask, labels, occupied=(), *, language):
    """Keep native layout; reuse one safe rectangle for bounded recovery.

    Source lines/checkpoints are immutable. Only a layout copy's native anchor
    and wrap budget change; Qt still measures, breaks, sizes and paints the text.
    """
    import cv2
    from manga_translator import rendering as native
    from manga_translator.utils import build_region_reference_mask
    from manga_translator.utils.bubble import reference_mask_bounds

    def cap_source_font(block, polygon):
        # Do this before reserving pending layouts: balloon-fill can otherwise
        # double a short paragraph's size and starve its neighbour of space.
        maximum = native._apply_final_font_constraints(block.original_font_size, config)
        if block.font_size <= maximum:
            return polygon
        block.font_size = maximum
        config._current_region = block
        native.text_render.set_font(block.font_family)
        return native._calc_region_dst_points_for_font(
            region=block, font_size=maximum, render_horizontally=block.horizontal,
            line_spacing_multiplier=block.line_spacing,
            letter_spacing_multiplier=block.letter_spacing, config=config, anchor_mode='center')

    if mask is None or labels is None:
        raise ValueError('No safe bubble layout')
    points = native.resize_regions_to_font_size(image, blocks, config, original,
        bubble_mask=mask, skip_text_replacements=True)
    points = [cap_source_font(block, polygon) for block, polygon in zip(blocks, points)]
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
        config._current_region = block
        native.text_render.set_font(block.font_family)
        options = dict(region=block, min_font_size=1, render_horizontally=block.horizontal,
            line_spacing_multiplier=block.line_spacing, letter_spacing_multiplier=block.letter_spacing,
            config=config, anchor_mode='center', bubble_mask=reference)
        if not safe(polygon, reference):
            # Collision fitting alone does not check bubble containment. Reuse
            # MTU's bounded mask search before avoiding neighbouring paragraphs.
            size, polygon = native._binary_search_font_for_bubble_mask(
                start_font_size=block.font_size, **options)
            if size is None:
                return None
            block.font_size = size
        if native._layout_regions_conflict(polygon, reference, obstacles):
            size, polygon = native._shrink_font_for_layout_collisions(
                start_font_size=block.font_size, placed_regions=obstacles, **options)
            if size is not None:
                block.font_size = size
        return polygon if safe(polygon, reference) else None

    def available_space(reference, obstacles):
        x, y, w, h = reference_mask_bounds(reference) or cv2.boundingRect(reference)
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
        return x, y, available

    def fit_rectangle(block, text, rect, reference, obstacles, *, recover, best, cell=None):
        chosen, chosen_points = best
        rx, ry, rw, rh = rect
        if rw <= 2 or rh <= 2:
            return best
        vertical = recover and _can_stack_text(text)
        # Native hyphenation can fall back to code-point splits too; complex
        # graphemes and bidi text must keep Qt's shaping and word wrapping.
        hyphenate = (vertical and not block.translation_rich and
                     native.text_render.select_hyphenator(language) is not None)
        modes = ('horizontal', 'vertical', 'columns') if vertical else ('horizontal',)
        # Shared cells can trade width for height. Compare Qt word wrapping
        # with the existing dictionary breaks, rather than forcing hyphenation.
        if cell is not None and hyphenate:
            modes = ('words', *modes)
        for mode in modes:
            stack = mode in ('vertical', 'columns')
            if stack and chosen_points is not None and chosen.font_size >= .75 * block.original_font_size:
                break
            candidate = copy(block)
            candidate.center = np.array([rx + rw / 2, ry + rh / 2])
            candidate.unrotated_size = (rw - 2, rh - 2)
            rich = block.translation_rich
            candidate.translation = text
            candidate.translation_rich = rich
            candidate.font_size = block.original_font_size
            # In a shared cell, reuse a healthy paragraph's already fitted
            # size for wrapping, rather than freezing breaks at its larger OCR size.
            seed = round(block.font_size if cell is not None and
                block.font_size >= .75 * block.original_font_size else block.original_font_size)
            native.text_render.set_font(candidate.font_family)
            config._current_region = candidate
            mask_layout = config.render.balloon_fill_mask_layout
            english_layout = config.render.bubble_layout_english
            config.render.balloon_fill_mask_layout = False
            if stack:
                candidate._direction = 'v'
                config.render.bubble_layout_english = False
            try:
                if mode == 'columns':
                    from manga_translator.rendering.auto_linebreak import solve_no_br_layout
                    # The rectangle is a layout budget, not a single OCR column.
                    config._current_region = None
                    try:
                        wrapped = solve_no_br_layout(text=text, horizontal=False,
                            seed_segments=0, seed_font_size=round(block.original_font_size),
                            bubble_width=rw-2, bubble_height=rh-2, min_font_size=1,
                            max_font_size=round(block.original_font_size),
                            line_spacing_multiplier=candidate.line_spacing,
                            letter_spacing_multiplier=candidate.letter_spacing,
                            target_lang=candidate.target_lang, config=config)
                        candidate.translation = wrapped.text_with_br
                    finally:
                        config._current_region = candidate
                    if candidate.translation == text:
                        continue
                elif mode == 'horizontal' and hyphenate:
                    from manga_translator.rendering.auto_linebreak import _layout_horizontal_eng
                    lines, _ = _layout_horizontal_eng(seed, text, rw - 2,
                        language=language, hyphenate=True, letter_spacing=candidate.letter_spacing)
                    candidate.translation = '[BR]'.join(lines)
                elif not stack and recover and not rich:
                    candidate.translation = _wrap_words(text, seed,
                        rw - 2, candidate.letter_spacing)
                else:
                    native._apply_default_english_line_break_method(candidate, round(candidate.font_size), None, config)
                polygon = native.resize_regions_to_font_size(image, [candidate], config, original,
                    bubble_mask=mask, skip_text_replacements=True)[0]
            finally:
                config.render.balloon_fill_mask_layout = mask_layout
                config.render.bubble_layout_english = english_layout
            polygon = avoid(candidate, cap_source_font(candidate, polygon), reference, obstacles)
            if polygon is not None and cell is not None:
                origin, budget = cell
                vertices = np.asarray(polygon).reshape(-1, 2) - origin
                if not ((vertices >= 0).all() and
                        (vertices <= (budget.shape[1]-1, budget.shape[0]-1)).all() and
                        native._polygon_fully_inside_mask(vertices, budget)):
                    polygon = None
            if polygon is not None and (chosen_points is None or candidate.font_size > chosen.font_size):
                chosen, chosen_points = candidate, polygon
        return chosen, chosen_points

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
        # A wide shared bubble can still contain a narrow vertical paragraph.
        # Recover unused height before accepting severe width-limited shrink;
        # ordinary layouts and explicit breaks retain the native fast path.
        source_width, source_height = block.unrotated_size
        recover = (config.render.balloon_fill_mask_layout and block.horizontal and
            (h > w or source_height > source_width) and
            block.font_size < .75 * block.original_font_size and
            2 * (boxes[index, 3] - boxes[index, 1]) < h and
            not native._has_explicit_line_breaks(texts[index]))
        if (safe(points[index], reference) and not collision and
                native._polygon_fully_inside_mask(block.min_rect[0], reference) and not recover):
            continue
        chosen = copy(block)
        chosen_points = avoid(chosen, points[index], reference, obstacles)

        # Work on this component's ROI, not another full-page mask. The native
        # maximal-rectangle search keeps holes; pending/placed boxes are holes
        # too. Reuse this one ROI for horizontal recovery, then the existing
        # vertical layout and (only if still undersized) native column fitting.
        # No extra mask/rectangle search; keep a better single-column result.
        x, y, available = available_space(reference, obstacles)
        if w and h:
            rx, ry, rw, rh = native.find_largest_inscribed_rect(available)
            chosen, chosen_points = fit_rectangle(block, texts[index], (x+rx, y+ry, rw, rh),
                reference, obstacles, recover=recover, best=(chosen, chosen_points))
        if chosen_points is None:
            # Existing page-failure handling preserves the original. Never
            # publish a cleaned page with missing or clipped translated text.
            raise ValueError('No safe bubble layout')
        blocks[index], points[index] = chosen, chosen_points
        vertices = np.asarray(chosen_points).reshape(-1, 2)
        boxes[index] = np.concatenate((vertices.min(axis=0), vertices.max(axis=0)))

    # A safe large paragraph can leave its neighbour only a narrow strip.
    # Retry shared pairs as a unit, using the same native fitting in two cells.
    # Source geometry orders the cells; paragraph IDs and source data never move.
    if config.render.balloon_fill_mask_layout and any(
            block.font_size < .75 * block.original_font_size for block in blocks):
        from manga_translator.utils.bubble import _region_labels
        groups = {}
        for index, block in enumerate(blocks):
            key = _region_labels(block, mask, labels)
            if len(key) == 1:
                groups.setdefault(key, []).append(index)
        for indices in groups.values():
            if len(indices) != 2 or any(not blocks[i].horizontal or blocks[i].translation_rich or
                    native._has_explicit_line_breaks(texts[i]) for i in indices):
                continue
            ratios = [blocks[i].font_size / blocks[i].original_font_size for i in indices]
            score = min(ratios)
            if score >= .75:
                continue
            reference = build_region_reference_mask(blocks[indices[0]], mask, labels)
            obstacles = [(p, None) for i, p in enumerate([*points, *occupied]) if i not in indices]
            x, y, available = available_space(reference, obstacles)
            origin = np.array([x, y])
            centers = {}
            for i in indices:
                source = np.asarray(blocks[i].lines).reshape(-1, 2)
                centers[i] = (source.min(axis=0) + source.max(axis=0)) / 2

            def fit_pair(axis, split):
                order = sorted(indices, key=lambda i: centers[i][axis])
                if not 0 < split < available.shape[1-axis]:
                    return None
                pair = []
                for side, i in enumerate(order):
                    budget = available.copy()
                    excluded = [slice(None), slice(None)]
                    excluded[1-axis] = slice(split, None) if side == 0 else slice(None, split)
                    budget[tuple(excluded)] = 0
                    # Feed the cell boundary to the existing collision fitter,
                    # so an outline crossing it slightly is shrunk, not lost.
                    low, high = origin.copy(), origin + available.shape[::-1]
                    if side == 0:
                        low[axis] += split - 1
                    else:
                        high[axis] = origin[axis] + split
                    wall = np.array([low, (high[0], low[1]), high, (low[0], high[1])])
                    rx, ry, rw, rh = native.find_largest_inscribed_rect(budget)
                    candidate, polygon = fit_rectangle(blocks[i], texts[i], (x+rx, y+ry, rw, rh),
                        reference, [*obstacles, (wall, None)], recover=True,
                        best=(copy(blocks[i]), None), cell=(origin, budget))
                    if polygon is None:
                        return None
                    pair.append((i, candidate, polygon))
                if native._polygons_overlap(pair[0][2], pair[1][2]):
                    return None
                return pair

            best_pair = None
            for axis in (0, 1):
                if centers[indices[0]][axis] == centers[indices[1]][axis]:
                    continue
                split = round(sum(centers[i][axis] for i in indices) / 2 - origin[axis])
                pair = fit_pair(axis, split)
                if pair is None:
                    continue
                candidate_score = min(b.font_size / b.original_font_size for _, b, _ in pair)
                # Compare output sizes with output constraints, including the
                # existing final scale and integer rounding, just like the cap.
                if (candidate_score > score and all(b.font_size >= min(blocks[i].font_size,
                        native._apply_final_font_constraints(.75 * b.original_font_size, config))
                        for i, b, _ in pair)):
                    score, best_pair = candidate_score, pair
            if best_pair is not None:
                for i, block, polygon in best_pair:
                    blocks[i], points[i] = block, polygon
    return blocks, points
