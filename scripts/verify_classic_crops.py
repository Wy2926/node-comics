"""Offline real-LaMa comparison using existing private masks; never calls a text provider.

Run in the classic engine image with /samples containing the recorded sample folders,
/output writable, and the current engine source mounted at /opt/engine.
"""
import asyncio
from contextlib import redirect_stderr, redirect_stdout
import json
import logging
import os
from pathlib import Path
import statistics
import sys
import time

import numpy as np
from PIL import Image
import torch
from manga_translator.config import InpainterConfig
from manga_translator.inpainting.inpainting_lama_mpe import LamaLargeInpainter
from manga_translator.utils import ModelWrapper
from local_inpainting import inpaint_regions, plan_regions


OPTIONS = dict(max_size=512, padding=48, merge_gap=24)


async def main():
    logging.disable(logging.CRITICAL)
    torch.set_num_threads(4)
    ModelWrapper._MODEL_DIR = '/models'
    inpainter = LamaLargeInpainter()
    with open(os.devnull, 'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
        await inpainter.load('cpu')
    output = Path('/output')
    output.mkdir(parents=True, exist_ok=True)
    report = {'engine_version': os.environ.get('ENGINE_VERSION', 'mit-95227a2-classic-v3-parallel'), 'device': 'cpu', 'threads': 4,
              'precision': 'fp32', 'crop_options': OPTIONS, 'text_calls': 0, 'samples': []}

    async def predict(image, mask):
        return await inpainter.inpaint(image, mask, InpainterConfig(inpainting_precision='fp32'), 512, False)

    # Small warm-up, excluded from timings.
    warm = np.full((128, 128, 3), 255, np.uint8)
    warm_mask = np.zeros((128, 128), np.uint8)
    warm_mask[50:70, 50:70] = 255
    await predict(warm, warm_mask)
    for sample in ('classic-smoke-v2', 'classic-dialogue'):
        folder = Path('/samples') / sample
        image = np.array(Image.open(folder / 'original.png').convert('RGB'))
        mask = np.array(Image.open(folder / 'mask.png').convert('L'))
        regions = plan_regions(mask, **OPTIONS)
        durations = {'whole': [], 'crops': []}
        # Alternate order to reduce warm-cache / load bias; three runs per path.
        for repeat in range(3):
            for method in (('whole', 'crops') if repeat % 2 == 0 else ('crops', 'whole')):
                start = time.monotonic()
                if method == 'whole':
                    result = await inpainter.inpaint(image.copy(), mask.copy(), InpainterConfig(inpainting_precision='fp32'), 1024, False)
                else:
                    result = await inpaint_regions(image, mask, predict, **OPTIONS)
                durations[method].append(time.monotonic() - start)
                np.testing.assert_array_equal(result[mask == 0], image[mask == 0])
                Image.fromarray(result).save(output / f'{sample}-{method}.png')
        row = {'sample': sample, 'width': image.shape[1], 'height': image.shape[0],
               'regions': len(regions), 'crop_sizes': [[x1 - x0, y1 - y0] for _, (x0, y0, x1, y1) in regions],
               'source_pixels': int(mask.size),
               'crop_input_pixels': sum((x1 - x0) * (y1 - y0) for _, (x0, y0, x1, y1) in regions),
               'seconds': durations, 'median_seconds': {k: statistics.median(v) for k, v in durations.items()},
               'outside_mask_unchanged': True}
        report['samples'].append(row)
        print(json.dumps(row), flush=True)
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')


async def verify_render():
    import server

    config = {'version': server.VERSION, 'detection_size': 1536, 'reading_order': 'rtl', 'mask_dilation': 3,
              'font_minimum': 10, 'inpainting_strategy': 'masked-crops-v1', 'inpainting_size': OPTIONS['max_size'],
              'inpainting_padding': OPTIONS['padding'], 'inpainting_merge_gap': OPTIONS['merge_gap']}
    output = Path('/output')
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    async with server.lifespan(server.app):
        real_inpainter = server.models['inpainter']

        class CheckedInpainter:
            async def inpaint(self, image, mask, *args):
                assert max(image.shape[:2]) <= OPTIONS['max_size']
                sizes.append([image.shape[1], image.shape[0]])
                return await real_inpainter.inpaint(image, mask, *args)

        server.models['inpainter'] = CheckedInpainter()
        for sample in ('classic-smoke-v2', 'classic-dialogue'):
            sizes = []
            folder = Path('/samples') / sample
            image = np.array(Image.open(folder / 'original.png').convert('RGB'))
            saved = json.loads((folder / 'stages.json').read_text())
            analysis = await server.analyze(image, config)
            # Reuse a translation only when the full ID/source mapping is unchanged.
            assert analysis['segments'] == saved['segments'], 'OCR changed; saved translations cannot be reused'
            erased = await server.erase_page(image, analysis, config)
            result = await server.render_page(image, analysis, saved['translations'], config, 'zh-Hans', server.decode(erased['cleaned']))
            final = server.decode(result['image'])
            mask = server.decode(result['mask'], 'L')
            glyph_mask = server.decode(result['glyph_mask'], 'L')
            allowed = (mask > 0) | (glyph_mask > 0)
            assert glyph_mask.any()
            assert final.shape == image.shape
            np.testing.assert_array_equal(final[~allowed], image[~allowed])
            for field in ('image', 'mask', 'glyph_mask'):
                (output / f'{sample}-render-{field}.png').write_bytes(server.base64.b64decode(result[field]))
            (output / f'{sample}-render-cleaned.png').write_bytes(server.base64.b64decode(erased['cleaned']))
            previous = Path('/samples/classic-crops') / f'{sample}-render-image.png'
            previous_matches = None
            if previous.exists():
                np.testing.assert_array_equal(final, np.array(Image.open(previous).convert('RGB')))
                previous_matches = True
            rows.append({'sample': sample, 'segments': len(analysis['segments']),
                         'quality_flags': analysis.get('quality_flags', []), 'actual_lama_input_sizes': sizes,
                         'source_size_preserved': True, 'outside_allowed_pixels_unchanged': True,
                         'matches_previous_crop_output': previous_matches,
                         'timings': {**analysis['timings'], **erased['timings'], **result['timings']}})
    report = {'engine_version': server.VERSION, 'text_calls': 0, 'samples': rows}
    (output / 'render-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)


asyncio.run(verify_render() if sys.argv[1:] == ['render'] else main())
