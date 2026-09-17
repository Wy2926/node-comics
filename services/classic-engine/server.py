"""Private stage service. No LLM credentials, task database or public ports."""
import base64
from contextlib import asynccontextmanager, redirect_stdout, redirect_stderr
import hashlib
import hmac
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
from execution import Pipeline, Execution, drain
from image_codec import decode, png
from render_stage import render_page as render_direct, encode_render
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
NEURAL_MODE = os.environ.get('ENGINE_NEURAL_ACCELERATION', 'eager')
if NEURAL_MODE not in ('eager', 'portable-v1') or (PROFILE == 'mit-directml' and NEURAL_MODE != 'eager'):
    raise ValueError('Unsupported ENGINE_NEURAL_ACCELERATION for this profile')
if NEURAL_MODE != 'eager':
    VERSION += '-torch-portable-v1'
DEVICE = os.environ.get('ENGINE_DEVICE', 'cpu')
if DEVICE == 'cuda':
    DEVICE = 'cuda:0'
RESOURCE_ID = os.environ.get('ENGINE_RESOURCE_ID', DEVICE)
FONT = os.environ.get('ENGINE_FONT', '/opt/mit/fonts/NotoSansMonoCJK-VF.ttf.ttc')
from render_languages import prepare_fonts
from lettering import LetteringError
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
position_cache = None
neural_runtime = None
pipeline = None


def initialize_device_thread():
    torch.set_num_threads(effective_runtime.torch_threads)
    if DEVICE.startswith('cuda'):
        torch.cuda.set_device(torch.device(DEVICE))


def synchronize_device():
    if DEVICE.startswith('cuda'):
        torch.cuda.synchronize(torch.device(DEVICE))


