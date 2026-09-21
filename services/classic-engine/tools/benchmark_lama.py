"""Local image-work benchmark: real OCR/LaMa, fixed text, no network requests."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO
import json
from pathlib import Path
import time

import numpy as np
from PIL import Image

from classic_node.protocol import digest, mask_image
from classic_node.runtime import Runtime
from manhua_engine.cli import Monitor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', type=Path)
    parser.add_argument('--models', default='models')
    parser.add_argument('--ocr-language', default='zh')
    parser.add_argument('--repeats', type=int, default=8)
    parser.add_argument('--depths', default='1,2,8')
    parser.add_argument('--output', type=Path, default=Path('artifacts/lama-validation/benchmark'))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    source = args.image.read_bytes()
    with Image.open(BytesIO(source)) as image:
        metadata = {'sha256': hashlib.sha256(source).hexdigest(), 'byte_size': len(source),
                    'width': image.width, 'height': image.height, 'mime': Image.MIME[image.format]}
        image.save(args.output / 'source.png')
    options = {'models': args.models, 'gpu': 0, 'threads': 2, 'ocr_workers': 8,
               'ocr_language': args.ocr_language, 'tile': 768, 'detect_size': 1280}
    runtime = Runtime({'engine': options, 'languages': ['en']})
    started = time.perf_counter()
    reference = None
    rows = []
    try:
        runtime.warmup()
        warmup = time.perf_counter() - started

        def page(index, save):
            started = time.perf_counter()
            timings = {}
            before = time.perf_counter()
            rgb, alpha = runtime.decode(source, metadata)
            timings['decode'] = time.perf_counter() - before
            before = time.perf_counter()
            analysis = runtime.analyze(rgb, metadata['sha256'])
            timings['analyze'] = time.perf_counter() - before
            assert analysis['segments'], 'Choose a page containing recognized text'
            before = time.perf_counter()
            cleaned = runtime.inpaint(rgb, analysis)
            timings['inpaint_including_model_wait'] = time.perf_counter() - before
            translated = {'revision': 'fixture', 'analysis_hash': digest(analysis), 'language': 'en',
                          'translations': {s['id']: 'A quiet day.' for s in analysis['segments']}}
            before = time.perf_counter()
            result = runtime.render(cleaned, analysis, translated, 'en', alpha)
            timings['render_encode'] = time.perf_counter() - before
            timings['total'] = time.perf_counter() - started
            mask = np.array(mask_image(analysis['mask'], (rgb.shape[1], rgb.shape[0])))
            outside = int(np.count_nonzero(np.any(cleaned != rgb, axis=-1) & (mask == 0)))
            assert outside == 0
            cleaned_hash = hashlib.sha256(cleaned.tobytes()).hexdigest()
            if save and index == 0:
                Image.fromarray(cleaned).save(args.output / 'cleaned.png')
                Image.fromarray(mask).save(args.output / 'mask.png')
                (args.output / 'rendered-fixture.png').write_bytes(base64.b64decode(result['image']))
                overlay = rgb.copy()
                overlay[mask > 0] = [255, 80, 80]
                Image.fromarray(np.concatenate([rgb, overlay, cleaned], axis=1)).save(args.output / 'comparison.png')
            return {'timings': timings, 'regions': len(analysis['segments']),
                    'outside_changed_pixels': outside, 'cleaned_sha256': cleaned_hash,
                    'output_sha256': result['result']['output']['sha256']}

        for depth in map(int, args.depths.split(',')):
            started = time.perf_counter()
            with Monitor() as monitor, ThreadPoolExecutor(depth) as pool:
                records = list(pool.map(lambda index: page(index, not rows), range(args.repeats)))
            elapsed = time.perf_counter() - started
            signatures = {(r['cleaned_sha256'], r['output_sha256']) for r in records}
            if reference is None:
                reference = signatures
            assert signatures == reference and len(signatures) == 1, 'Serial/concurrent output differs'
            samples = monitor.samples
            row = {'depth': depth, 'pages': len(records), 'wall_s': elapsed,
                   'pages_per_minute': len(records) * 60 / elapsed,
                   'stages': {key: {'mean_s': float(np.mean([r['timings'][key] for r in records])),
                                    'p95_s': float(np.quantile([r['timings'][key] for r in records], .95))}
                              for key in records[0]['timings']},
                   'peak_rss_mb': max((s['rss_mb'] for s in samples), default=None),
                   'mean_cpu_cores': float(np.mean([s['process_cpu_cores'] for s in samples])) if samples else None,
                   'identical_pixels': True, 'records': records}
            rows.append(row)
            report = {'engine_version': runtime.version, 'inpainting_backend': runtime.engine.inpainter.backend,
                      'source_size': [metadata['width'], metadata['height']], 'ocr_language': args.ocr_language,
                      'warmup_s': warmup, 'text': 'fixed fixture', 'network_requests': 0, 'rows': rows}
            (args.output / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(json.dumps({k: v for k, v in row.items() if k != 'records'}), flush=True)
    finally:
        runtime.close()


if __name__ == '__main__':
    main()
