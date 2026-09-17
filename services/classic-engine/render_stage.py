"""CPU-only rendering entry points; safe to spawn without importing server/models."""
import logging
import os
import sys
import time


def configure(directory, languages, threads):
    import cv2
    from hyphenation import DictionaryStore
    from typesetter import initialize
    logging.disable(logging.CRITICAL)
    # This process is dedicated to private page work; never print upstream text.
    if not getattr(configure, 'quiet', False):
        sys.stdout = open(os.devnull, 'w')
        sys.stderr = open(os.devnull, 'w')
        configure.quiet = True
    store = DictionaryStore(directory, languages)
    initialize(store)
    cv2.setNumThreads(threads)
    return {'pid': os.getpid()}


async def render_page(image, analysis, translations, config, language, cleaned, *, font, encode=True):
    from image_codec import decode
    from lettering import letter_page
    from render_languages import font_for
    start = time.monotonic()
    mask = decode(analysis['mask'], 'L')
    layout = []
    output, glyph_mask, fitted, bubbles = await letter_page(image, analysis, translations, config, language,
        cleaned, mask, font_for(language, font), layout)
    elapsed = time.monotonic() - start
    result = {'image': output, 'mask': analysis['mask'], 'glyph_mask': glyph_mask,
              'layout_fitted_regions': fitted, 'bubble_regions': bubbles, 'layout': layout,
              'timings': {'render': elapsed, 'render_layout': elapsed}}
    return encode_render(result) if encode else result


def encode_render(result):
    from image_codec import png
    start = time.monotonic()
    encoded = {**result, 'image': png(result['image']), 'glyph_mask': png(result['glyph_mask'])}
    elapsed = time.monotonic() - start
    encoded['timings'] = {**result['timings'], 'render_encode': elapsed,
                          'render': result['timings']['render'] + elapsed}
    return encoded


async def render_in_worker(*args, **kwargs):
    from lettering import LetteringError
    try:
        return await render_page(*args, **kwargs), None
    except LetteringError as error:
        # Exception constructors aren't necessarily pickle round-trip compatible.
        return None, error.code
