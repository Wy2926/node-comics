"""Map the migrated image pipeline to recoverable analysis and final PNGs."""
from concurrent.futures import wait
import hashlib
from importlib.metadata import version as package_version
from io import BytesIO
import json
from pathlib import Path

import numpy as np
from PIL import Image
from manhua_engine.engine import Engine, group
from manhua_engine.quality import conservative_mask
from manhua_engine.bubbles import lettering_areas
from manhua_engine.layout import coverage, draw_region, font_paths, resolve_colors
from .protocol import MAX_CHECKPOINT_BYTES, MAX_IMAGE_BYTES, MAX_PIXELS, NodeFailure, digest, mask_image, png64, pack_result

LANGUAGE_PROBES = {'zh-Hans': '简体中文漫画', 'zh-Hant': '繁體中文漫畫', 'ja': '日本語あいうアイウ',
                   'ko': '한국어가나다', 'en': 'English', 'fr': 'Françaiséèç', 'es': 'Españolñ',
                   'pt-BR': 'Portuguêsã', 'de': 'Deutschäöüß', 'it': 'Italianoà', 'ru': 'Русский',
                   'pl': 'Polskiąćęłńóśźż', 'uk': 'Українськаіїєґ', 'tr': 'Türkçeğıİş',
                   'vi': 'Tiếng Việtắằẳẵặớờởỡợ', 'id': 'Bahasa Indonesia'}


