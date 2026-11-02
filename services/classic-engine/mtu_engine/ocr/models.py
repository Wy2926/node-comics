"""Pinned, self-contained Xiaomi INT8 artifact verification."""
import hashlib
import json
from pathlib import Path

MODEL_ID = 'xiaomi-research/Xiaomi-OCR-0'
MODEL_REVISION = 'bbd8cf8d21f256b3644b44cb860f3a7cecb93c30'
MODEL_SHA256 = 'd4551e9f6127ac9e35cff7b4f7a72a90410e03e6c8676a36f0e2b7eaeb5d5348'
PROCESSOR_FILES = ('processor_config.json', 'tokenizer_config.json', 'tokenizer.json', 'chat_template.jinja')


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_mlx(directory):
    directory = Path(directory).resolve()
    manifest = json.loads((directory / 'conversion-source.json').read_text())
    config = json.loads((directory / 'config.json').read_text())
    required = {'config.json', 'model.safetensors', 'model.safetensors.index.json',
                'SOURCE-README.md', *PROCESSOR_FILES}
    if (manifest['source_sha256'] != MODEL_SHA256 or manifest['source_revision'] != MODEL_REVISION
            or not required <= manifest['files'].keys() or manifest['bits'] != 8
            or config['quantization']['bits'] != 8 or config['quantization']['group_size'] != 64):
        raise ValueError('Expected prepared Xiaomi MLX quantization')
    for name, info in manifest['files'].items():
        path = (directory / name).resolve()
        if not path.is_relative_to(directory) or digest(path) != info['sha256']:
            raise ValueError('OCR artifact checksum mismatch')
    return {'backend': 'mlx8', 'manifest_sha256': digest(directory / 'conversion-source.json')}