@asynccontextmanager
async def lifespan(app):
    global ready, device_evidence, panel_worker, inpaint_pool, dictionary_store, position_cache, neural_runtime, pipeline
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
            if PROFILE == 'mit':
                from ocr_position_cache import PositionCache
                position_cache = PositionCache(models['ocr'].model)
            import manga_translator.mask_refinement as mask_refinement
            from mask_geometry import complete_mask
            mask_refinement.complete_mask = complete_mask
            # Warm both device pipelines before reporting admission readiness.
            sample = np.full((256, 256, 3), 255, np.uint8)
            await models['detector'].detect(sample, 256, 0.5, 0.7, 2.3, False, False, False, False, False)
            warm_mask = np.zeros((256, 256), np.uint8)
            warm_mask[120:128, 120:128] = 255
            if INPAINT_WORKERS == 1:
                await models['inpainter'].inpaint(sample, warm_mask, InpainterConfig(inpainting_precision='fp32'), 256, False)
    try:
        if NEURAL_MODE == 'portable-v1':
            from neural_acceleration import NeuralAcceleration
            async with lock.hold():
                with open(os.devnull, 'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
                    neural_runtime = NeuralAcceleration(models)
        if INPAINT_WORKERS == 2:
            from parallel_lama import ParallelLama
            async with lock.hold():
                inpaint_pool = ParallelLama(threads=int(os.environ.get('OMP_NUM_THREADS', '4')))
                inpaint_pool.warm()
        if PROFILE == 'mit' or DIRECTML_OPTIMIZED:
            from parallel_panels import ParallelPanels
            panel_worker = ParallelPanels(opencv_threads=LOCAL_RUNTIME.opencv_threads)
            # Spawn/import CPU helper before admitting the first real page.
            panel_worker.submit(sample, True).result()
        pipeline = Pipeline(initialize_device_thread)
        async with lock.hold():
            await pipeline.run(pipeline.device_executor, synchronize_device)
        await pipeline.cpu(torch.set_num_threads, effective_runtime.torch_threads)
        await pipeline.configure_layout(default_directory(), effective_runtime.languages, effective_runtime.opencv_threads)
        ready = True
        yield
    finally:
        ready = False
        if pipeline:
            async with pipeline.admission.exclusive():
                pipeline.close()
            pipeline = None
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
        if neural_runtime:
            neural_runtime.close()
            neural_runtime = None
        if position_cache:
            position_cache.close()
            position_cache = None
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
            'pipeline': {'implementation': 'cpu-device-overlap-v1', 'capacity': 3,
                         'device_workers': 1, 'cpu_workers': 1, 'layout_workers': 1,
                         'active': pipeline.admission.active if pipeline else 0},
            'cuda': {'available': torch.cuda.is_available(), 'device_name': torch.cuda.get_device_name(DEVICE),
                     'torch_version': torch.__version__} if DEVICE.startswith('cuda') else None,
            'panel_execution': 'parallel-process' if panel_worker else 'serial',
            'analysis_runtime': 'bounded-panels-mask-xpos-v1',
            'ocr_position_cache': position_cache.describe() if position_cache else None,
            'neural_acceleration': neural_runtime.describe() if neural_runtime else {'implementation': 'eager'},
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
        async with configuration_guard():
            async with lock.hold():
                await drain(apply_runtime(updated, store))
        return {'runtime': updated.model_dump(), 'supported_languages': updated.languages}
    except ValidationError as error:
        unsupported = any(item['type'] == 'literal_error' and item['loc'][0] == 'languages' for item in error.errors())
        return JSONResponse(status_code=422, content={'error': 'LANGUAGE_UNSUPPORTED' if unsupported else 'ENGINE_CONFIG_FAILED'})
    except Exception:
        return JSONResponse(status_code=422, content={'error': 'ENGINE_CONFIG_FAILED'})


@asynccontextmanager
async def configuration_guard():
    if pipeline:
        async with pipeline.admission.exclusive():
            yield
    else:
        yield


async def install_runtime(updated, store):
    if pipeline:
        await pipeline.configure_layout(store.directory, updated.languages, updated.opencv_threads)
        await pipeline.run(pipeline.device_executor, torch.set_num_threads, updated.torch_threads)
        await pipeline.cpu(torch.set_num_threads, updated.torch_threads)
    torch.set_num_threads(updated.torch_threads)
    cv2.setNumThreads(updated.opencv_threads)
    if panel_worker:
        panel_worker.opencv_threads = updated.opencv_threads
    if inpaint_pool:
        inpaint_pool.threads = updated.torch_threads
        inpaint_pool.opencv_threads = updated.opencv_threads
    initialize_typesetter(store)


async def apply_runtime(updated, store):
    global effective_runtime, dictionary_store, cache, ready
    try:
        await install_runtime(updated, store)
    except Exception:
        try:
            if dictionary_store is not None:
                await install_runtime(effective_runtime, dictionary_store)
        except Exception:
            # A failed rollback must never advertise a partially applied runtime.
            ready = False
        raise
    dictionary_store = store
    if (updated.cache_bytes, updated.cache_ttl_seconds) != (cache.max_bytes, cache.ttl_seconds):
        cache = ImageCache(updated.cache_bytes, updated.cache_ttl_seconds)
    effective_runtime = updated


def region_json(block):
    return {'lines': block.lines.tolist(), 'texts': block.texts, 'font_size': int(block.font_size),
            'angle': float(block.angle), 'fg_color': [int(v) for v in block.fg_colors],
            'bg_color': [int(v) for v in block.bg_colors], 'prob': float(block.prob)}


async def analyze(image, config, *, execution=None):
    future = panel_worker.submit(image, config['reading_order'] == 'rtl') if panel_worker else None
    try:
        return await analyze_regions(image, config, future, execution=execution)
    finally:
        if future is not None:
            # Bound outstanding CPU work even for no-text/error/cancelled pages.
            try:
                if execution:
                    await execution.cpu(future.result)
                else:
                    future.result()
            except Exception:
                pass


async def detect_and_recognize(image, config):
    lines, raw_mask, _ = await models['detector'].detect(image, config['detection_size'], 0.5, 0.7, 2.3, False, False, False, False, False)
    if not lines:
        return [], [], raw_mask
    detected_lines = list(lines)
    lines = await models['ocr'].recognize(image, lines, OcrConfig(prob=0.2), False)
    return detected_lines, lines, raw_mask


async def finish_analysis(image, config, detected_lines, lines, raw_mask, panel_future):
    if not detected_lines:
        return {'segments': [], 'regions': [], 'mask': None}
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
            'quality_flags': ['unrecognized_regions'] if unrecognized else []}