def file_hash(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def model_identity(models, language):
    from manhua_engine import __file__ as package_file
    root = Path(models)
    manifest = json.loads((Path(package_file).parent / 'models.json').read_text(encoding='utf-8'))
    expected = {item['name']: item['sha256'] for item in manifest['models']
                if not item.get('language') or item['language'] == language}
    if language == 'ja':
        build = json.loads((root / 'ocr-fp32/build.json').read_text(encoding='utf-8'))
        if (build['source_revision'] != 'd5a3eee4a7b7b7754b71baa2ee82309dfff468bc'
                or build['checkpoint_sha256'] != 'fc61c52f7a811bc72c54f6be85df814c6b60f63585175db27cb94a08e0c30101'
                or build['precision'] != 'fp32'):
            raise ValueError('Unsupported OCR model provenance')
        for name in ('backbone.ncnn.param', 'backbone.ncnn.bin', 'decoder.onnx'):
            expected['ocr-fp32/' + name] = build['files'][name]
    for name, checksum in expected.items():
        if file_hash(root / name) != checksum:
            raise ValueError(f'Model checksum mismatch: {name}')
    return expected


class Runtime:
    def __init__(self, config):
        self.config = config
        options = config['engine']
        model_hashes = model_identity(options['models'], options['ocr_language'])
        fonts = tuple(options.get('font', []))
        font_hashes = {}
        self.languages = []
        for language in config['languages']:
            paths = font_paths(fonts, language.split('-')[0])
            cmap = set().union(*(coverage(path) for path in paths))
            if not set(map(ord, LANGUAGE_PROBES[language].replace(' ', ''))) <= cmap:
                raise ValueError(f'Fonts do not cover advertised language: {language}')
            font_hashes[language] = [file_hash(path) for path in paths]
            self.languages.append(language)
        source = Path(__file__).resolve().parents[1]
        code = {str(path.relative_to(source)).replace('\\', '/'): file_hash(path)
                for path in sorted((source / 'manhua_engine').rglob('*.py'))
                if path.name not in {'cli.py', 'translation.py', 'telemetry.py'}}
        code['adapter'] = file_hash(Path(__file__))
        code['contract'] = file_hash(Path(__file__).with_name('protocol.py'))
        code['alphabet'] = file_hash(source / 'manhua_engine/alphabet.txt')
        dependencies = {name: package_version(name) for name in ('ncnn', 'onnxruntime', 'numpy',
            'opencv-python', 'Pillow', 'networkx', 'shapely', 'rapidocr', 'uniseg', 'pyphen', 'fonttools')}
        self.version = 'manhua-ncnn-v1-' + digest({'code': code, 'models': model_hashes,
            'fonts': font_hashes, 'dependencies': dependencies,
            'options': {key: value for key, value in options.items() if key not in {'models', 'font', 'ocr_workers', 'threads', 'gpu'}},
            'device_backend': 'cpu' if options['gpu'] < 0 else 'vulkan'})[:32]
        self.engine = Engine(**options)

    def close(self):
        self.engine.close()

    def warmup(self):
        self.engine.warmup()

    def decode(self, data, metadata):
        if len(data) > MAX_IMAGE_BYTES or len(data) != metadata['byte_size']:
            raise NodeFailure('INPUT_INVALID')
        if hashlib.sha256(data).hexdigest() != metadata['sha256']:
            raise NodeFailure('INPUT_HASH_MISMATCH')
        with Image.open(BytesIO(data)) as image:
            if (image.size != (metadata['width'], metadata['height']) or image.width * image.height > MAX_PIXELS
                    or Image.MIME.get(image.format) != metadata['mime'] or getattr(image, 'n_frames', 1) != 1):
                raise NodeFailure('INPUT_INVALID')
            alpha = image.convert('RGBA').getchannel('A') if 'A' in image.getbands() or 'transparency' in image.info else None
            return np.array(image.convert('RGB')), alpha

    def analyze(self, rgb, input_hash):
        quads, segmentation = self.engine.detect(rgb)
        futures = [self.engine.ocr_pool.submit(self.engine.read_line, rgb, quad) for quad in quads]
        try:
            lines = [value for future in futures if (value := future.result()) is not None]
        finally:
            wait(futures)
        regions = group(lines, rgb.shape[1], rgb.shape[0], self.engine.ocr.language)
        mask = conservative_mask(regions, segmentation)
        if regions and not mask.any():
            raise NodeFailure('CLASSIC_ANALYZE_FAILED')
        analysis = {'version': self.version, 'input_hash': input_hash,
            'width': rgb.shape[1], 'height': rgb.shape[0],
            'segments': [{'id': str(index), 'source': region['text']} for index, region in enumerate(regions)],
            'regions': [{**region, 'lines': region['quads']} for region in regions],
            'mask': png64(Image.fromarray(mask), MAX_CHECKPOINT_BYTES) if regions else None}
        if (len(regions) > 200 or any(len(item['source']) > 4000 for item in analysis['segments'])
                or len(json.dumps(analysis).encode()) > MAX_CHECKPOINT_BYTES):
            raise NodeFailure('CLASSIC_ANALYZE_FAILED')
        return analysis

    def inpaint(self, rgb, analysis):
        mask = np.array(mask_image(analysis['mask'], (rgb.shape[1], rgb.shape[0])))
        return self.engine.remove(rgb, mask)[0]

    def render(self, cleaned, analysis, translated, language, alpha):
        if (translated['analysis_hash'] != digest(analysis) or translated['language'] != language
                or set(translated['translations']) != {item['id'] for item in analysis['segments']}):
            raise NodeFailure('CLASSIC_RENDER_FAILED')
        image = Image.fromarray(cleaned)
        areas = lettering_areas(cleaned, analysis['regions'])
        for segment, region, area in zip(analysis['segments'], analysis['regions'], areas):
            text = translated['translations'][segment['id']]
            if not isinstance(text, str) or not text.strip():
                raise NodeFailure('CLASSIC_RENDER_FAILED')
            fg, bg = resolve_colors(cleaned, region['bbox'])
            layout = draw_region(image, text, region, self.engine.font, fg, bg,
                                 target=language, direction=self.engine.direction, area=area)
            if not layout['rendered']:
                raise NodeFailure('CLASSIC_RENDER_FAILED')
        if not np.any(np.array(image) != cleaned):
            raise NodeFailure('CLASSIC_RENDER_FAILED')
        if alpha is not None:
            image.putalpha(alpha)
        return pack_result(image, self.version, analysis, translated)
