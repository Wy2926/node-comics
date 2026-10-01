"""Offline build-time verification; does not claim GPU or center readiness."""
import hashlib
import json
from pathlib import Path


def verify(root):
    import importlib.util
    from importlib.metadata import version
    import onnxruntime as ort
    from PIL import features
    from classic_node.runtime import LANGUAGE_PROBES, model_identity
    from manhua_engine.layout import coverage
    if version('ncnn') != '1.0.20260526+nodegil1':
        raise ValueError('Linux runtime requires the GIL-releasing NCNN build')
    if 'CUDAExecutionProvider' not in ort.get_available_providers() or not features.check('webp'):
        raise ValueError('Runtime requires the CUDA provider and WebP support')
    if any(importlib.util.find_spec(name) is not None for name in ('torch', 'pnnx')):
        raise ValueError('Conversion dependencies must not enter the runtime image')
    manifest = json.loads((root / 'release.json').read_text())
    for name, checksum in manifest['files'].items():
        with (root / name).open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != checksum:
                raise ValueError(f'Asset checksum mismatch: {name}')
    for language in ('auto', 'en', 'zh', 'ko', 'latin'):
        model_identity(root / 'models', language)
    cmap = set().union(*(coverage(root / name) for name in manifest['fonts']))
    for language, probe in LANGUAGE_PROBES.items():
        if not set(map(ord, probe.replace(' ', ''))) <= cmap:
            raise ValueError(f'Missing font coverage: {language}')
    print('Verified model hashes and font coverage; GPU readiness requires check on the target host.')


if __name__ == '__main__':
    verify(Path('/opt/node'))
