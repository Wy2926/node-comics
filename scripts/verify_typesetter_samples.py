"""Replay private comic samples through OCR, LaMa and the pinned Qt typesetter.

Uses saved translations only if the complete OCR ID/source mapping matches.
Writes images and content-free evidence locally; never calls LLMs or storage.
"""
import argparse
import asyncio
from contextlib import redirect_stderr, redirect_stdout
import json
import logging
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'services/classic-engine'), str(ROOT / 'engines/mit-native')]
os.environ.setdefault('MODEL_DIR', str(ROOT / 'engines/mit-models'))
os.environ.setdefault('ENGINE_FONT', str(ROOT / 'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'))
os.environ.setdefault('ENGINE_DEVICE', 'cpu')
os.environ.setdefault('ENGINE_RESOURCE_ID', 'typesetter-acceptance-cpu')
os.environ.setdefault('ENGINE_LOCK_DIR', str(ROOT / 'private-test-data/qt-lettering-validation/locks'))

import numpy as np
from PIL import Image, ImageDraw
import server
from prepare_typesetter import REVISION


async def verify(args):
    logging.disable(logging.CRITICAL)
    args.output.mkdir(parents=True, exist_ok=True)
    config = {'version': server.VERSION, 'detection_size': 1536, 'reading_order': 'rtl', 'mask_dilation': 3,
              'font_minimum': 10, 'inpainting_strategy': 'masked-crops-v1', 'inpainting_size': 512,
              'inpainting_padding': 48, 'inpainting_merge_gap': 24}
    report = {'engine_version': server.VERSION, 'typesetter_revision': REVISION,
              'device': server.DEVICE, 'text_calls': 0, 'samples': []}
    with patch('urllib.request.urlopen', side_effect=AssertionError('Acceptance must stay offline')), \
         patch('requests.get', side_effect=AssertionError('Acceptance must stay offline')), \
         open(os.devnull, 'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
        async with server.lifespan(server.app):
            for sample in args.samples:
                folder = args.source / sample
                image = np.array(Image.open(folder / 'original.png').convert('RGB'))
                saved = json.loads((folder / 'stages.json').read_text(encoding='utf-8'))
                analysis = await server.analyze(image, config)
                assert analysis['segments'] == saved['segments'], 'OCR mapping changed; cannot reuse saved translations'
                erased = await server.erase_page(image, analysis, config)
                # Private replay checkpoints never enter the repository or logs.
                (args.output / f'{sample}-analysis.json').write_text(json.dumps(analysis), encoding='utf-8')
                Image.fromarray(server.decode(erased['cleaned'])).save(args.output / f'{sample}-cleaned.png')
                result = await server.render_page(image, analysis, saved['translations'], config, args.language,
                                                  server.decode(erased['cleaned']))
                final = server.decode(result['image'])
                mask = server.decode(result['mask'], 'L') > 0
                glyphs = server.decode(result['glyph_mask'], 'L') > 0
                assert final.shape == image.shape and glyphs.any()
                np.testing.assert_array_equal(final[~(mask | glyphs)], image[~(mask | glyphs)])
                Image.fromarray(final).save(args.output / f'{sample}-rendered.png')
                height, width = image.shape[:2]
                comparison = Image.new('RGB', (width * 2, height + 24), 'white')
                comparison.paste(Image.fromarray(image), (0, 24))
                comparison.paste(Image.fromarray(final), (width, 24))
                draw = ImageDraw.Draw(comparison)
                draw.text((8, 4), 'Source', fill='black')
                draw.text((width + 8, 4), 'Qt typesetter / saved translation', fill='black')
                comparison.save(args.output / f'{sample}-comparison.png')
                report['samples'].append({'sample': sample, 'segments': len(analysis['segments']),
                    'unrecognized_regions': len(analysis.get('unrecognized_regions', [])),
                    'bubbles': result['bubble_regions'], 'layout': result['layout'],
                    'source_size_preserved': True, 'outside_allowed_pixels_unchanged': True,
                    'timings': {**analysis['timings'], **erased['timings'], **result['timings']}})
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'private-test-data')
    parser.add_argument('--output', type=Path, default=ROOT / 'private-test-data/qt-lettering-validation')
    parser.add_argument('--samples', nargs='+', default=['classic-smoke-v2', 'classic-dialogue'])
    parser.add_argument('--language', default='zh-Hans', help='Language of the saved translations')
    asyncio.run(verify(parser.parse_args()))
