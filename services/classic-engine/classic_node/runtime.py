"""Compute protocol adapter for the pinned MTU CUDA/Qt pipeline."""
import hashlib
from importlib.metadata import version as package_version
from io import BytesIO
import json
from pathlib import Path
from time import perf_counter

import numpy as np
from PIL import Image

from mtu_engine.assets import LOCK, file_hash, verify
from mtu_engine.engine import Engine, serialize_region
from .protocol import MAX_CHECKPOINT_BYTES, NodeFailure, digest, mask_image, png64, pack_result
from .timing import record

Image.MAX_IMAGE_PIXELS = None

LANGUAGE_PROBES = {'zh-Hans': '简体中文漫画', 'zh-Hant': '繁體中文漫畫', 'ja': '日本語あいうアイウ',
                   'ko': '한국어가나다', 'en': 'English', 'fr': 'Françaiséèç', 'es': 'Españolñ',
                   'pt-BR': 'Portuguêsã', 'de': 'Deutschäöüß', 'it': 'Italianoà', 'ru': 'Русский',
                   'pl': 'Polskiąćęłńóśźż', 'uk': 'Українськаіїєґ', 'tr': 'Türkçeğıİş',
                   'vi': 'Tiếng Việtắằẳẵặớờởỡợ', 'id': 'Bahasa Indonesia',
                   'ar': 'العربية لا لأ لإ لآ مُحَمَّد ٢٠٠،؟…: AMIRA (200)'}


def model_identity(models):
    return verify(models)['files']


def decode_mask(analysis, name, size):
    if analysis.get(name) is None:
        return np.zeros((size[1], size[0]), dtype=np.uint8)
    with mask_image(analysis[name], size, allow_empty=name != 'mask') as decoded:
        return np.array(decoded)


class Runtime:
    ANALYSIS_FORMAT = 'mtu-regions-v1'

    def __init__(self, config):
        self.config = config
        options = config['engine']
        assets = model_identity(options['models'])
        self.engine = Engine(**options)
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
            'PySide6-Essentials', 'shiboken6', 'mahotas', 'manga-ocr', 'openocr-python',
            'transformers', 'huggingface-hub', 'tokenizers')}
        self.version = 'mtu-cuda-v1-' + digest({'upstream': LOCK['source']['revision'],
            'code': code, 'assets': assets, 'dependencies': dependencies,
            'fonts': [file_hash(path) for path in options['font']],
            'options': {key: value for key, value in options.items() if key not in {'models', 'font', 'threads', 'gpu'}}})[:32]

    def close(self):
        self.engine.close()

    def warmup(self):
        self.engine.warmup()

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

    def analyze(self, rgb, input_hash):
        regions, mask, raw, bubbles = self.engine.analyze(rgb)
        if regions and (mask is None or not mask.any()):
            raise NodeFailure('CLASSIC_ANALYZE_FAILED')
        def encoded(value):
            return png64(Image.fromarray(value), MAX_CHECKPOINT_BYTES) if value is not None and value.any() else None
        analysis = {'version': self.version, 'format': self.ANALYSIS_FORMAT, 'input_hash': input_hash,
            'width': rgb.shape[1], 'height': rgb.shape[0],
            'segments': [{'id': str(index), 'source': region.text} for index, region in enumerate(regions)],
            'regions': [serialize_region(region) for region in regions],
            'mask': encoded(mask), 'raw_mask': encoded(raw), 'bubble_mask': encoded(bubbles)}
        if (len(regions) > 200 or any(not item['source'].strip() or len(item['source']) > 4000 for item in analysis['segments'])
                or len(json.dumps(analysis, allow_nan=False).encode()) > MAX_CHECKPOINT_BYTES):
            raise NodeFailure('CLASSIC_ANALYZE_FAILED')
        return analysis

    def inpaint(self, rgb, analysis):
        self.validate_analysis(analysis)
        size = (rgb.shape[1], rgb.shape[0])
        return self.engine.inpaint(rgb, decode_mask(analysis, 'mask', size),
            decode_mask(analysis, 'raw_mask', size), decode_mask(analysis, 'bubble_mask', size), analysis['regions'])

    def render(self, original, cleaned, analysis, translated, language, alpha, *, allow_tiles=False, mask_cache_bytes=None):
        self.validate_analysis(analysis)
        if (translated['analysis_hash'] != digest(analysis) or translated['language'] != language
                or set(translated['translations']) != {item['id'] for item in analysis['segments']}
                or len(analysis['segments']) != len(analysis['regions'])):
            raise NodeFailure('CLASSIC_RENDER_MISMATCH')
        texts = [translated['translations'][item['id']] for item in analysis['segments']]
        if not all(isinstance(text, str) for text in texts):
            raise NodeFailure('CLASSIC_RENDER_MISMATCH')
        started = perf_counter()
        if any(text.strip() for text in texts):
            rendered = self.engine.renderer.render(original, cleaned, analysis['regions'], texts, language,
                decode_mask(analysis, 'bubble_mask', (original.shape[1], original.shape[0])), mask_cache_bytes=mask_cache_bytes)
        else:
            rendered = cleaned
        record('render_layout', perf_counter() - started)
        return pack_result(Image.fromarray(rendered), original, alpha, self.version, analysis, translated, allow_tiles=allow_tiles)
