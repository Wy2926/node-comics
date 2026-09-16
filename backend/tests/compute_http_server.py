"""Isolated process entry points for test_compute_http.py; synthetic data only."""
import asyncio
import base64
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import socket
import sys

from fastapi import FastAPI, HTTPException, Request
from PIL import Image
import uvicorn


def png(image):
    output = BytesIO()
    image.save(output, 'PNG')
    return base64.b64encode(output.getvalue()).decode()


def simulated_engine():
    app = FastAPI()
    status = {'calls': [], 'hold': None, 'active': None}
    release = asyncio.Event()
    release.set()
    version = os.environ['CLASSIC_ENGINE_VERSION']
    runtime = {'languages': ['zh-Hans', 'en'], 'torch_threads': 4, 'opencv_threads': 2,
               'cache_bytes': 268435456, 'cache_ttl_seconds': 900}

    @app.get('/health')
    def health():
        return {'ready': True, 'instance_id': str(os.getpid()), 'version': version, 'device': 'simulated-cpu',
                'resource_id': os.environ['ENGINE_RESOURCE_ID'], 'capacity': 1,
                'capabilities': ['analyze', 'inpaint', 'render'], 'runtime': runtime,
                'supported_languages': runtime['languages']}

    @app.post('/internal/config')
    async def configure(request: Request):
        if request.headers.get('authorization') != 'Bearer ' + os.environ['ENGINE_TOKEN']:
            raise HTTPException(401)
        runtime.update(await request.json())
        return {'runtime': runtime, 'supported_languages': runtime['languages']}

    @app.get('/test/state')
    def state():
        return status

    @app.post('/test/hold/{stage}')
    def hold(stage: str):
        status['hold'] = stage
        release.clear()
        return {'held': stage}

    @app.post('/test/release')
    def unhold():
        status['hold'] = None
        release.set()
        return {'released': True}

    @app.post('/v1/{stage}')
    async def execute(stage: str, request: Request):
        if request.headers.get('authorization') != 'Bearer ' + os.environ['ENGINE_TOKEN']:
            raise HTTPException(401)
        body = await request.json()
        if body['config']['version'] != version:
            raise HTTPException(409)
        if stage not in {'analyze', 'inpaint', 'render'}:
            raise HTTPException(404)
        status['active'] = stage
        status['calls'].append({'stage': stage, 'scope': body['scope'],
                                'has_analysis': bool(body.get('analysis')), 'has_translations': bool(body.get('translations'))})
        if status['hold'] == stage:
            await release.wait()
        await asyncio.sleep(.15)  # Both real agents have an observable execution window.
        data = base64.b64decode(body['image'], validate=True)
        image = Image.open(BytesIO(data)).convert('RGB')
        mask = Image.new('L', image.size, 0)
        mask.putpixel((10, 10), 255)
        common = {'version': version, 'width': image.width, 'height': image.height,
                  'input_hash': hashlib.sha256(data).hexdigest(), 'timings': {stage: .15}}
        if stage == 'analyze':
            result = {'segments': [{'id': 'b001', 'source': 'HELLO'}],
                      'regions': [{'lines': [[[8, 8], [20, 8], [20, 20], [8, 20]]]}], 'mask': png(mask)}
        elif stage == 'inpaint':
            result = {'cache_key': hashlib.sha256((body['scope'] + os.environ['ENGINE_RESOURCE_ID']).encode()).hexdigest(), 'cached': True}
        else:
            assert body['translations'] == {'b001': '你好'}
            assert body['analysis']['segments'][0]['id'] == 'b001'
            image.putpixel((10, 10), (0, 0, 0))
            result = {'image': png(image), 'mask': png(mask), 'glyph_mask': png(mask), 'cache_rebuilt': True}
        status['active'] = None
        return {**common, **result}

    return app


def serve(app, ready_path):
    """Reserve port zero in the serving process and never release it before use."""
    destination = Path(ready_path)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]

        class ReadyServer(uvicorn.Server):
            async def startup(self, sockets=None):
                await super().startup(sockets=sockets)
                if self.started:
                    temporary = destination.with_suffix('.tmp')
                    temporary.write_text(str(port), encoding='ascii')
                    temporary.replace(destination)

        server = ReadyServer(uvicorn.Config(app, host='127.0.0.1', port=port,
                                           log_level='warning', access_log=False))
        server.run(sockets=[listener])


def run():
    role = sys.argv[1]
    if role == 'engine':
        serve(simulated_engine(), sys.argv[2])
        return
    if role == 'api':
        from app.main import app
        from app.db import initialize, session_factory
        from translation_fixtures import configure_text_provider
        initialize()
        with session_factory()() as db:
            configure_text_provider(db)
        serve(app, sys.argv[2])
        return
    if role == 'worker':
        from app import classic, workers
        from app.adapters.text import TextResponse
        def simulated_text(segments, language, profile):
            if os.environ.get('TEST_TEXT_GATE'):
                import time
                from pathlib import Path
                deadline = time.monotonic() + 45
                while not Path(os.environ['TEST_TEXT_GATE']).exists():
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Isolated text gate timed out')
                    time.sleep(.05)
            return TextResponse(json.dumps({'translations': [{'id': segment['id'], 'text': '你好'} for segment in segments]}),
                                {'input_tokens': 100, 'output_tokens': 10}, 'isolated-http-text')
        def forbidden(*args, **kwargs):
            raise AssertionError('Paid image provider calls are forbidden in this isolated test')
        classic.call_text = simulated_text
        workers.redraw = forbidden
        workers.main()
        return
    if role == 'maintenance':
        from app.dispatcher import main
        main()
        return
    raise RuntimeError('Unknown isolated process role')


if __name__ == '__main__':
    run()
