"""Isolated current-baseline/portable-acceleration comparison, without paid calls.

Uses the normal device lock. Outputs contain hashes/metrics, never OCR text.
Image artifacts stay in the requested private directory. Profiling is separate
from normal timing; CUDA events measure stream intervals, not pure kernel sums.
"""
import argparse
import asyncio
from contextlib import redirect_stdout, redirect_stderr
import cProfile
import functools
import hashlib
import inspect
import json
import os
from pathlib import Path
import socket
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'services/classic-engine'), str(ROOT / 'engines/mit-native')]


async def main(args):
    folder = args.directory.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    config = {'profile': 'mit', 'device': args.device, 'resource_id': socket.gethostname() + ':' + args.device,
        'model_dir': str(ROOT / 'engines/mit-models'), 'font': str(ROOT / 'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'),
        'lock_dir': str(ROOT / 'engines/device-locks'), 'inpaint_workers': 1,
        'neural_acceleration': args.service_mode,
        'runtime': {'languages': ['zh-Hans'], 'torch_threads': args.torch_threads, 'opencv_threads': args.opencv_threads}}
    (folder / 'engine.json').write_text(json.dumps(config), encoding='utf-8')
    os.environ['ENGINE_CONFIG_FILE'] = str(folder / 'engine.json')
    import numpy as np
    import torch
    from PIL import Image
    import server
    from neural_acceleration import NeuralAcceleration
    from benchmark_amd import stats, write_json

    images = [np.array(Image.open(path).convert('RGB')) for path in args.image]
    stage_config = {'detection_size': 1536, 'reading_order': 'rtl', 'mask_dilation': 3,
        'inpainting_strategy': 'masked-crops-v1', 'inpainting_size': 512,
        'inpainting_padding': 48, 'inpainting_merge_gap': 24, 'font_minimum': 10}
    references = {}
    active = None
    events = None
    report = {'device': args.device, 'torch': torch.__version__, 'config': config,
              'inputs': [hashlib.sha256(im.tobytes()).hexdigest() for im in images], 'phases': []}

    def timed(function, label):
        def record(start):
            if active is not None:
                active[label] = active.get(label, 0) + time.perf_counter() - start
        if inspect.iscoroutinefunction(function):
            @functools.wraps(function)
            async def invoke(*a, **kw):
                start = time.perf_counter()
                try:
                    return await function(*a, **kw)
                finally:
                    record(start)
        else:
            @functools.wraps(function)
            def invoke(*a, **kw):
                start = time.perf_counter()
                try:
                    return function(*a, **kw)
                finally:
                    record(start)
        return invoke

    def gpu_timed(function, label):
        @functools.wraps(function)
        def invoke(*a, **kw):
            if events is None or not args.device.startswith('cuda'):
                return function(*a, **kw)
            start, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
            start.record()
            try:
                return function(*a, **kw)
            finally:
                end.record()
                events.append((label, start, end))
        return invoke

    def difference(a, b):
        delta = np.abs(a.astype(np.int16) - b.astype(np.int16))
        return {'changed_pixels': int(np.count_nonzero(np.any(delta, axis=2))) if delta.ndim == 3 else int(np.count_nonzero(delta)),
                'max_channel_difference': int(delta.max()), 'mean_absolute_difference': float(delta.mean())}

    async def page(index, artifact=None, profile=False):
        nonlocal active, events
        image = images[index]
        active, events = {}, [] if profile else None
        if args.device.startswith('cuda'):
            torch.cuda.synchronize()
        started = time.perf_counter()
        with open(os.devnull, 'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
            analysis = await server.analyze(image, stage_config)
            if analysis['segments']:
                erased = await server.erase_page(image, analysis, stage_config, encode=False)
                rendered = await server.render_page(image, analysis,
                    {s['id']: '故事' for s in analysis['segments']}, stage_config, 'zh-Hans', erased['cleaned'], encode=False)
            else:
                erased = {'cleaned': image.copy()}
                rendered = {'image': image.copy(), 'layout': []}
        if args.device.startswith('cuda'):
            torch.cuda.synchronize()
        active['total'] = time.perf_counter() - started
        if events is not None:
            for label, start, end in events:
                active[label + '_stream_seconds'] = active.get(label + '_stream_seconds', 0) + start.elapsed_time(end) / 1000
        result = {k:v for k,v in analysis.items() if k != 'timings'}
        row = {'seconds': active, 'analysis_sha256': hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()}
        active, events = None, None
        mask = server.decode(analysis['mask'], 'L') if analysis['mask'] else np.zeros(image.shape[:2], np.uint8)
        assert np.array_equal(image[mask == 0], erased['cleaned'][mask == 0]), 'Unmasked pixels changed'
        current = (result, mask, erased['cleaned'], rendered['image'], rendered['layout'])
        if index not in references:
            references[index] = current
        before = references[index]
        row['quality'] = {'same_text': before[0]['segments'] == result['segments'],
            'same_region_geometry': [r['lines'] for r in before[0]['regions']] == [r['lines'] for r in result['regions']],
            'same_colors': [(r['fg_color'], r['bg_color']) for r in before[0]['regions']] == [(r['fg_color'], r['bg_color']) for r in result['regions']],
            'same_layout': before[4] == rendered['layout'],
            'mask': difference(before[1], mask), 'inpaint': difference(before[2], erased['cleaned']),
            'final': difference(before[3], rendered['image'])}
        if len(before[0]['regions']) == len(result['regions']):
            row['quality']['max_confidence_difference'] = max((abs(a['prob'] - b['prob']) for a,b in zip(before[0]['regions'], result['regions'])), default=0)
        if artifact:
            Image.fromarray(erased['cleaned']).save(folder / (artifact + '-inpaint.png'))
            Image.fromarray(rendered['image']).save(folder / (artifact + '-final.png'))
            Image.fromarray(np.abs(before[3].astype(np.int16) - rendered['image'].astype(np.int16)).clip(0, 255).astype(np.uint8)).save(folder / (artifact + '-diff.png'))
        return row

    async with server.lifespan(server.app):
        report['health_at_startup'] = server.health()
        for name in ('analyze', 'erase_page', 'render_page', 'merge', 'refine', 'png'):
            setattr(server, name, timed(getattr(server, name), name))
        for label, method in [('detector', 'detect'), ('ocr', 'recognize'), ('inpainter', 'inpaint')]:
            obj = server.models[label]
            setattr(obj, method, timed(getattr(obj, method), label))
        measured_modules = [('detector', server.models['detector'].model),
                              ('ocr_backbone', server.models['ocr'].model.backbone),
                              ('ocr_encoder', server.models['ocr'].model.encoders),
                              ('ocr_decoder', server.models['ocr'].model.decoders),
                              ('lama', server.models['inpainter'].model.generator)]
        async with server.lock.hold():
            phases = ['baseline', 'selected', 'baseline-repeat'] if args.service_mode == 'eager' else ['service']
            for name in phases:
                setup_started = time.perf_counter()
                acceleration = NeuralAcceleration(server.models) if name == 'selected' else None
                setup_seconds = time.perf_counter() - setup_started
                measured_originals = [(module, module.forward) for _, module in measured_modules]
                for label, module in measured_modules:
                    module.forward = gpu_timed(module.forward, label)
                try:
                    warmups = [await page(i) for i in range(len(images))]
                    if args.device.startswith('cuda'):
                        torch.cuda.reset_peak_memory_stats()
                    rows = [dict(await page(i, f'{name}-{i}' if n == 0 else None), image=i)
                            for n in range(args.repeat) for i in range(len(images))]
                    runtime = acceleration or server.neural_runtime
                    phase = {'name': name, 'acceleration': runtime.describe() if runtime else None,
                        'setup_seconds': setup_seconds,
                        'warmup_seconds': [r['seconds']['total'] for r in warmups],
                        'timings': {k: stats([row['seconds'].get(k, 0) for row in rows])
                                    for k in sorted({key for row in rows for key in row['seconds']})},
                        'pages': rows}
                    if args.device.startswith('cuda'):
                        phase['peak_cuda_allocated_bytes'] = torch.cuda.max_memory_allocated()
                        phase['peak_cuda_reserved_bytes'] = torch.cuda.max_memory_reserved()
                    if args.profile:
                        profiler = cProfile.Profile()
                        profiler.enable()
                        phase['profile_page'] = await page(0, profile=True)
                        profiler.disable()
                        profiler.dump_stats(str(folder / (name + '.pstats')))
                    report['phases'].append(phase)
                    write_json(folder / 'report.json', report)
                    print(json.dumps({'phase': name, 'timings': {k:v['mean'] for k,v in phase['timings'].items()},
                                      'quality': rows[0]['quality'], 'acceleration': phase['acceleration']}), flush=True)
                finally:
                    for module, original in measured_originals:
                        module.forward = original
                    if acceleration:
                        acceleration.close()
        if args.service_mode != 'eager' and references[0][0]['segments']:
            import httpx
            import secrets
            os.environ['ENGINE_TOKEN'] = secrets.token_urlsafe(32)
            transport = httpx.ASGITransport(app=server.app)
            async with httpx.AsyncClient(transport=transport, base_url='http://engine.test') as client:
                headers = {'Authorization': 'Bearer ' + os.environ['ENGINE_TOKEN']}
                body = {'image': server.png(images[0]), 'scope': 'isolated-neural-smoke',
                        'config': {**stage_config, 'version': server.VERSION}, 'language': 'zh-Hans'}
                denied = await client.post('/v1/analyze', json=body)
                assert denied.status_code == 401
                stale = await client.post('/v1/analyze', headers=headers,
                    json={**body, 'config': {**body['config'], 'version': 'wrong-version'}})
                assert stale.status_code == 409
                analyzed = await client.post('/v1/analyze', headers=headers, json=body)
                assert analyzed.status_code == 200
                body['analysis'] = analyzed.json()
                erased = await client.post('/v1/inpaint', headers=headers, json=body)
                assert erased.status_code == 200
                body['cache_key'] = erased.json()['cache_key']
                body['translations'] = {s['id']: '故事' for s in body['analysis']['segments']}
                rendered = await client.post('/v1/render', headers=headers, json=body)
                assert rendered.status_code == 200
                result = rendered.json()
                assert result['cache_rebuilt'] is False
                assert np.array_equal(server.decode(result['image']), references[0][3])
                report['asgi_contract'] = {'transport': 'in-process ASGI, not socket/network',
                    'unauthorized': 401, 'stale_version': 409, 'analyze': 200, 'inpaint': 200, 'render': 200,
                    'reused_stage_cache': True, 'same_image_as_direct_call': True}
        report['health_after_pages'] = server.health()
        write_json(folder / 'report.json', report)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', choices=['cpu', 'cuda:0'], default='cuda:0')
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--image', type=Path, action='append')
    parser.add_argument('--repeat', type=int, default=3)
    parser.add_argument('--torch-threads', type=int, default=4)
    parser.add_argument('--opencv-threads', type=int, default=2)
    parser.add_argument('--service-mode', choices=['eager', 'portable-v1'], default='eager')
    parser.add_argument('--profile', action='store_true')
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error('Positive repeat required')
    args.image = args.image or [ROOT / 'samples/starlight-bookshop.png']
    asyncio.run(main(args))
