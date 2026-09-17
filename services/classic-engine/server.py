"""Private stage service. No LLM credentials, task database or public ports."""
import base64
from contextlib import asynccontextmanager, redirect_stdout, redirect_stderr
import hashlib
import hmac
from io import BytesIO
import json
import logging
import os
import secrets
from pathlib import Path
import time

from engine_config import RuntimeConfig, load
LOCAL_RUNTIME, INTEROP_THREADS = load()
effective_runtime = LOCAL_RUNTIME

import cv2
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
import numpy as np
from PIL import Image
from pydantic import ValidationError
import torch
from manga_translator.config import OcrConfig, InpainterConfig
from manga_translator.detection.default import DefaultDetector
from manga_translator.ocr.model_48px import Model48pxOCR
from manga_translator.inpainting.inpainting_lama_mpe import LamaLargeInpainter
from manga_translator.textline_merge import dispatch as merge
from manga_translator.mask_refinement import dispatch as refine
from manga_translator.utils import ModelWrapper, sort_regions
from local_inpainting import inpaint_regions
from runtime import DeviceLock, ImageCache, cache_key
from hyphenation import DictionaryStore
from typesetter import initialize as initialize_typesetter
from prepare_dictionaries import prepare as prepare_languages

PROFILE = os.environ.get('ENGINE_PROFILE', 'mit')
DIRECTML_OPTIMIZED = PROFILE == 'mit-directml' and os.environ.get('ENGINE_DIRECTML_OPTIMIZED', '1') == '1'
INPAINT_WORKERS = int(os.environ.get('ENGINE_INPAINT_WORKERS', '2')) if DIRECTML_OPTIMIZED else 1
if INPAINT_WORKERS not in (1, 2):
    raise ValueError('ENGINE_INPAINT_WORKERS must be 1 or 2')
AMD_VERSION = 'mit-95227a2-classic-v4-dml-v8-qt-roi' if INPAINT_WORKERS == 2 else ('mit-95227a2-classic-v4-dml-v3-qt-roi' if DIRECTML_OPTIMIZED else 'mit-95227a2-classic-v4-dml-v1-qt-roi')
VERSION = os.environ.get('ENGINE_VERSION', AMD_VERSION if PROFILE == 'mit-directml' else 'mit-95227a2-classic-v9-qt-roi')
DEVICE = os.environ.get('ENGINE_DEVICE', 'cpu')
if DEVICE == 'cuda':
    DEVICE = 'cuda:0'
RESOURCE_ID = os.environ.get('ENGINE_RESOURCE_ID', DEVICE)
FONT = os.environ.get('ENGINE_FONT', '/opt/mit/fonts/NotoSansMonoCJK-VF.ttf.ttc')
from render_languages import prepare_fonts, font_for
from lettering import LetteringError, letter_page
Image.MAX_IMAGE_PIXELS = 24_000_000
lock = DeviceLock(RESOURCE_ID, os.environ.get('ENGINE_LOCK_DIR', '/tmp/comics-device-locks'))
cache = ImageCache(LOCAL_RUNTIME.cache_bytes, LOCAL_RUNTIME.cache_ttl_seconds)
MAX_CHECKPOINT = 4 * 1024 * 1024
MAX_RESPONSE = 96 * 1024 * 1024
models = {}
ready = False
INSTANCE_ID = secrets.token_hex(16)
device_evidence = None
panel_worker = None
inpaint_pool = None
dictionary_store = None


