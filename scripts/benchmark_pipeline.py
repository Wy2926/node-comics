"""Real stage overlap/parity check; local ASGI only, no LLM, R2 or controller.

Compare a single in-flight page with two/three pages on ONE model instance.
References use the original sequential function entry points and fixed text.
Reports contain timings and hashes only; images remain in the private directory.
"""
import argparse
import asyncio
from contextlib import redirect_stdout, redirect_stderr
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'services/classic-engine'), str(ROOT / 'engines/mit-native')]


async def main(args):
    folder = args.directory.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    settings = {'resource_id': socket.gethostname() + ':' + args.device, 'device': args.device,
        'model_dir': str(ROOT / 'engines/mit-models'), 'font': str(ROOT / 'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'),
        'lock_dir': str(ROOT / 'engines/device-locks'), 'neural_acceleration': args.neural,
        'runtime': {'languages': ['zh-Hans'], 'torch_threads': 4, 'opencv_threads': args.opencv_threads}}
    config_path = folder / 'engine.json'
    config_path.write_text(json.dumps(settings), encoding='utf-8')
    os.environ['ENGINE_CONFIG_FILE'] = str(config_path)
    os.environ['ENGINE_TOKEN'] = secrets.token_hex(24)
    import httpx
    import numpy as np
    import torch
    from PIL import Image
    import server
    images = [np.array(Image.open(path).convert('RGB')) for path in args.image]
    images.append(np.full((480, 640, 3), 255, np.uint8))
    config = {'version': server.VERSION, 'detection_size': 1536, 'reading_order': 'rtl', 'mask_dilation': 3,
        'inpainting_strategy': 'masked-crops-v1', 'inpainting_size': 512,
        'inpainting_padding': 48, 'inpainting_merge_gap': 24, 'font_minimum': 10}
    report = {'scope': 'ASGI stage pipeline; no network/LLM/R2', 'settings': settings, 'phases': []}
    references = []

    def digest(image):
        return hashlib.sha256(image.tobytes()).hexdigest()

    def checkpoint(analysis):
        return {key: analysis[key] for key in ('segments', 'regions', 'mask', 'unrecognized_regions', 'quality_flags')
                if key in analysis}

    async with server.lifespan(server.app):
        report['health'] = server.health()
        # Sequential references exercise the same models and original CPU/Qt path.
        async with server.lock.hold():
            for index, image in enumerate(images):
                with open(os.devnull, 'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
                    analysis = await server.analyze(image, config)
                    final, layout = image, []
                    cleaned = image
                    if analysis['segments']:
                        cleaned = (await server.erase_page(image, analysis, config, encode=False))['cleaned']
                        rendered = await server.render_page(image, analysis,
                            {row['id']: '故事' for row in analysis['segments']}, config, 'zh-Hans', cleaned, encode=False)
                        final, layout = rendered['image'], rendered['layout']
                references.append((checkpoint(analysis), cleaned, final, layout))
                Image.fromarray(final).save(folder / f'reference-{index}.png')
        encoded = [server.png(image) for image in images]
        headers = {'Authorization': 'Bearer ' + os.environ['ENGINE_TOKEN']}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url='http://engine') as client:
            assert (await client.post('/v1/analyze', json={})).status_code == 401
            async def page(index, scope, artifact=False):
                started = time.perf_counter()
                body = {'image': encoded[index], 'scope': scope, 'config': config, 'language': 'zh-Hans'}
                response = await client.post('/v1/analyze', headers=headers, json=body)
                response.raise_for_status()
                analysis = response.json()
                assert checkpoint(analysis) == references[index][0], 'Analysis mismatch'
                timings = dict(analysis['timings'])
                if analysis['segments']:
                    body.pop('image')
                    body.update(analysis=checkpoint(analysis), image_ref=analysis['image_ref'], input_hash=analysis['input_hash'])
                    erased = await client.post('/v1/inpaint', headers=headers, json=body)
                    erased.raise_for_status()
                    erased = erased.json()
                    timings.update(erased['timings'])
                    # Verify actual cleaned pixels, not just the final PNG.
                    cleaned = server.cache.get('cleaned:' + erased['cache_key'])
                    assert cleaned is not None and np.array_equal(cleaned, references[index][1]), 'Inpaint mismatch'
                    body.update(cache_key=erased['cache_key'], translations={row['id']: '故事' for row in analysis['segments']})
                    rendered = await client.post('/v1/render', headers=headers, json=body)
                    rendered.raise_for_status()
                    rendered = rendered.json()
                    assert not rendered['cache_rebuilt'], 'Unexpected recovery'
                    assert rendered['layout'] == references[index][3], 'Layout mismatch'
                    final = server.decode(rendered['image'])
                    assert np.array_equal(final, references[index][2]), 'Final pixels mismatch'
                    timings.update(rendered['timings'])
                    if artifact:
                        Image.fromarray(final).save(folder / f'pipeline-{index}.png')
                else:
                    final = images[index]
                return {'input': index, 'seconds': time.perf_counter() - started, 'timings': timings,
                        'output_sha256': digest(final), 'same_pixels': True}

            for index in range(len(images)):
                await page(index, 'warm-' + str(index), True)
            for number, concurrency in enumerate(args.concurrency):
                if args.device.startswith('cuda'):
                    torch.cuda.reset_peak_memory_stats()
                rows = []
                start = time.perf_counter()
                # Equal page counts/mix in every phase; closed-loop clients have
                # no artificial sleeps and retain same-engine cache affinity.
                queue = asyncio.Queue()
                for index in range(args.pages):
                    queue.put_nowait(index)
                async def client_loop():
                    while not queue.empty():
                        index = queue.get_nowait()
                        count = len(images) if args.include_blank else len(images) - 1
                        rows.append(await page(index % count, f'phase-{number}-page-{index}'))
                await asyncio.gather(*(client_loop() for _ in range(concurrency)))
                elapsed = time.perf_counter() - start
                latency = [row['seconds'] for row in rows]
                phase = {'concurrency': concurrency, 'includes_blank': args.include_blank,
                    'pages': len(rows), 'seconds': elapsed,
                    'pages_per_minute': len(rows) * 60 / elapsed, 'mean_seconds': float(np.mean(latency)),
                    'p95_seconds': float(np.percentile(latency, 95)), 'rows': rows}
                if args.device.startswith('cuda'):
                    phase['torch_peak_allocated_bytes'] = torch.cuda.max_memory_allocated()
                    phase['torch_peak_reserved_bytes'] = torch.cuda.max_memory_reserved()
                report['phases'].append(phase)
                (folder / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
                print(json.dumps({key: value for key, value in phase.items() if key != 'rows'}), flush=True)
        report['health_after'] = server.health()
    (folder / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--image', type=Path, action='append')
    parser.add_argument('--device', choices=['cpu', 'cuda:0'], default='cuda:0')
    parser.add_argument('--neural', choices=['eager', 'portable-v1'], default='portable-v1')
    parser.add_argument('--pages', type=int, default=12)
    parser.add_argument('--concurrency', type=int, nargs='+', default=[1, 2, 3, 1])
    parser.add_argument('--opencv-threads', type=int, default=2)
    parser.add_argument('--include-blank', action='store_true', help='Include blank pages in timed throughput, not only parity')
    args = parser.parse_args()
    if args.pages < 1 or any(value < 1 or value > 3 for value in args.concurrency):
        parser.error('Positive page count; concurrency must be 1..3')
    args.image = args.image or [ROOT / 'samples/starlight-bookshop.png']
    asyncio.run(main(args))