async def analyze_regions(image, config, panel_future=None, *, execution=None):
    start = time.monotonic()
    if execution:
        detected_lines, lines, raw_mask = await execution.device(detect_and_recognize, image, config)
        result = await execution.cpu(finish_analysis, image, config, detected_lines, lines, raw_mask, panel_future)
    else:
        detected_lines, lines, raw_mask = await detect_and_recognize(image, config)
        result = await finish_analysis(image, config, detected_lines, lines, raw_mask, panel_future)
    result['timings'] = {'detect_ocr': time.monotonic() - start}
    return result


async def erase_page(image, analysis, config, *, encode=True, execution=None):
    mask = await execution.cpu(decode, analysis['mask'], 'L') if execution else decode(analysis['mask'], 'L')
    if mask.shape != image.shape[:2] or not np.any(mask):
        raise ValueError('Mask dimensions')
    start = time.monotonic()
    if config['inpainting_strategy'] != 'masked-crops-v1':
        raise ValueError('Unsupported inpainting strategy')

    async def predict(crop, crop_mask):
        function = models['inpainter'].inpaint
        args = (crop, crop_mask, InpainterConfig(inpainting_precision='fp32'), config['inpainting_size'], False)
        return await execution.device(function, *args) if execution else await function(*args)

    if inpaint_pool:
        options = dict(max_size=config['inpainting_size'], padding=config['inpainting_padding'],
                       merge_gap=config['inpainting_merge_gap'])
        # The DirectML pool owns two private GPU workers; drain the whole pool
        # under one device lease, including its recovery/error paths.
        cleaned = (await execution.device(inpaint_pool.inpaint, image, mask, **options) if execution else
                   inpaint_pool.inpaint(image, mask, **options))
    else:
        cleaned = await inpaint_regions(image, mask, predict, max_size=config['inpainting_size'],
                                        padding=config['inpainting_padding'], merge_gap=config['inpainting_merge_gap'],
                                        run_cpu=execution.cpu if execution else None)
    # Enforce original pixels outside the erase mask, even if an engine changes them.
    if execution:
        await execution.cpu(restore_unmasked, cleaned, image, mask)
    else:
        restore_unmasked(cleaned, image, mask)
    return {'cleaned': png(cleaned) if encode else cleaned, 'timings': {'inpaint': time.monotonic() - start}}


def restore_unmasked(cleaned, image, mask):
    cleaned[mask == 0] = image[mask == 0]


async def render_page(image, analysis, translations, config, language, cleaned, *, encode=True, execution=None):
    function = execution.render if execution else render_direct
    return await function(image, analysis, translations, config, language, cleaned, font=FONT, encode=encode)


def decode_input(value):
    image = decode(value)
    return image, hashlib.sha256(base64.b64decode(value, validate=True)).hexdigest(), image.copy()


def validate_response(response):
    if len(json.dumps(response, allow_nan=False).encode()) > MAX_RESPONSE:
        raise ValueError('Response size')
    return response


