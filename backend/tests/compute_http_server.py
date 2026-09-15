"""Isolated process entry points for test_compute_http.py; synthetic data only."""
import asyncio
import base64
import hashlib
from io import BytesIO
import json
import os
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

    @app.get('/health')
    def health():
        return {'ready': True, 'version': version, 'device': 'simulated-cpu',
                'resource_id': os.environ['ENGINE_RESOURCE_ID'], 'capacity': 1,
                'capabilities': ['analyze', 'inpaint', 'render']}

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


def run():
    role = sys.argv[1]
    if role == 'engine':
        uvicorn.run(simulated_engine(), host='127.0.0.1', port=int(sys.argv[2]), log_level='warning', access_log=False)
        return
    if role == 'api':
        from app.main import app
        uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[2]), log_level='warning', access_log=False)
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
