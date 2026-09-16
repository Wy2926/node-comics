"""Bounded lettering around upstream layout, with content-free failure codes."""
from copy import deepcopy
import cv2
import numpy as np
from manga_translator.rendering import dispatch, render
from manga_translator.utils import TextBlock
from render_languages import LANG, normalized_text, select_font
from speech_bubbles import find_bubble


class LetteringError(ValueError):
    def __init__(self, reason):
        self.code = 'CLASSIC_RENDER_' + reason
        super().__init__(self.code)


def changed_pixels(before, after, protected, bubble=None):
    changed = np.any(after != before, axis=2)
    if not changed.any():
        raise LetteringError('NO_GLYPHS')
    if changed[0].any() or changed[-1].any() or changed[:, 0].any() or changed[:, -1].any():
        raise LetteringError('BOUNDARY')
    if np.any(changed & protected):
        raise LetteringError('OVERLAP')
    if bubble is not None and not bubble.contains(changed):
        raise LetteringError('BUBBLE_OVERFLOW')
    return changed


async def render_region(canvas, region, font, minimum, protected, bubble=None):
    """Try natural layout, then fit all glyphs into the original OCR rectangle.

    Upstream expands short vertical boxes without page/protected-region bounds.
    Re-render from a clean canvas; never crop overflowing glyphs from a result.
    """
    try:
        candidate = await dispatch(canvas.copy(), [deepcopy(region)], font,
                                   font_size_minimum=minimum, hyphenate=False)
        return candidate, changed_pixels(canvas, candidate, protected, bubble), False
    except LetteringError as error:
        reason = error
    except (ValueError, ZeroDivisionError, cv2.error):
        reason = LetteringError('LAYOUT_FAILED')
    original = (bubble.rectangle if bubble is not None else region.min_rect).astype(np.float64)
    if not np.isfinite(original).all():
        raise LetteringError('INPUT_INVALID')
    height, width = canvas.shape[:2]
    # Fit/translate the whole rectangle within an inset page, keeping its shape.
    low, high = original.reshape(-1, 2).min(axis=0), original.reshape(-1, 2).max(axis=0)
    size = high - low
    if np.any(size <= 0) or min(width, height) <= 4:
        raise LetteringError('INPUT_INVALID')
    fit = min(1, (width - 4) / size[0], (height - 4) / size[1])
    center = (low + high) / 2
    base = (original - center) * fit
    extent = size * fit / 2
    center = np.clip(center, 2 + extent, np.array([width - 2, height - 2]) - extent)
    for scale in (1, .85, .7):
        points = base * scale + center
        if min(size * fit * scale) < minimum:
            continue
        bounded_region = deepcopy(region)
        bounded_region.font_size = max(minimum, int(region.font_size))
        try:
            candidate = render(canvas.copy(), bounded_region, points.astype(np.float32), False, None, False)
            return candidate, changed_pixels(canvas, candidate, protected, bubble), True
        except LetteringError as error:
            reason = error
        except (ValueError, ZeroDivisionError, cv2.error):
            reason = LetteringError('LAYOUT_FAILED')
    raise reason


async def letter_page(image, analysis, translations, config, language, cleaned, mask, renderer, font, fallback):
    try:
        regions = [TextBlock(**row) for row in analysis['regions']]
        if not regions or len(regions) != len(analysis['segments']):
            raise LetteringError('INPUT_INVALID')
        if mask.shape != image.shape[:2] or cleaned.shape != image.shape:
            raise LetteringError('INPUT_INVALID')
        if np.any(cleaned[mask == 0] != image[mask == 0]):
            raise LetteringError('INPUT_INVALID')
        protected = np.zeros(mask.shape, dtype=np.uint8)
        for polygon in analysis.get('unrecognized_regions', []):
            cv2.fillConvexPoly(protected, np.array(polygon, dtype=np.int32), 255)
        protected = protected > 0
        if np.any((mask > 0) & protected):
            raise LetteringError('INPUT_INVALID')
        select_font(renderer, font, language)
        faces = [renderer.get_cached_font(path) for path in dict.fromkeys([font, fallback])]
        for segment, region in zip(analysis['segments'], regions):
            region.translation = normalized_text(translations[segment['id']])
            if any(not char.isspace() and not any(face.get_char_index(ord(char)) for face in faces)
                   for char in region.translation):
                raise LetteringError('FONT_MISSING')
            region.target_lang = LANG[language]
            if language not in {'zh-Hans', 'zh-Hant', 'ja'}:
                region._direction = 'h'
            region._alignment = 'center'
        rendered = cleaned.copy()
        glyph_mask = np.zeros(mask.shape, dtype=np.uint8)
        fitted = 0
        bubbles = 0
        for region in regions:
            bubble = find_bubble(cleaned, region, [other for other in regions if other is not region])
            rendered, changed, used_fit = await render_region(rendered, region, font, config['font_minimum'], protected, bubble)
            glyph_mask[changed] = 255
            fitted += used_fit
            bubbles += bubble is not None
        output = image.copy()
        allowed = (mask > 0) | (glyph_mask > 0)
        output[allowed] = rendered[allowed]
        return output, glyph_mask, fitted, bubbles
    except LetteringError:
        raise
    except (KeyError, TypeError, ValueError, IndexError):
        raise LetteringError('INPUT_INVALID') from None