@asynccontextmanager
async def lifespan(app):
    global ready, device_evidence, panel_worker, inpaint_pool, dictionary_store
    logging.disable(logging.CRITICAL)  # Upstream OCR log messages include dialogue.
    torch.set_num_threads(LOCAL_RUNTIME.torch_threads)
    torch.set_num_interop_threads(INTEROP_THREADS)
    cv2.setNumThreads(LOCAL_RUNTIME.opencv_threads)
    ModelWrapper._MODEL_DIR = os.environ.get('MODEL_DIR', '/models')
    from hyphenation import default_directory
    prepare_fonts(LOCAL_RUNTIME.languages)
    prepare_languages(default_directory(), LOCAL_RUNTIME.languages)
    dictionary_store = DictionaryStore(default_directory(), LOCAL_RUNTIME.languages)
    initialize_typesetter(dictionary_store)
    # Fail startup instead of silently moving a requested GPU workload to CPU.
    if PROFILE == 'mit-directml':
        from mit_directml import DirectMLRuntime
        device_evidence = DirectMLRuntime(DEVICE)
    elif PROFILE != 'mit':
        raise RuntimeError('Unknown ENGINE_PROFILE')
    elif DEVICE != 'cpu' and not DEVICE.startswith('cuda'):
        raise RuntimeError('ENGINE_DEVICE must be cpu or cuda[:index]')
    if DEVICE.startswith('cuda'):
        if not torch.cuda.is_available():
            raise RuntimeError('Configured CUDA device is unavailable')
        torch.cuda.set_device(torch.device(DEVICE))
        from cuda_runtime import CudaRuntime
        device_evidence = CudaRuntime(DEVICE)
    async with lock.hold():
        with open(os.devnull, 'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
            models.update(detector=DefaultDetector(), ocr=Model48pxOCR())
            if INPAINT_WORKERS == 1:
                models['inpainter'] = LamaLargeInpainter()
            if device_evidence:
                await device_evidence.load(models)
            else:
                for model in models.values():
                    await model.load(DEVICE)
            # Warm both device pipelines before reporting admission readiness.
            sample = np.full((256, 256, 3), 255, np.uint8)
            await models['detector'].detect(sample, 256, 0.5, 0.7, 2.3, False, False, False, False, False)
            warm_mask = np.zeros((256, 256), np.uint8)
            warm_mask[120:128, 120:128] = 255
            if INPAINT_WORKERS == 1:
                await models['inpainter'].inpaint(sample, warm_mask, InpainterConfig(inpainting_precision='fp32'), 256, False)
    try:
        if INPAINT_WORKERS == 2:
            from parallel_lama import ParallelLama
            async with lock.hold():
                inpaint_pool = ParallelLama(threads=int(os.environ.get('OMP_NUM_THREADS', '4')))
                inpaint_pool.warm()
        if DIRECTML_OPTIMIZED:
            from parallel_panels import ParallelPanels
            panel_worker = ParallelPanels()
            # Spawn/import CPU helper before admitting the first real page.
            panel_worker.submit(sample, True).result()
        ready = True
        yield
    finally:
        ready = False
        if panel_worker:
            panel_worker.close()
            panel_worker = None
        if inpaint_pool:
            if device_evidence and getattr(device_evidence, 'profile_dir', None):
                (device_evidence.profile_dir / 'inpainting-workers.json').write_text(json.dumps(inpaint_pool.evidence(), indent=2), encoding='utf-8')
            inpaint_pool.close()
            inpaint_pool = None
        cache.entries.clear()
        cache.size = 0
        models.clear()
        if device_evidence:
            device_evidence.close()
            device_evidence = None


app = FastAPI(lifespan=lifespan)


def authorized(authorization: str = Header(default='')):
    token = os.environ.get('ENGINE_TOKEN', '')
    if not token or not hmac.compare_digest(authorization, 'Bearer ' + token):
        raise HTTPException(401, 'Engine authentication required')


@app.get('/health')
def health():
    from prepare_typesetter import REVISION as TYPESETTER_REVISION
    return {'ready': ready, 'instance_id': INSTANCE_ID, 'version': VERSION, 'device': DEVICE, 'resource_id': RESOURCE_ID,
            'typesetter': {'name': 'manga-translator-ui', 'revision': TYPESETTER_REVISION, 'backend': 'Qt 6.11.1'},
            'capabilities': ['analyze', 'inpaint', 'render'], 'cache_bytes': cache.size,
            'supported_languages': effective_runtime.languages, 'runtime': effective_runtime.model_dump(),
            'torch_interop_threads': INTEROP_THREADS,
            'inference_serialized': True,
            'cuda': {'available': torch.cuda.is_available(), 'device_name': torch.cuda.get_device_name(DEVICE),
                     'torch_version': torch.__version__} if DEVICE.startswith('cuda') else None,
            'panel_execution': 'parallel-process' if panel_worker else 'serial',
            'input_cache_protocol': 1,
            'hyphenation': dictionary_store.describe() if dictionary_store else None,
            'inpaint_workers': inpaint_pool.evidence() if inpaint_pool else [],
            **({'inference': device_evidence.evidence()} if device_evidence else {})}


@app.post('/internal/config', dependencies=[Depends(authorized)])
async def configure(request: Request):
    global effective_runtime, dictionary_store, cache
    from hyphenation import default_directory, DictionaryStore
    from starlette.concurrency import run_in_threadpool
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 8192:
            raise HTTPException(413)
    try:
        overrides = json.loads(raw)
        updated = RuntimeConfig.model_validate({**LOCAL_RUNTIME.model_dump(), **overrides})
        # Download and verify before taking the execution lock. Failure leaves the
        # previous complete runtime active; no unverified language is advertised.
        await run_in_threadpool(prepare_languages, default_directory(), updated.languages)
        await run_in_threadpool(prepare_fonts, updated.languages)
        store = DictionaryStore(default_directory(), updated.languages)
        async with lock.hold():
            torch.set_num_threads(updated.torch_threads)
            cv2.setNumThreads(updated.opencv_threads)
            if inpaint_pool:
                inpaint_pool.threads = updated.torch_threads
                inpaint_pool.opencv_threads = updated.opencv_threads
            initialize_typesetter(store)
            dictionary_store = store
            if (updated.cache_bytes, updated.cache_ttl_seconds) != (cache.max_bytes, cache.ttl_seconds):
                cache = ImageCache(updated.cache_bytes, updated.cache_ttl_seconds)
            effective_runtime = updated
        return {'runtime': updated.model_dump(), 'supported_languages': updated.languages}
    except ValidationError as error:
        unsupported = any(item['type'] == 'literal_error' and item['loc'][0] == 'languages' for item in error.errors())
        return JSONResponse(status_code=422, content={'error': 'LANGUAGE_UNSUPPORTED' if unsupported else 'ENGINE_CONFIG_FAILED'})
    except Exception:
        return JSONResponse(status_code=422, content={'error': 'ENGINE_CONFIG_FAILED'})


def decode(value, mode='RGB'):
    if not isinstance(value, str) or len(value) > 32 * 1024 * 1024:
        raise ValueError('Image size')
    raw = base64.b64decode(value, validate=True)
    if len(raw) > 24 * 1024 * 1024:
        raise ValueError('Image size')
    with Image.open(BytesIO(raw)) as image:
        if image.width * image.height > 24_000_000 or max(image.size) > 8192 or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('Image dimensions')
        return np.array(image.convert(mode))


def png(array):
    output = BytesIO()
    Image.fromarray(array).save(output, 'PNG')
    return base64.b64encode(output.getvalue()).decode()


def region_json(block):
    return {'lines': block.lines.tolist(), 'texts': block.texts, 'font_size': int(block.font_size),
            'angle': float(block.angle), 'fg_color': [int(v) for v in block.fg_colors],
            'bg_color': [int(v) for v in block.bg_colors], 'prob': float(block.prob)}


async def analyze(image, config):
    future = panel_worker.submit(image, config['reading_order'] == 'rtl') if panel_worker else None
    try:
        return await analyze_regions(image, config, future)
    finally:
        if future is not None:
            # Bound outstanding CPU work even for no-text/error/cancelled pages.
            try:
                future.result()
            except Exception:
                pass


async def analyze_regions(image, config, panel_future=None):
    start = time.monotonic()
    lines, raw_mask, _ = await models['detector'].detect(image, config['detection_size'], 0.5, 0.7, 2.3, False, False, False, False, False)
    if not lines:
        return {'segments': [], 'regions': [], 'mask': None, 'timings': {'detect_ocr': time.monotonic() - start}}
    detected_lines = list(lines)
    lines = await models['ocr'].recognize(image, lines, OcrConfig(prob=0.2), False)
    lines = [line for line in lines if line.text and line.text.strip()]
    # Detection with empty OCR is failure, not a free no-text result.
    if not lines:
        raise ValueError('OCR incomplete')
    recognized = {id(line) for line in lines}
    unrecognized = [line.pts.tolist() for line in detected_lines if id(line) not in recognized]
    regions = await merge(lines, image.shape[1], image.shape[0])
    if panel_future is None:
        regions = sort_regions(regions, right_to_left=config['reading_order'] == 'rtl', img=image)
    else:
        from parallel_panels import sort_with_panels
        regions = sort_with_panels(regions, panel_future, config['reading_order'] == 'rtl')
    if not regions or len(regions) > 200:
        raise ValueError('Region count')
    mask = await refine(regions, image, raw_mask, dilation_offset=config['mask_dilation'], kernel_size=3)
    for polygon in unrecognized:
        cv2.fillConvexPoly(mask, np.array(polygon, dtype=np.int32), 0)
    if not np.any(mask):
        raise ValueError('Empty text mask')
    return {'segments': [{'id': f'b{n:03}', 'source': region.text} for n, region in enumerate(regions, 1)],
            'regions': [region_json(region) for region in regions], 'mask': png(mask), 'unrecognized_regions': unrecognized,
            'quality_flags': ['unrecognized_regions'] if unrecognized else [],
            'timings': {'detect_ocr': time.monotonic() - start}}


async def erase_page(image, analysis, config, *, encode=True):
    mask = decode(analysis['mask'], 'L')
    if mask.shape != image.shape[:2] or not np.any(mask):
        raise ValueError('Mask dimensions')
    start = time.monotonic()
    if config['inpainting_strategy'] != 'masked-crops-v1':
        raise ValueError('Unsupported inpainting strategy')

    async def predict(crop, crop_mask):
        return await models['inpainter'].inpaint(crop, crop_mask, InpainterConfig(inpainting_precision='fp32'), config['inpainting_size'], False)

    if inpaint_pool:
        cleaned = inpaint_pool.inpaint(image, mask, max_size=config['inpainting_size'],
                                       padding=config['inpainting_padding'], merge_gap=config['inpainting_merge_gap'])
    else:
        cleaned = await inpaint_regions(image, mask, predict, max_size=config['inpainting_size'],
                                        padding=config['inpainting_padding'], merge_gap=config['inpainting_merge_gap'])
    # Enforce original pixels outside the erase mask, even if an engine changes them.
    cleaned[mask == 0] = image[mask == 0]
    return {'cleaned': png(cleaned) if encode else cleaned, 'timings': {'inpaint': time.monotonic() - start}}


def encode_render(result):
    start = time.monotonic()
    encoded = {**result, 'image': png(result['image']), 'glyph_mask': png(result['glyph_mask'])}
    elapsed = time.monotonic() - start
    encoded['timings'] = {**result['timings'], 'render_encode': elapsed,
                          'render': result['timings']['render'] + elapsed}
    return encoded


async def render_page(image, analysis, translations, config, language, cleaned, *, encode=True):
    start = time.monotonic()
    mask = decode(analysis['mask'], 'L')
    font = font_for(language, FONT)
    layout = []
    output, glyph_mask, fitted, bubbles = await letter_page(image, analysis, translations, config, language,
                                                 cleaned, mask, font, layout)
    elapsed = time.monotonic() - start
    # The checked erase mask already has a PNG representation in the checkpoint.
    result = {'image': output, 'mask': analysis['mask'], 'glyph_mask': glyph_mask,
              'layout_fitted_regions': fitted, 'bubble_regions': bubbles, 'layout': layout,
              'timings': {'render': elapsed, 'render_layout': elapsed}}
    return encode_render(result) if encode else result


@app.post('/v1/{stage}', dependencies=[Depends(authorized)])
async def process(stage: str, request: Request):
    if stage not in ('analyze', 'inpaint', 'render'):
        raise HTTPException(404)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 40 * 1024 * 1024:
            raise HTTPException(413)
    try:
        body = json.loads(raw)
        if 'language' in body and body['language'] not in effective_runtime.languages:
            return JSONResponse(status_code=422, content={'error': 'LANGUAGE_UNSUPPORTED'})
        if body['config']['version'] != VERSION:
            raise HTTPException(409, 'Engine version changed')
        if stage != 'analyze' and len(json.dumps(body['analysis'], allow_nan=False).encode()) > MAX_CHECKPOINT:
            raise ValueError('Checkpoint size')
        async with lock.hold():
            if 'image' in body:
                image = decode(body['image'])
                input_hash = hashlib.sha256(base64.b64decode(body['image'], validate=True)).hexdigest()
                if body.get('input_hash', input_hash) != input_hash:
                    raise ValueError('Input hash mismatch')
                input_ref = cache_key(body['scope'], input_hash, body['config'], {'type': 'source-v1'})
                input_cached = cache.put('source:' + input_ref, image.copy())
            else:
                input_hash = body['input_hash']
                input_ref = cache_key(body['scope'], input_hash, body['config'], {'type': 'source-v1'})
                if body.get('image_ref') != input_ref:
                    raise ValueError('Input cache scope mismatch')
                cached_input = cache.get('source:' + input_ref)
                if cached_input is None:
                    # No inference has run. The agent may safely retry once with
                    # authorized original bytes after an eviction/node restart.
                    return JSONResponse(status_code=410, content={'error': 'ENGINE_INPUT_CACHE_MISS'})
                image, input_cached = cached_input.copy(), True
            with open(os.devnull, 'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
                if stage == 'analyze':
                    result = await analyze(image, body['config'])
                    if len(json.dumps(result, allow_nan=False).encode()) > MAX_CHECKPOINT:
                        raise ValueError('Checkpoint size')
                elif stage == 'inpaint':
                    key = cache_key(body['scope'], input_hash, body['config'], body['analysis'])
                    result = await erase_page(image, body['analysis'], body['config'], encode=False)
                    cached = cache.put('cleaned:' + key, result.pop('cleaned'))
                    result.update(cache_key=key, cached=cached)
                else:
                    key = cache_key(body['scope'], input_hash, body['config'], body['analysis'])
                    cleaned = cache.get('cleaned:' + key) if body.get('cache_key') == key else None
                    recovered = cleaned is None
                    recovery_timings = {}
                    if recovered:
                        erased = await erase_page(image, body['analysis'], body['config'], encode=False)
                        cleaned = erased['cleaned']
                        recovery_timings = erased.get('timings', {})
                        cache.put('cleaned:' + key, cleaned)
                    result = await render_page(image, body['analysis'], body['translations'], body['config'], body['language'],
                                               cleaned, encode=False)
                    result['cache_rebuilt'] = recovered
                    result['timings'] = {**recovery_timings, **result.get('timings', {})}
        if stage == 'render':
            # Arrays belong to this request. Qt/model globals and the cache stay
            # serialized, while independent PNG encoding no longer holds the GPU.
            result = await run_in_threadpool(encode_render, result)
        response = {**result, 'version': VERSION, 'width': image.shape[1], 'height': image.shape[0], 'input_hash': input_hash,
                    'image_ref': input_ref if input_cached else None}
        if len(json.dumps(response, allow_nan=False).encode()) > MAX_RESPONSE:
            raise ValueError('Response size')
        return response
    except HTTPException:
        raise
    except LetteringError as error:
        return JSONResponse(status_code=422, content={'error': error.code})
    except Exception:
        return JSONResponse(status_code=422, content={'error': 'ENGINE_' + stage.upper() + '_FAILED'})
