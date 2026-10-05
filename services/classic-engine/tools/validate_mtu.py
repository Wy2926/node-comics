"""Run real CUDA/Qt pages with fixed translations, preserving inputs and stage evidence."""
import argparse
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
from time import perf_counter

import numpy as np
from PIL import Image, ImageDraw
import psutil
os.environ['TQDM_DISABLE'] = '1'
import torch

from classic_node.protocol import digest
from classic_node.runtime import Runtime
from mtu_engine.engine import LANGUAGES
from classic_node.timing import collect


def run(args):
    source, output = args.input.resolve(), args.output.resolve()
    if output == source or output.is_relative_to(source):
        raise ValueError('Use a separate output directory')
    if args.reference and (output == args.reference.resolve() or output.is_relative_to(args.reference.resolve())):
        raise ValueError('Keep reference images separate from generated outputs')
    output.mkdir(parents=True, exist_ok=True)
    fonts = json.loads((args.models.parent / 'licenses/font-sources.json').read_text(encoding='utf-8'))['fonts']
    options = {'models': str(args.models.resolve()), 'keep_lang': args.keep_lang,
               'font': [str((args.models.parent / 'fonts' / f['name']).resolve()) for f in fonts]}
    started = perf_counter()
    runtime = Runtime({'engine': options})
    runtime.warmup()
    startup = perf_counter() - started
    translations = json.loads(args.translations.read_text(encoding='utf-8')) if args.translations else {}
    paths = sorted(p for p in source.iterdir() if p.suffix.lower() in ('.webp', '.jpg', '.jpeg', '.png'))
    if args.limit:
        paths = paths[:args.limit]
    report = {'engine': runtime.version, 'gpu': torch.cuda.get_device_name(), 'startup_seconds': startup,
              'translation_source': 'fixed supplied text; no text-provider request',
              'language': args.language, 'keep_lang': args.keep_lang, 'pages': []}
    try:
        for path in paths:
            data = path.read_bytes()
            with Image.open(BytesIO(data)) as img:
                rgb = np.array(img.convert('RGB'))
            input_hash = hashlib.sha256(data).hexdigest()
            checkpoint = output / (path.stem + '.analysis.json')
            clean = output / (path.stem + '.clean.png')
            torch.cuda.reset_peak_memory_stats()
            started = perf_counter()
            cached = False
            with collect() as timings:
                if checkpoint.exists() and clean.exists():
                    analysis = json.loads(checkpoint.read_text(encoding='utf-8'))
                    cached = analysis['input_hash'] == input_hash and analysis['version'] == runtime.version
                if cached:
                    with Image.open(clean) as img:
                        cleaned = np.array(img.convert('RGB'))
                else:
                    stage = perf_counter()
                    analysis = runtime.analyze(rgb, input_hash)
                    timings['analyze'] = perf_counter() - stage
                    checkpoint.write_text(json.dumps(analysis, ensure_ascii=False), encoding='utf-8')
                    stage = perf_counter()
                    cleaned = runtime.inpaint(rgb, analysis) if analysis['regions'] else rgb.copy()
                    timings['inpaint'] = perf_counter() - stage
                    Image.fromarray(cleaned).save(clean)
                rendered = None
                if path.name in translations:
                    translated = {'analysis_hash': digest(analysis), 'language': args.language,
                                  'translations': translations[path.name], 'revision': digest(translations[path.name])}
                    packed = runtime.render(rgb, cleaned, analysis, translated, args.language, None, allow_tiles=True)
                    if packed['result']['representation'] == 'original':
                        rendered = Image.fromarray(rgb)
                    elif packed['result']['representation'] == 'overlay-v1':
                        rendered = Image.fromarray(rgb)
                        with Image.open(BytesIO(packed['output_bytes'])) as patch:
                            box = packed['result']['bbox']
                            rendered.paste(patch, (box['x'], box['y']), patch)
                    else:
                        raise ValueError('Use the node client to reconstruct tiled validation pages')
                    rendered.save(output / (path.stem + '.' + args.language + '.png'))
                if rendered is not None and args.reference and (args.reference / path.name).is_file():
                    with Image.open(args.reference / path.name) as reference:
                        width = min(900, rgb.shape[1])
                        height = round(width * rgb.shape[0] / rgb.shape[1])
                        panel = Image.new('RGB', (width * 3, height + 40), 'white')
                        draw = ImageDraw.Draw(panel)
                        for index, (label, page) in enumerate((('ORIGINAL', Image.fromarray(rgb)), ('MTU / CUDA / Qt', rendered), ('REFERENCE', reference))):
                            panel.paste(page.convert('RGB').resize((width, height)), (width * index, 40))
                            draw.text((width * index + 16, 10), label, fill='black')
                        panel.save(output / (path.stem + '.' + args.language + '.compare.jpg'), quality=95)
            page = {'file': path.name, 'input_sha256': input_hash, 'width': rgb.shape[1], 'height': rgb.shape[0],
                    'regions': len(analysis['regions']), 'cached_analysis_and_inpaint': cached,
                    'seconds': perf_counter() - started, 'timings': timings,
                    'cuda_peak_allocated_mib': torch.cuda.max_memory_allocated() / 2**20,
                    'cuda_peak_reserved_mib': torch.cuda.max_memory_reserved() / 2**20,
                    'rss_mib': psutil.Process().memory_info().rss / 2**20, 'rendered': rendered is not None}
            report['pages'].append(page)
            print(json.dumps(page), flush=True)
            (output / 'metrics.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    finally:
        runtime.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--models', type=Path, default=Path('.assets/models'))
    parser.add_argument('--translations', type=Path)
    parser.add_argument('--language', choices=list(LANGUAGES), default='en')
    parser.add_argument('--keep-lang', help='Optional ISO 639-1 source filter, e.g. zh for the Chinese-only comparison')
    parser.add_argument('--limit', type=int)
    run(parser.parse_args())
