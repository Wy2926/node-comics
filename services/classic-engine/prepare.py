"""Pin model bytes; remove eager imports of unused translators and bundled system fonts."""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

ROOT = Path(os.environ.get('MIT_ROOT', '/opt/mit'))
RESOURCES = [
    ('detection/detect-20241225.ckpt', 'https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/detect-20241225.ckpt', '67ce1c4ed4793860f038c71189ba9630a7756f7683b1ee5afb69ca0687dc502e'),
    ('ocr/ocr_ar_48px.ckpt', 'https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/ocr_ar_48px.ckpt', '29daa46d080818bb4ab239a518a88338cbccff8f901bef8c9db191a7cb97671d'),
    ('ocr/alphabet-all-v7.txt', 'https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/alphabet-all-v7.txt', 'f5722368146aa0fbcc9f4726866e4efc3203318ebb66c811d8cbbe915576538a'),
    ('inpainting/lama_large_512px.ckpt', 'https://huggingface.co/dreMaz/AnimeMangaInpainting/resolve/main/lama_large_512px.ckpt', '11d30fbb3000fb2eceae318b75d9ced9229d99ae990a7f8b3ac35c8d31f2c935'),
]


def sha(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def prepare_source():
    for package in ('', 'detection', 'ocr', 'inpainting'):
        (ROOT / 'manga_translator' / package / '__init__.py').write_text('# Node Comics: direct stage imports only.\n')
    # Renderer fallback fonts must all have known redistributable provenance.
    for path in (ROOT / 'fonts').iterdir():
        if path.is_file() and path.name != 'NotoSansMonoCJK-VF.ttf.ttc':
            path.unlink()


def prepare_models():
    base = Path(os.environ.get('MODEL_DIR', '/models'))
    records = []
    for relative, url, expected in RESOURCES:
        path = base / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists() or sha(path) != expected:
            temp = path.with_suffix('.download')
            print('Downloading model:', path.name, flush=True)
            with urllib.request.urlopen(url, timeout=120) as source, temp.open('wb') as destination:
                while chunk := source.read(1024 * 1024):
                    destination.write(chunk)
            if sha(temp) != expected:
                raise RuntimeError('Model checksum mismatch: ' + path.name)
            temp.replace(path)
        records.append({'file': relative, 'source': url, 'sha256': expected})
    font = ROOT / 'fonts/NotoSansMonoCJK-VF.ttf.ttc'
    if sha(font) != 'b861b923e105a437f30ce12573350e899ee75766c4a6e9eef6d46788fb839e76':
        raise RuntimeError('Font checksum mismatch')
    records.append({'file': str(font), 'source': 'manga-image-translator@95227a2/fonts/NotoSansMonoCJK-VF.ttf.ttc', 'sha256': sha(font)})
    (base / 'manifest.json').write_text(json.dumps(records, indent=2))


if __name__ == '__main__':
    if '--source-only' in sys.argv:
        prepare_source()
    else:
        prepare_models()
