"""Shared wire encoding. Never include arbitrary server/engine errors in logs."""
import base64
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
from PIL import Image
from time import perf_counter
from manhua_engine.timing import record

MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_RESULT_BYTES = 88 * 1024 * 1024
MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024
MAX_PIXELS = 24_000_000


def digest(value):
    # Same canonical JSON as backend.app.providers.digest.
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('UTC timestamp required')
    return parsed.timestamp()


def png64(image, limit=MAX_IMAGE_BYTES):
    out = BytesIO()
    image.save(out, format='PNG', compress_level=1)
    if out.tell() > limit:
        raise NodeFailure('INPUT_INVALID')
    return base64.b64encode(out.getvalue()).decode('ascii')


def pack_result(image, original, alpha, version, analysis, translated):
    """Final RGB replacement pixels; the browser preserves source alpha with source-atop."""
    import numpy as np
    started = perf_counter()
    final = np.asarray(image.convert('RGB'))
    changed = np.any(final != original, axis=2)
    if alpha is not None:
        changed &= np.asarray(alpha) > 0
    result = {
        'version': version, 'input_hash': analysis['input_hash'],
        'analysis_hash': translated['analysis_hash'], 'translations_revision': translated['revision'],
        'representation': 'original', 'normalization_version': 1,
        'width': image.width, 'height': image.height, 'bbox': None, 'output': None}
    if not changed.any():
        record('render_diff', perf_counter() - started)
        return {'output_bytes': None, 'result': result}
    ys, xs = np.flatnonzero(changed.any(axis=1)), np.flatnonzero(changed.any(axis=0))
    x, y, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    mask = changed[y:bottom, x:right]
    patch = np.zeros((bottom - y, right - x, 4), dtype=np.uint8)
    patch[..., :3][mask] = final[y:bottom, x:right][mask]
    patch[..., 3][mask] = 255
    record('render_diff', perf_counter() - started)
    started = perf_counter()
    stream = BytesIO()
    try:
        Image.fromarray(patch).save(stream, format='WEBP', lossless=True, method=4, exact=False)
    except (OSError, ValueError) as error:
        raise NodeFailure('CLASSIC_OUTPUT_ENCODE_FAILED') from error
    data = stream.getvalue()
    record('render_encode', perf_counter() - started)
    if len(data) > MAX_RESULT_BYTES:
        raise NodeFailure('CLASSIC_OUTPUT_TOO_LARGE')
    result.update(representation='overlay-v1', bbox={'x': x, 'y': y, 'width': right - x, 'height': bottom - y},
        output={'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data),
                'width': right - x, 'height': bottom - y, 'mime': 'image/webp'})
    return {'output_bytes': data, 'result': result}


def mask_image(value, size):
    if not isinstance(value, str) or len(value) > ((MAX_CHECKPOINT_BYTES + 2) // 3) * 4:
        raise NodeFailure('INPUT_INVALID')
    data = base64.b64decode(value, validate=True)
    with Image.open(BytesIO(data)) as image:
        if image.format != 'PNG' or image.size != size:
            raise NodeFailure('INPUT_INVALID')
        return image.convert('L')


class NodeFailure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class ControlFailure(NodeFailure):
    def __init__(self, code, status=0):
        self.status = status
        super().__init__(code)
