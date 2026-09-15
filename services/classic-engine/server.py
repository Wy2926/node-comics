"""Private stage service. No LLM credentials, task database or public ports."""
import base64
from contextlib import asynccontextmanager, redirect_stdout, redirect_stderr
import hashlib
import hmac
from io import BytesIO
import json
import logging
import os
from pathlib import Path
import time

import cv2
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
import numpy as np
from PIL import Image
import torch
from manga_translator.config import OcrConfig, InpainterConfig
from manga_translator.detection.default import DefaultDetector
from manga_translator.ocr.model_48px import Model48pxOCR
from manga_translator.inpainting.inpainting_lama_mpe import LamaLargeInpainter
from manga_translator.textline_merge import dispatch as merge
from manga_translator.mask_refinement import dispatch as refine
from manga_translator.rendering import dispatch as render, text_render
from manga_translator.utils import ModelWrapper, TextBlock, sort_regions
from local_inpainting import inpaint_regions
from runtime import DeviceLock, ImageCache, cache_key

PROFILE = os.environ.get('ENGINE_PROFILE', 'mit')
DIRECTML_OPTIMIZED = PROFILE == 'mit-directml' and os.environ.get('ENGINE_DIRECTML_OPTIMIZED', '1') == '1'
INPAINT_WORKERS = int(os.environ.get('ENGINE_INPAINT_WORKERS', '2')) if DIRECTML_OPTIMIZED else 1
if INPAINT_WORKERS not in (1, 2):
    raise ValueError('ENGINE_INPAINT_WORKERS must be 1 or 2')
AMD_VERSION = 'mit-95227a2-classic-v4-dml-v3' if INPAINT_WORKERS == 2 else ('mit-95227a2-classic-v4-dml-v2' if DIRECTML_OPTIMIZED else 'mit-95227a2-classic-v4-dml-v1')
VERSION = os.environ.get('ENGINE_VERSION', AMD_VERSION if PROFILE == 'mit-directml' else 'mit-95227a2-classic-v4-cluster')
DEVICE = os.environ.get('ENGINE_DEVICE', 'cpu')
if DEVICE == 'cuda':
    DEVICE = 'cuda:0'
RESOURCE_ID = os.environ.get('ENGINE_RESOURCE_ID', DEVICE)
FONT = os.environ.get('ENGINE_FONT', '/opt/mit/fonts/NotoSansMonoCJK-VF.ttf.ttc')
LANG = {'zh-Hans': 'CHS', 'zh-Hant': 'CHT', 'ja': 'JPN', 'en': 'ENG', 'ko': 'KOR'}
Image.MAX_IMAGE_PIXELS = 24_000_000
lock = DeviceLock(RESOURCE_ID, os.environ.get('ENGINE_LOCK_DIR', '/tmp/comics-device-locks'))
cache = ImageCache(int(os.environ.get('ENGINE_CACHE_BYTES', str(256 * 1024 * 1024))),
                   int(os.environ.get('ENGINE_CACHE_TTL_SECONDS', '900')))
MAX_CHECKPOINT = 4 * 1024 * 1024
MAX_RESPONSE = 96 * 1024 * 1024
models = {}
ready = False
device_evidence = None
panel_worker = None
inpaint_pool = None


@asynccontextmanager
async def lifespan(app):
    global ready, device_evidence, panel_worker, inpaint_pool
    logging.disable(logging.CRITICAL)  # Upstream OCR log messages include dialogue.
    torch.set_num_threads(int(os.environ.get('OMP_NUM_THREADS', '4')))
    ModelWrapper._MODEL_DIR = os.environ.get('MODEL_DIR', '/models')
    text_render.FALLBACK_FONTS = [FONT]
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
            if device_evidence and device_evidence.profile_dir:
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
    return {'ready': ready, 'version': VERSION, 'device': DEVICE, 'resource_id': RESOURCE_ID,
            'capacity': 1, 'capabilities': ['analyze', 'inpaint', 'render'], 'cache_bytes': cache.size,
            'panel_execution': 'parallel-process' if panel_worker else 'serial',
            'input_cache_protocol': 1,
            'inpaint_workers': inpaint_pool.evidence() if inpaint_pool else [],
            **({'inference': device_evidence.evidence()} if device_evidence else {})}


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


async def render_page(image, analysis, translations, config, language, cleaned):
    regions = [TextBlock(**row) for row in analysis['regions']]
    if len(regions) != len(analysis['segments']) or not regions:
        raise ValueError('Region mismatch')
    mask = decode(analysis['mask'], 'L')
    if mask.shape != image.shape[:2] or cleaned.shape != image.shape:
        raise ValueError('Mask or cleaned image dimensions')
    if np.any(cleaned[mask == 0] != image[mask == 0]):
        raise ValueError('Cleaned image changed protected pixels')
    for segment, region in zip(analysis['segments'], regions):
        region.translation = translations[segment['id']]
        face = text_render.get_cached_font(FONT)
        if any(not char.isspace() and face.get_char_index(ord(char)) == 0 for char in region.translation):
            raise ValueError('Font missing glyph')
        region.target_lang = LANG[language]
        region._alignment = 'center'
    start = time.monotonic()
    rendered = cleaned.copy()
    glyph_mask = np.zeros(mask.shape, dtype=np.uint8)
    for region in regions:
        previous = rendered.copy()
        rendered = await render(rendered, [region], FONT, font_size_minimum=config['font_minimum'], hyphenate=False)
        changed = np.any(rendered != previous, axis=2)
        if not changed.any():
            raise ValueError('Renderer produced no glyphs')
        glyph_mask[changed] = 255
    allowed = (mask > 0) | (glyph_mask > 0)
    protected = np.zeros(mask.shape, dtype=np.uint8)
    for polygon in analysis.get('unrecognized_regions', []):
        cv2.fillConvexPoly(protected, np.array(polygon, dtype=np.int32), 255)
    if np.any(allowed & (protected > 0)):
        raise ValueError('Translated text overlaps an unrecognized region')
    output = image.copy()
    output[allowed] = rendered[allowed]
    return {'image': png(output), 'mask': png(mask), 'glyph_mask': png(glyph_mask),
            'timings': {'render': time.monotonic() - start}}


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
                                               cleaned.copy())
                    result['cache_rebuilt'] = recovered
                    result['timings'] = {**recovery_timings, **result.get('timings', {})}
        response = {**result, 'version': VERSION, 'width': image.shape[1], 'height': image.shape[0], 'input_hash': input_hash,
                    'image_ref': input_ref if input_cached else None}
        if len(json.dumps(response, allow_nan=False).encode()) > MAX_RESPONSE:
            raise ValueError('Response size')
        return response
    except HTTPException:
        raise
    except Exception:
        return JSONResponse(status_code=422, content={'error': 'ENGINE_' + stage.upper() + '_FAILED'})
