"""Compute protocol adapter for the pinned MTU CUDA/Qt pipeline."""
import hashlib
from importlib.metadata import version as package_version
from io import BytesIO
import json
from pathlib import Path
from threading import Lock
from types import SimpleNamespace

import numpy as np
from PIL import Image

from mtu_engine.assets import LOCK, file_hash, verify
from mtu_engine.engine import Engine, serialize_region
from .render_pool import RenderPool, RenderPoolError, RenderMemoryError, ipc_bytes, render_page
from .operations import LOG
from .protocol import MAX_CHECKPOINT_BYTES, NodeFailure, digest, mask_image, png64
from .timing import stage

Image.MAX_IMAGE_PIXELS = None

LANGUAGE_PROBES = {'zh-Hans': '简体中文漫画', 'zh-Hant': '繁體中文漫畫', 'ja': '日本語あいうアイウ',
                   'ko': '한국어가나다', 'en': 'English', 'fr': 'Françaiséèç', 'es': 'Españolñ',
                   'pt-BR': 'Portuguêsã', 'de': 'Deutschäöüß', 'it': 'Italianoà', 'ru': 'Русский',
                   'pl': 'Polskiąćęłńóśźż', 'uk': 'Українськаіїєґ', 'tr': 'Türkçeğıİş',
                   'vi': 'Tiếng Việtắằẳẵặớờởỡợ', 'id': 'Bahasa Indonesia',
                   'ar': 'العربية لا لأ لإ لآ مُحَمَّد ٢٠٠،؟…: AMIRA (200)'}


def model_identity(models):
    return verify(models)['files']


def decode_mask(analysis, name, size, masks=None):
    if masks is not None and name in masks:
        return masks[name]
    if analysis.get(name) is None:
        return np.zeros((size[1], size[0]), dtype=np.uint8)
    with mask_image(analysis[name], size, allow_empty=name != 'mask') as decoded:
        value = np.array(decoded)
    value.flags.writeable = False
    return value


