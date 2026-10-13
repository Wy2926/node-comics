"""Offline real-model A/B workload with fixed text, hashes and bounded page workers.

Run this same tool in each trusted source snapshot and prepared asset directory.
No center registration, downloads or text-provider calls. Samples stay private.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO
import json
import os
from tempfile import TemporaryDirectory
from pathlib import Path
from time import perf_counter

import numpy as np
from PIL import Image
import torch

from classic_node.protocol import digest
from classic_node.runtime import Runtime
from classic_node.timing import collect
from classic_node.config import ENGINE_DEFAULTS
from tools.validate_render_output import measured, reconstruct


def run(args):
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['TQDM_DISABLE'] = '1'
    source, output = args.input.resolve(), args.output.resolve()
    if output == source or output.is_relative_to(source):
        raise ValueError('Keep reports outside the input directory')
    if output.exists():
        raise ValueError('Use a new report file for every benchmark run')
    assets = args.models.resolve().parent
    fonts = json.loads((assets / 'licenses/font-sources.json').read_text(encoding='utf-8'))['fonts']
    resources = None
    if args.auto_cpu:
        from classic_node.resources import resolve_cpu_resources
        resources = resolve_cpu_resources(analysis_threads='auto', render_workers='auto',
                                          local_pages=args.concurrency, max_leases=8)
        args.threads, args.render_workers = resources['analysis_threads'], resources['render_workers']
    inference = {key: getattr(args, key, default) for key, default in ENGINE_DEFAULTS.items()
                 if key.endswith('_batch_size') or key.startswith('ocr_arena_')}
    if inference['ocr_min_batch_size'] > inference['ocr_batch_size']:
        raise ValueError('ocr_min_batch_size must not exceed ocr_batch_size')
    config = {'engine': {**inference, 'models': str(args.models.resolve()), 'threads': args.threads,
                         'font': [str(assets / 'fonts' / f['name']) for f in fonts]},
              'render_workers': args.render_workers,
              '_render_threads': resources['render_threads'] if resources else 1}
    paths = sorted(p for p in source.iterdir() if p.suffix.lower() in {'.png', '.webp', '.jpg', '.jpeg'})
    if not paths:
        raise ValueError('No input images')
    # An isolated capacity experiment, not a driver/global memory limit. This
    # allocation belongs only to this benchmark and is freed with its process.
    reserve_mib = getattr(args, 'reserve_vram_mib', 0)
    reserved_vram = torch.empty(reserve_mib * 1024 ** 2, dtype=torch.uint8, device='cuda') if reserve_mib else None
    runtime = Runtime(config)
    report = {'engine': runtime.version, 'torch': torch.__version__, 'cuda': torch.version.cuda,
              'gpu': torch.cuda.get_device_name(), 'threads': args.threads,
              'concurrency': args.concurrency, 'render_workers': args.render_workers,
              'cache_bytes_per_page': args.cache_mib * 1024 ** 2,
              'translation_source': 'fixed fixture text; no provider call', 'runs': [], 'cpu_resources': resources,
              'inference_settings': inference, 'reserved_test_vram_mib': reserve_mib}

    def page(path):
        data = path.read_bytes()
        with Image.open(BytesIO(data)) as image:
            metadata = {'normalization_version': 1, 'byte_size': len(data),
                        'sha256': hashlib.sha256(data).hexdigest(),
                        'width': image.width, 'height': image.height, 'mime': Image.MIME[image.format]}
        rgb, alpha = runtime.decode(data, metadata)
        masks = {}
        try:
            with collect() as timings:
                start = perf_counter()
                analysis = runtime.analyze(rgb, metadata['sha256'], masks=masks)
                timings['analyze'] = perf_counter() - start
                start = perf_counter()
                cleaned = runtime.inpaint(rgb, analysis, masks=masks)
                timings['inpaint'] = perf_counter() - start
                for name in ('mask', 'raw_mask'):
                    masks.pop(name, None)
                if 'bubble_inset' in masks:
                    masks.pop('bubble_mask', None)
                # Vary length deterministically, preserving identical text in A/B.
                texts = {str(s['id']): ('THIS PERSON COULD USE MAGIC TO CONTROL ALL THINGS.'
                         if i % 3 else 'WHY?') for i, s in enumerate(analysis['segments'])}
                translated = {'analysis_hash': digest(analysis), 'language': 'en',
                              'translations': texts, 'revision': digest(texts)}
                start = perf_counter()
                packed = runtime.render(rgb, cleaned, analysis, translated, 'en', alpha,
                                        masks=masks, allow_tiles=True,
                                        mask_cache_bytes=args.cache_mib * 1024 ** 2)
                timings['render'] = perf_counter() - start
            final = reconstruct(packed, rgb, np.asarray(alpha) if alpha is not None else None)
            return {'file': path.name, 'input_sha256': metadata['sha256'],
                    'size': [metadata['width'], metadata['height']], 'regions': len(texts),
                    'timings': timings,
                    'image_stage_seconds': sum(timings[k] for k in ('analyze', 'inpaint', 'render')),
                    'analysis_sha256': digest({k: v for k, v in analysis.items() if k != 'version'}),
                    'clean_sha256': hashlib.sha256(cleaned.tobytes()).hexdigest(),
                    'pixels_sha256': hashlib.sha256(np.asarray(final).tobytes()).hexdigest(),
                    'output_sha256': hashlib.sha256(packed['output_bytes'] or b'').hexdigest(),
                    'representation': packed['result']['representation']}
        finally:
            if alpha is not None:
                alpha.close()

    try:
        runtime.warmup()
        if args.pipeline:
            from tools.validate_pipeline_pressure import exercise
            inputs = [path.read_bytes() for path in paths]
            # Warm all shapes, then exercise the actual eight-lease memory gate,
            # stage scheduling, IPC reservations and local fallback each run.
            with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
                list(pool.map(page, paths))
            report['pipeline_resident_bytes'] = args.resident_mib * 1024 ** 2
            report['cache_bytes_per_page'] = None
            for repeat in range(args.repeats):
                torch.cuda.reset_peak_memory_stats()
                with TemporaryDirectory(prefix='long-pipeline-') as directory:
                    result, resources = measured(lambda: exercise(Path(directory), 'throughput', runtime,
                        total=args.total, timeout=600, local_pages=args.concurrency, inputs=inputs,
                        local={'resident_bytes': args.resident_mib * 1024 ** 2,
                               'render_workers': args.render_workers}))
                report['runs'].append({**resources, **result,
                    'torch_peak_reserved_bytes': torch.cuda.max_memory_reserved()})
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
                print(json.dumps({'repeat': repeat, 'pipeline_wall_seconds': result['wall_s'],
                                  'completed': result['completed']}), flush=True)
            return
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            # Warm every page shape and render worker before recording samples.
            list(pool.map(page, paths))
            for repeat in range(args.repeats):
                torch.cuda.reset_peak_memory_stats()
                pages, resources = measured(lambda: list(pool.map(page, paths)))
                resources['torch_peak_allocated_bytes'] = torch.cuda.max_memory_allocated()
                resources['torch_peak_reserved_bytes'] = torch.cuda.max_memory_reserved()
                report['runs'].append({'pages': pages, **resources})
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
                print(json.dumps({'repeat': repeat, 'wall_seconds': resources['wall_seconds'],
                                  'pages': [{k: p[k] for k in ('file', 'regions', 'image_stage_seconds')}
                                            for p in pages]}), flush=True)
    finally:
        runtime.close()
        del reserved_vram


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--repeats', type=int, choices=range(1, 21), default=3)
    parser.add_argument('--concurrency', type=int, choices=range(1, 9), default=1)
    parser.add_argument('--render-workers', type=int, choices=range(1, 9), default=2)
    parser.add_argument('--threads', type=int, choices=range(1, 33), default=3)
    parser.add_argument('--cache-mib', type=int, choices=range(0, 2049), default=512)
    parser.add_argument('--pipeline', action='store_true', help='Use the real node scheduling and memory gate')
    parser.add_argument('--resident-mib', type=int, choices=range(512, 65537), default=8192)
    parser.add_argument('--total', type=int, choices=range(8, 65), default=12)
    parser.add_argument('--auto-cpu', action='store_true', help='Exercise the node CPU resource planner')
    parser.add_argument('--reserve-vram-mib', type=int, choices=range(0, 16385), default=0, metavar='0..16384',
                        help='Reserve test-only CUDA memory to simulate a smaller GPU; never use on a busy device')
    for key in ('ocr_batch_size', 'ocr_min_batch_size', 'color_batch_size', 'detect_batch_size'):
        parser.add_argument('--' + key.replace('_', '-'), type=int, choices=range(1, 33), default=ENGINE_DEFAULTS[key])
    parser.add_argument('--ocr-arena-extend-strategy', choices=('kSameAsRequested', 'kNextPowerOfTwo'),
                        default=ENGINE_DEFAULTS['ocr_arena_extend_strategy'])
    parser.add_argument('--ocr-arena-shrinkage', action=argparse.BooleanOptionalAction,
                        default=ENGINE_DEFAULTS['ocr_arena_shrinkage'])
    run(parser.parse_args())
