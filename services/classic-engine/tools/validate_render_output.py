"""Offline CPU/Qt validation of the current worker-side output path.

Run from each source snapshot with its prepared assets to compare reports.
No Engine, GPU model, node or network is started. Reports contain metrics/hashes
only, not images, paths or private text.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import hashlib
from io import BytesIO
import json
import multiprocessing
import os
from pathlib import Path
import platform
import socket
import statistics
import struct
import threading
from time import perf_counter

import numpy as np
from PIL import Image, ImageDraw
import psutil

from classic_node.protocol import digest, mask_image
from classic_node.timing import collect

TEXTS = {'en': 'THIS PERSON COULD WIELD MAGIC TO CONTROL ALL THINGS.',
         'zh-Hans': '这个人能够运用魔法，控制世间的一切事物。',
         'ja': 'この人は魔法を使って、すべてのものを操ることができた。',
         'ar': 'كان هذا الشخص قادرًا على تسخير السحر للتحكم في كل شيء.'}
CASES = {'sparse': (720, 12000, 3), 'many': (720, 12000, 12),
         'alpha': (720, 1200, 3), 'original': (720, 1200, 0),
         'tiles': (720, 20000, 3)}


def initialize_worker(ready, models, fonts, threads, barrier, cpu_slots):
    # Windows asyncio's local wakeup socket is not a network request.
    connect = socket.socket.connect
    def local_only(sock, address):
        if isinstance(address, tuple) and address[0] not in ('127.0.0.1', '::1'):
            raise RuntimeError('External network disabled in render validation')
        return connect(sock, address)
    socket.socket.connect = local_only
    from classic_node import render_pool as module
    module._initialize(models, fonts, threads, barrier, cpu_slots)
    import cv2
    import torch
    ready.put({'pid': os.getpid(), 'cuda_initialized': torch.cuda.is_initialized(),
               'torch_threads': torch.get_num_threads(), 'cv_threads': cv2.getNumThreads()})


def worker_finished():
    from classic_node import render_pool as module
    module._ready()  # One final state probe per persistent worker, not per task.
    import torch
    return {'pid': os.getpid(), 'cuda_initialized': torch.cuda.is_initialized()}


def synthetic(name, language):
    width, height, count = CASES[name]
    original = np.full((height, width, 3), 255, np.uint8)
    mask = Image.new('L', (width, height))
    draw, regions = ImageDraw.Draw(mask), []
    for top in np.linspace(40, height - 380, count, dtype=int):
        top = int(top)
        draw.ellipse((75, top + 15, 645, top + 355), fill=255)
        regions.append({'lines': [[[170, top + 100], [550, top + 100],
                                   [550, top + 250], [170, top + 250]]],
                        'texts': ['source'], 'font_size': 48, 'angle': 0,
                        'fg_color': [0, 0, 0], 'bg_color': [255, 255, 255],
                        'direction': 'h', 'prob': 1, 'default_stroke_width': .1,
                        'adjust_bg_color': False, 'line_spacing': 1, 'letter_spacing': 1})
    alpha = None
    if name == 'alpha':
        alpha = np.full((height, width), 128, np.uint8)
        alpha[:, :width // 2] = 0
        alpha[:, 2 * width // 3:] = 255
    return make_case(name, original, original.copy(), regions, language, np.array(mask), alpha)


def make_case(name, original, cleaned, regions, language, mask, alpha, input_hash=None):
    analysis = {'input_hash': input_hash or hashlib.sha256(original.tobytes()).hexdigest()}
    translations = [TEXTS[language]] * len(regions)
    translated = {'analysis_hash': digest(regions), 'revision': digest(translations)}
    return {'name': name, 'args': (original, cleaned, regions, translations, language, mask),
            'kwargs': {'alpha': alpha, 'version': 'render-output-validation', 'analysis': analysis,
                       'translated': translated, 'allow_tiles': True}}


def private_case(entry, directory, index, language):
    """Read an explicit local manifest; no image discovery or source fetches."""
    def path(key):
        return (directory / entry[key]).resolve()
    with Image.open(path('original')) as image:
        original = np.array(image.convert('RGB'))
        alpha = (np.array(image.convert('RGBA').getchannel('A'))
                 if 'A' in image.getbands() or 'transparency' in image.info else None)
    with Image.open(path('cleaned')) as image:
        cleaned = np.array(image.convert('RGB'))
    if cleaned.shape != original.shape:
        raise ValueError('Original and cleaned dimensions differ')
    analysis = json.loads(path('analysis').read_text(encoding='utf-8'))
    height, width = original.shape[:2]
    if analysis.get('bubble_mask'):
        with mask_image(analysis['bubble_mask'], (width, height), allow_empty=True) as image:
            mask = np.array(image)
    else:
        mask = np.zeros((height, width), np.uint8)
    return make_case(f'private-{index}', original, cleaned, analysis['regions'], language, mask, alpha,
                     analysis.get('input_hash'))


def reconstruct(packed, original, alpha):
    """Decode both wire representations and preserve the source alpha exactly."""
    rgb = original.copy()
    result, data = packed['result'], packed['output_bytes']
    patches = []
    if result['representation'] == 'overlay-v1':
        patches.append((result['bbox'], data))
    elif result['representation'] == 'overlay-tiles-v1':
        if data[:8] != b'NCOT0001':
            raise AssertionError('Invalid tiles header')
        length, = struct.unpack('<I', data[8:12])
        manifest = json.loads(data[12:12 + length])
        offset = 12 + length
        for tile in manifest['tiles']:
            body = data[offset:offset + tile['byte_size']]
            assert hashlib.sha256(body).hexdigest() == tile['sha256']
            patches.append((tile, body))
            offset += tile['byte_size']
        assert offset == len(data)
    elif result['representation'] != 'original' or data is not None:
        raise AssertionError('Unknown output representation')
    for box, body in patches:
        with Image.open(BytesIO(body)) as image:
            patch = np.array(image.convert('RGBA'))
        selected = patch[..., 3] == 255
        assert np.all((patch[..., 3] == 0) | selected)
        y, x, h, w = box['y'], box['x'], box['height'], box['width']
        if alpha is not None:
            selected &= alpha[y:y + h, x:x + w] > 0
        rgb[y:y + h, x:x + w][selected] = patch[..., :3][selected]
    return np.dstack((rgb, alpha)) if alpha is not None else rgb


def fingerprint(packed, case):
    pixels = reconstruct(packed, case['args'][0], case['kwargs']['alpha'])
    return {'metadata_sha256': digest(packed['result']),
            'output_sha256': hashlib.sha256(packed['output_bytes'] or b'').hexdigest(),
            'pixel_sha256': hashlib.sha256(pixels.tobytes()).hexdigest(),
            'representation': packed['result']['representation'],
            'output_bytes': len(packed['output_bytes'] or b'')}


def sample_processes(processes=None):
    if processes is None:
        root = psutil.Process()
        processes = [root, *root.children(recursive=True)]
    result = {}
    for process in processes:
        try:
            result[process.pid] = (sum(process.cpu_times()[:2]), process.memory_info().rss)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return result


def measured(operation):
    stop, peak = threading.Event(), {'parent': 0, 'children': 0, 'sum': 0}
    root = psutil.Process()
    processes = [root, *root.children(recursive=True)]
    def sample():
        values = sample_processes(processes)
        parent = values.get(os.getpid(), (0, 0))[1]
        children = sum(row[1] for pid, row in values.items() if pid != os.getpid())
        for key, value in (('parent', parent), ('children', children), ('sum', parent + children)):
            peak[key] = max(peak[key], value)
    def monitor():
        while not stop.wait(.02):
            sample()
    sample()
    before = sample_processes(processes)
    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    started = perf_counter()
    try:
        output = operation()
        wall = perf_counter() - started
    finally:
        stop.set()
        watcher.join()
    after = sample_processes(processes)
    sample()
    cpu = {pid: value[0] - before.get(pid, value)[0] for pid, value in after.items()}
    return output, {'wall_seconds': wall, 'parent_cpu_seconds': cpu.get(os.getpid(), 0),
                    'children_cpu_seconds': sum(value for pid, value in cpu.items() if pid != os.getpid()),
                    'peak_rss_bytes': peak}


class SharedTracker:
    """Observe only allocations created by the selected local pool."""
    def __init__(self, module):
        self.module, self.lock = module, threading.Lock()
        self.create, self.dispose = module.SharedMemory, module._dispose
        self.live, self.peak, self.cleaned = {}, 0, 0

    def open(self, *args, **kwargs):
        segment = self.create(*args, **kwargs)
        if kwargs.get('create'):
            with self.lock:
                self.live[segment.name] = segment.size
                self.peak = max(self.peak, sum(self.live.values()))
        return segment

    def close(self, segment):
        name = segment.name
        self.dispose(segment)
        try:
            remaining = self.create(name=name)
        except FileNotFoundError:
            pass
        else:
            remaining.close()
            raise AssertionError('Shared segment remains after disposal')
        with self.lock:
            del self.live[name]
            self.cleaned += 1

    def __enter__(self):
        self.module.SharedMemory, self.module._dispose = self.open, self.close
        return self

    def __exit__(self, *_):
        self.module.SharedMemory, self.module._dispose = self.create, self.dispose
        assert not self.live, 'Shared segments remain live'


def run_pool(args, fonts, case_sources):
    from classic_node import render_pool as module
    ready = multiprocessing.get_context('spawn').Queue()
    initialize = module._initialize
    module._initialize = partial(initialize_worker, ready)
    pool = module.RenderPool(args.models, fonts, args.workers, args.threads)
    rows = []
    started = perf_counter()
    try:
        pool.warmup()
        states = [ready.get(timeout=30) for _ in range(args.workers)]
        assert len({state['pid'] for state in states}) == args.workers
        assert all(not state['cuda_initialized'] and state['cv_threads'] == state['torch_threads'] == args.threads
                   for state in states)
        startup = perf_counter() - started
        with SharedTracker(module) as tracker, ThreadPoolExecutor(args.workers) as callers:
            for case_source in case_sources:
                case = case_source()
                height, width = case['args'][0].shape[:2]
                allocation = module.ipc_bytes(width, height) * args.workers
                if allocation > args.max_shared_mib * 2**20:
                    raise ValueError('Case exceeds the configured shared-memory test limit')
                inputs = [*case['args'][:2], case['args'][5]]
                if case['kwargs']['alpha'] is not None:
                    inputs.append(case['kwargs']['alpha'])
                input_hashes = [hashlib.sha256(value.tobytes()).hexdigest() for value in inputs]
                def render_one(_):
                    begin = perf_counter()
                    with collect() as timings:
                        packed = pool.render(*case['args'], **case['kwargs'], mask_cache_bytes=args.mask_cache_bytes)
                    return packed, perf_counter() - begin, timings
                # Prime this shape with one concurrent call per worker.
                warm = list(callers.map(render_one, range(args.workers)))
                actual = fingerprint(warm[0][0], case)
                for repeat in range(args.rounds):
                    tracker.peak = 0
                    outputs, metrics = measured(lambda: list(callers.map(render_one, range(args.pages))))
                    # Decoding/comparison is deliberately outside the timed boundary.
                    # Every warmed worker must produce stable pixels, bytes and metadata.
                    assert all(fingerprint(item[0], case) == actual for item in outputs)
                    latencies = [item[1] for item in outputs]
                    assert not tracker.live
                    rows.append({'case': case['name'], 'repeat': repeat, 'pages': args.pages,
                                 'width': width, 'height': height, 'regions': len(case['args'][2]),
                                 **metrics, 'page_service_seconds': latencies,
                                 'page_service_p95_seconds': float(np.percentile(latencies, 95)),
                                 'pages_per_second': args.pages / metrics['wall_seconds'],
                                 'stage_timings': [item[2] for item in outputs],
                                 'peak_shared_bytes': tracker.peak, 'shared_segments_cleaned': tracker.cleaned,
                                 'pixel_bytes_metadata_identical': True, **actual})
                    print(json.dumps({'case': case['name'], 'repeat': repeat,
                                      'wall_seconds': metrics['wall_seconds']}), flush=True)
                assert input_hashes == [hashlib.sha256(value.tobytes()).hexdigest() for value in inputs]
                del warm, outputs, case, inputs
        futures = [pool._get_pool().submit(worker_finished) for _ in range(args.workers)]
        final_states = [future.result(timeout=30) for future in futures]
        assert {state['pid'] for state in final_states} == {state['pid'] for state in states}
        assert all(not state['cuda_initialized'] for state in final_states)
        return {'startup_seconds': startup, 'workers': states, 'rows': rows,
                'workers_after_render': final_states, 'shared_segments_remaining': 0}
    finally:
        pool.close()
        module._initialize = initialize
        ready.close()
        ready.join_thread()


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument('--models', type=Path, default=Path('.assets/models'))
    value.add_argument('--output', type=Path, required=True)
    value.add_argument('--workers', type=int, default=2)
    value.add_argument('--threads', type=int, default=1)
    value.add_argument('--pages', type=int, default=4)
    value.add_argument('--rounds', type=int, default=3)
    value.add_argument('--case', action='append', choices=CASES)
    value.add_argument('--language', choices=TEXTS, default='en')
    value.add_argument('--samples', type=Path, help='Private JSON list of original/cleaned/analysis local paths')
    value.add_argument('--mask-cache-bytes', type=int)
    value.add_argument('--max-shared-mib', type=int, default=1024)
    return value


def main(argv=None):
    args = parser().parse_args(argv)
    if min(args.workers, args.threads, args.pages, args.rounds, args.max_shared_mib) < 1:
        raise ValueError('Workers, threads, pages, rounds and memory limit must be positive')
    if args.mask_cache_bytes is not None and args.mask_cache_bytes < 0:
        raise ValueError('Mask cache must be nonnegative')
    args.models = args.models.resolve()
    os.environ.update(CUDA_VISIBLE_DEVICES='', HF_HUB_OFFLINE='1', QT_QPA_PLATFORM='offscreen')
    from mtu_engine.assets import verify, file_hash
    verify(args.models)
    font_data = json.loads((args.models.parent / 'licenses/font-sources.json').read_text(encoding='utf-8'))
    fonts = [str(args.models.parent / 'fonts' / font['name']) for font in font_data['fonts']]
    sources = [partial(synthetic, name, args.language) for name in (args.case or CASES)]
    if args.samples:
        entries = json.loads(args.samples.read_text(encoding='utf-8'))
        sources.extend(partial(private_case, entry, args.samples.resolve().parent, index, args.language)
                       for index, entry in enumerate(entries))
    report = {'scope': 'Local CPU Qt only; fixed synthetic text; no Engine, GPU, network, OCR or inpainting',
              'timed_boundary': 'Warm pool; allocate/copy inputs, Qt, pack, IPC return, cleanup; excludes verification decode',
              'rss_note': 'Diagnostic parent+children RSS sum can double-count shared pages; not production incremental memory',
              'case_note': 'Original case has no regions and skips Renderer but still uses pool IPC and diff. Not the node no-work fast path.',
              'cpu_note': 'Parent CPU includes the same 20ms RSS sampling overhead; page p95 is service time, excluding caller queue.',
              'python': platform.python_version(), 'platform': platform.platform(),
              'numpy': np.__version__, 'pillow': Image.__version__, 'workers': args.workers, 'threads': args.threads,
              'language': args.language, 'mask_cache_bytes': args.mask_cache_bytes,
              'source_sha256': {name: file_hash(Path(__file__).resolve().parents[1] / 'classic_node' / name)
                               for name in ('render_pool.py', 'protocol.py')},
              'run': run_pool(args, fonts, sources)}
    report['summary'] = {}
    for name in dict.fromkeys(row['case'] for row in report['run']['rows']):
        report['summary'][name] = {'wall_median_seconds': statistics.median(
            row['wall_seconds'] for row in report['run']['rows'] if row['case'] == name)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=True) + '\n', encoding='utf-8')
    print(json.dumps(report['summary']), flush=True)


if __name__ == '__main__':
    main()