class Runtime:
    ANALYSIS_FORMAT = 'mtu-regions-v1'

    def __init__(self, config):
        self.config = config
        options = config['engine']
        assets = model_identity(options['models'])
        self.engine = Engine(**options)
        self.render_pool = None
        self._render_warning_lock = Lock()
        self._render_fallback_warned = set()
        self.languages = [lang for lang, probe in LANGUAGE_PROBES.items() if self.engine.renderer.covers(probe)]
        if not self.languages:
            self.engine.close()
            raise ValueError('Fonts do not cover any supported target language')
        source = Path(__file__).resolve().parents[1]
        code = {path.relative_to(source).as_posix(): file_hash(path)
                for directory in ('mtu_engine', 'classic_node')
                for path in sorted((source / directory).glob('*.py'))}
        dependencies = {name: package_version(name) for name in (
            'torch', 'torchvision', 'onnxruntime-gpu', 'ultralytics', 'PyQt6', 'PyQt6-Qt6', 'PyHyphen',
            'numpy', 'opencv-python', 'Pillow', 'networkx', 'shapely', 'rapidocr',
            'PySide6-Essentials', 'shiboken6', 'mahotas', 'manga-ocr',
            'transformers', 'huggingface-hub', 'tokenizers')}
        self.version = 'mtu-cuda-v1-' + digest({'upstream': LOCK['source']['revision'],
            'code': code, 'assets': assets, 'dependencies': dependencies,
            'fonts': [file_hash(path) for path in options['font']],
            'options': {key: value for key, value in options.items() if key not in {'models', 'font', 'threads', 'gpu'}}})[:32]
        if config.get('render_workers', 1) > 1:
            try:
                self.render_pool = RenderPool(options['models'], options['font'], config['render_workers'],
                    config['_render_threads'])
            except Exception:
                self.engine.close()
                raise

    def close(self):
        try:
            if self.render_pool is not None:
                self.render_pool.close()
        finally:
            self.engine.close()

    def warmup(self):
        self.engine.warmup()
        if self.render_pool is not None:
            self.render_pool.warmup()

    def render_ipc_bytes(self, width, height, *, masks=None):
        stats = (masks or {}).get('bubble_stats')
        return ipc_bytes(width, height, len(stats) if stats is not None else 0) if self.render_pool is not None else 0

    def render_cache_bytes(self, analysis, translated, masks):
        texts = translated.get('translations', {})
        regions = [SimpleNamespace(**region) for segment, region in zip(analysis.get('segments', []),
                   analysis.get('regions', [])) if texts.get(str(segment['id']), '').strip()]
        if not regions or not analysis.get('bubble_mask'):
            return 0
        if 'bubble_labels' in masks:
            from manga_translator.utils.bubble import reference_cache_bytes
            with stage('render_cache_plan'):
                return reference_cache_bytes(regions, masks['bubble_inset'], masks['bubble_labels'])
        return analysis['width'] * analysis['height'] * len(regions)

    def warn_render_fallback(self, reason):
        with self._render_warning_lock:
            if reason not in self._render_fallback_warned:
                LOG.warning('event=render_local_fallback reason=%s mixed_cpu_slots=%s', reason,
                            self.config.get('_cpu_resources', {}).get('mixed_render_cpu_slots'))
                self._render_fallback_warned.add(reason)

    def validate_analysis(self, analysis):
        # Build fingerprints are provenance, not a cross-node resume barrier.
        # Only incompatible checkpoint geometry must be rejected before text work.
        if analysis.get('format') != self.ANALYSIS_FORMAT:
            raise NodeFailure('CLASSIC_ENGINE_MISMATCH')

    def decode(self, data, metadata):
        if metadata.get('normalization_version') != 1 or len(data) != metadata['byte_size']:
            raise NodeFailure('INPUT_INVALID')
        if hashlib.sha256(data).hexdigest() != metadata['sha256']:
            raise NodeFailure('INPUT_HASH_MISMATCH')
        alpha = None
        try:
            with Image.open(BytesIO(data)) as image:
                if (image.size != (metadata['width'], metadata['height']) or Image.MIME.get(image.format) != metadata['mime']
                        or image.format not in {'PNG', 'JPEG', 'WEBP'} or getattr(image, 'n_frames', 1) != 1
                        or image.getexif().get(274, 1) != 1 or image.info.get('icc_profile')):
                    raise NodeFailure('INPUT_INVALID')
                if 'A' in image.getbands() or 'transparency' in image.info:
                    with image.convert('RGBA') as rgba:
                        alpha = rgba.getchannel('A')
                with image.convert('RGB') as rgb:
                    return np.array(rgb), alpha
        except MemoryError as error:
            if alpha is not None:
                alpha.close()
            raise NodeFailure('INPUT_MEMORY_EXCEEDED') from error
        except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as error:
            if alpha is not None:
                alpha.close()
            raise NodeFailure('INPUT_INVALID') from error

    def restore_masks(self, analysis, size, masks):
        """Decode a recovered checkpoint once; native arrays never enter its identity."""
        masks.clear()
        self.validate_analysis(analysis)
        if analysis.get('segments') and analysis.get('mask') is None:
            raise NodeFailure('CLASSIC_OCR_INVALID')
        for name in ('mask', 'raw_mask', 'bubble_mask'):
            if analysis.get(name) is not None:
                masks[name] = decode_mask(analysis, name, size)

    def analyze(self, rgb, input_hash, *, masks=None):
        regions, mask, raw, bubbles = self.engine.analyze(rgb)
        if regions and (mask is None or not mask.any()):
            raise NodeFailure('CLASSIC_ANALYZE_FAILED')
        native = {}
        def encoded(name, value):
            if value is None or not value.any():
                return None
            if value.dtype != np.uint8 or value.shape != rgb.shape[:2]:
                raise NodeFailure('CLASSIC_ANALYZE_FAILED')
            with stage('analyze_checkpoint'), Image.fromarray(value) as image:
                payload = png64(image, MAX_CHECKPOINT_BYTES)
            if masks is not None:
                # DBNet can return a crop of its padded mask. Retain only this
                # page's compact pixels, so nbytes accounts for the whole buffer.
                if not value.flags.owndata or not value.flags.c_contiguous:
                    value = value.copy()
                value.flags.writeable = False
                native[name] = value
            return payload
        analysis = {'version': self.version, 'format': self.ANALYSIS_FORMAT, 'input_hash': input_hash,
            'width': rgb.shape[1], 'height': rgb.shape[0],
            'segments': [{'id': str(index), 'source': region.text} for index, region in enumerate(regions)],
            'regions': [serialize_region(region) for region in regions],
            'mask': encoded('mask', mask), 'raw_mask': encoded('raw_mask', raw),
            'bubble_mask': encoded('bubble_mask', bubbles)}
        if (len(regions) > 200 or any(not item['source'].strip() or len(item['source']) > 4000 for item in analysis['segments'])
                or len(json.dumps(analysis, allow_nan=False).encode()) > MAX_CHECKPOINT_BYTES):
            raise NodeFailure('CLASSIC_ANALYZE_FAILED')
        if masks is not None:
            masks.clear()
            masks.update(native)
        return analysis

    def inpaint(self, rgb, analysis, *, masks=None):
        self.validate_analysis(analysis)
        size = (rgb.shape[1], rgb.shape[0])
        return self.engine.inpaint(rgb, decode_mask(analysis, 'mask', size, masks),
            decode_mask(analysis, 'raw_mask', size, masks), decode_mask(analysis, 'bubble_mask', size, masks),
            analysis['regions'], **({'cache': masks} if masks is not None else {}))

    def render(self, original, cleaned, analysis, translated, language, alpha, *, allow_tiles=False,
               mask_cache_bytes=None, use_render_pool=True, check_cancelled=None, masks=None):
        if check_cancelled:
            check_cancelled()
        self.validate_analysis(analysis)
        if (translated['analysis_hash'] != digest(analysis) or translated['language'] != language
                or set(translated['translations']) != {item['id'] for item in analysis['segments']}
                or len(analysis['segments']) != len(analysis['regions'])):
            raise NodeFailure('CLASSIC_RENDER_MISMATCH')
        texts = [translated['translations'][item['id']] for item in analysis['segments']]
        if not all(isinstance(text, str) for text in texts):
            raise NodeFailure('CLASSIC_RENDER_MISMATCH')
        has_text = any(text.strip() for text in texts)
        prepared = masks is not None and 'bubble_inset' in masks
        bubble = masks['bubble_inset'] if prepared else (
            decode_mask(analysis, 'bubble_mask', (original.shape[1], original.shape[0]), masks)
            if has_text and analysis.get('bubble_mask') is not None else None)
        args = (original, cleaned, analysis['regions'], texts, language, bubble)
        # Only output identity crosses the process boundary, not encoded masks
        # or the complete translation checkpoint already validated above.
        options = {'alpha': alpha, 'version': self.version,
                   'analysis': {'input_hash': analysis['input_hash']},
                   'translated': {'analysis_hash': translated['analysis_hash'], 'revision': translated['revision']},
                   'allow_tiles': allow_tiles, 'mask_cache_bytes': mask_cache_bytes}
        if prepared:
            options['bubble_prepared'] = True
            if 'bubble_labels' in masks:
                options['bubble_components'] = (masks['bubble_labels'], masks['bubble_stats'])
        pooled = has_text and use_render_pool and self.render_pool is not None
        if has_text and self.render_pool is not None and not use_render_pool:
            self.warn_render_fallback('page_budget')
        if pooled:
            try:
                result = self.render_pool.render(*args, **options, check_cancelled=check_cancelled)
            except RenderMemoryError:
                # Resident memory and /dev/shm have independent limits.
                # Only allocation failures may safely use the local path.
                self.warn_render_fallback('shared_memory')
                pooled = False
            except RenderPoolError as error:
                raise NodeFailure(error.code) from error
        if not pooled:
            if check_cancelled:
                check_cancelled()
            result = render_page(self.engine.renderer, *args, **options, check_cancelled=check_cancelled)
        if check_cancelled:
            check_cancelled()
        return result
