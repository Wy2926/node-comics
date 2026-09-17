"""Validated delivery of the pinned upstream Qt typesetter's full-page layout."""
import cv2
import numpy as np
import re
from render_languages import LANG, normalized_text
from speech_bubbles import find_bubble
from typesetter import initialize, configuration
from typesetter_inputs import BubbleInput, current_bubbles


class LetteringError(ValueError):
    def __init__(self, reason):
        self.code = 'CLASSIC_RENDER_' + reason
        super().__init__(self.code)


def validate_glyphs(alpha, origin, protected, bubble=None):
    """Validate native ink before clipping; return only its page-local slice.

    Transparent padding may extend outside the page. Actual ink may not.
    All per-layer scans and temporary arrays are bounded by the native layer.
    """
    left, top, width, height = cv2.boundingRect(alpha)
    if not width or not height:
        return None
    x, y = origin[0] + left, origin[1] + top
    if x <= 0 or y <= 0 or x + width >= protected.shape[1] or y + height >= protected.shape[0]:
        raise LetteringError('BOUNDARY')
    glyphs = alpha[top:top+height, left:left+width] > 0
    area = (slice(y, y + height), slice(x, x + width))
    if np.any(glyphs & protected[area]):
        raise LetteringError('OVERLAP')
    if bubble is not None and not bubble.contains(glyphs, (x, y)):
        raise LetteringError('BUBBLE_OVERFLOW')
    return area, glyphs


def font_family(renderer, path, language):
    renderer.text_render.load_font_file(path)
    families = renderer.text_render.register_font_file(path)
    suffix = {'zh-Hans': 'SC', 'zh-Hant': 'TC', 'ja': 'JP', 'ko': 'KR'}.get(language)
    family = next((value for value in families if suffix and value.endswith(' ' + suffix)), None)
    if not family:
        family = next(iter(families), None)
    if not family:
        raise LetteringError('FONT_MISSING')
    return family


BREAKS = r'\[BR\]|【BR】|<br>|\n'


def text_preserved(source, formatted):
    expected = ''.join(re.sub(BREAKS, '', source, flags=re.IGNORECASE).split())
    lines = re.split(BREAKS, formatted, flags=re.IGNORECASE)
    position = 0
    for number, line in enumerate(lines):
        content = ''.join(line.split())
        for index, char in enumerate(content):
            if position < len(expected) and char == expected[position]:
                position += 1
            elif char in '-\u00ad' and index == len(content) - 1 and number < len(lines) - 1:
                continue  # Only newly inserted line-end hyphens may be omitted.
            else:
                return False
    return position == len(expected)


async def letter_page(image, analysis, translations, config, language, cleaned, mask, font, diagnostics=None):
    from PyQt6.QtGui import QFont, QRawFont
    try:
        renderer = initialize()
        regions = [renderer.TextBlock(**row) for row in analysis['regions']]
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
        minimum = max(1, int(config['font_minimum']))
        family = font_family(renderer, font, language)
        face = QRawFont.fromFont(QFont(family))
        source_sizes = []
        source_text = {}
        for segment, region in zip(analysis['segments'], regions):
            region.translation = normalized_text(translations[segment['id']])
            source_text[id(region)] = region.translation
            if any(not char.isspace() and not face.supportsCharacter(ord(char)) for char in region.translation):
                raise LetteringError('FONT_MISSING')
            region.target_lang = LANG[language]
            if language not in {'zh-Hans', 'zh-Hant', 'ja'}:
                region._direction = 'h'
            region._alignment = 'center'
            region.font_family = family
            region.default_stroke_width = .07
            region.allow_reflow = True
            source_sizes.append(region.font_size)

        bubbles = {}
        usable = np.zeros(mask.shape, dtype=np.uint8)
        for region in regions:
            bubble = find_bubble(cleaned, region, [])
            bubbles[id(region)] = bubble
            if bubble is not None:
                x, y = bubble.origin
                h, w = bubble.interior.shape
                usable[y:y+h, x:x+w] |= bubble.interior.astype(np.uint8) * 255
            else:
                cv2.fillConvexPoly(usable, np.rint(region.min_rect.reshape(-1, 2)).astype(np.int32), 255)
                # Preserve the exact OCR polygons as well as their rotated box;
                # integer rounding must not disable upstream's mask fitting.
                cv2.fillPoly(usable, list(np.asarray(region.lines).astype(np.int32)), 255)
        # Protection constrains layout before fitting as well as final delivery.
        usable[protected] = 0
        usable[:2] = usable[-2:] = 0
        usable[:, :2] = usable[:, -2:] = 0
        glyph_mask = np.zeros(mask.shape, dtype=np.uint8)
        occupied = np.zeros(mask.shape, dtype=bool)
        visible_regions = set()
        options = configuration(minimum, family)

        def paint(canvas, region, *args, render_alpha=None, paint_part=None, **kwargs):
            if region.font_size < minimum:
                raise LetteringError('LAYOUT_FAILED')

            def record_native_layer(alpha, origin):
                ink = validate_glyphs(alpha, origin, protected, bubbles[id(region)])
                if ink is None:
                    return
                area, glyphs = ink
                if paint_part == 'fill':
                    if np.any(glyphs & occupied[area]):
                        raise LetteringError('OVERLAP')
                    occupied[area] |= glyphs
                    visible_regions.add(id(region))
                glyph_mask[area][glyphs] = 255

            return renderer.render(canvas, region, *args, paint_part=paint_part,
                                   layer_callback=record_native_layer, **kwargs)

        token = current_bubbles.set(BubbleInput(usable))
        try:
            rendered = await renderer.dispatch(cleaned.copy(), regions, options, original_img=image,
                                               skip_text_replacements=True, render_callback=paint)
        finally:
            current_bubbles.reset(token)
        if len(visible_regions) != len(regions):
            raise LetteringError('NO_GLYPHS')
        for region in regions:
            if not text_preserved(source_text[id(region)], region.translation):
                raise LetteringError('LAYOUT_FAILED')
            if diagnostics is not None:
                diagnostics.append({'font_size': int(region.font_size), 'direction': 'h' if region.horizontal else 'v',
                                    'bubble': bubbles[id(region)] is not None,
                                    'lines': len(re.split(r'\[BR\]|【BR】|<br>|\n', region.translation))})
        output = image.copy()
        allowed = (mask > 0) | (glyph_mask > 0)
        output[allowed] = rendered[allowed]
        fitted = sum(abs(region.font_size - before) > .1 for region, before in zip(regions, source_sizes))
        return output, glyph_mask, fitted, sum(value is not None for value in bubbles.values())
    except LetteringError:
        raise
    except (KeyError, TypeError, ValueError, IndexError):
        raise LetteringError('INPUT_INVALID') from None