@app.post('/v1/{stage}', dependencies=[Depends(authorized)])
async def process(stage: str, request: Request):
    if stage not in ('analyze', 'inpaint', 'render'):
        raise HTTPException(404)
    if pipeline is None or not ready:
        raise HTTPException(503, 'Engine not ready')
    started = time.monotonic()
    async with pipeline.admission.enter():
        if not ready:
            raise HTTPException(503, 'Engine not ready')
        execution = Execution(pipeline, lock, synchronize_device)
        execution.add('admission_wait', time.monotonic() - started)
        result = await process_admitted(stage, request, execution)
        if isinstance(result, dict):
            execution.add('request_wall', time.monotonic() - started)
            result['timings'] = {**result.get('timings', {}),
                **{stage + '_' + key: value for key, value in execution.timings.items()}}
        return result


async def process_admitted(stage, request, execution):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 40 * 1024 * 1024:
            raise HTTPException(413)
    try:
        body = await execution.cpu(json.loads, raw)
        del raw
        if 'language' in body and body['language'] not in effective_runtime.languages:
            return JSONResponse(status_code=422, content={'error': 'LANGUAGE_UNSUPPORTED'})
        if body['config']['version'] != VERSION:
            raise HTTPException(409, 'Engine version changed')
        if stage != 'analyze' and len(json.dumps(body['analysis'], allow_nan=False).encode()) > MAX_CHECKPOINT:
            raise ValueError('Checkpoint size')
        # Cache metadata belongs exclusively to the event loop. Native workers
        # receive strong, request-local array references, never the mutable LRU.
        if 'image' in body:
            image, input_hash, cached_image = await execution.cpu(decode_input, body.pop('image'))
            if body.get('input_hash', input_hash) != input_hash:
                raise ValueError('Input hash mismatch')
            input_ref = cache_key(body['scope'], input_hash, body['config'], {'type': 'source-v1'})
            input_cached = cache.put('source:' + input_ref, cached_image)
            del cached_image
        else:
            input_hash = body['input_hash']
            input_ref = cache_key(body['scope'], input_hash, body['config'], {'type': 'source-v1'})
            if body.get('image_ref') != input_ref:
                raise ValueError('Input cache scope mismatch')
            cached_input = cache.get('source:' + input_ref)
            if cached_input is None:
                return JSONResponse(status_code=410, content={'error': 'ENGINE_INPUT_CACHE_MISS'})
            image, input_cached = await execution.cpu(cached_input.copy), True
            del cached_input
        if stage == 'analyze':
            result = await analyze(image, body['config'], execution=execution)
            if len(json.dumps(result, allow_nan=False).encode()) > MAX_CHECKPOINT:
                raise ValueError('Checkpoint size')
        elif stage == 'inpaint':
            key = cache_key(body['scope'], input_hash, body['config'], body['analysis'])
            result = await erase_page(image, body['analysis'], body['config'], encode=False, execution=execution)
            cached = cache.put('cleaned:' + key, result.pop('cleaned'))
            result.update(cache_key=key, cached=cached)
        else:
            key = cache_key(body['scope'], input_hash, body['config'], body['analysis'])
            cleaned = cache.get('cleaned:' + key) if body.get('cache_key') == key else None
            recovered = cleaned is None
            recovery_timings = {}
            if recovered:
                erased = await erase_page(image, body['analysis'], body['config'], encode=False, execution=execution)
                cleaned = erased['cleaned']
                recovery_timings = erased.get('timings', {})
                cache.put('cleaned:' + key, cleaned)
            result = await render_page(image, body['analysis'], body['translations'], body['config'], body['language'],
                                       cleaned, encode=False, execution=execution)
            result['cache_rebuilt'] = recovered
            result['timings'] = {**recovery_timings, **result.get('timings', {})}
            result = await execution.cpu(encode_render, result)
        response = {**result, 'version': VERSION, 'width': image.shape[1], 'height': image.shape[0], 'input_hash': input_hash,
                    'image_ref': input_ref if input_cached else None}
        return await execution.cpu(validate_response, response)
    except HTTPException:
        raise
    except LetteringError as error:
        return JSONResponse(status_code=422, content={'error': error.code})
    except Exception:
        return JSONResponse(status_code=422, content={'error': 'ENGINE_' + stage.upper() + '_FAILED'})
