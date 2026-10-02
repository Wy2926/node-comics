"""Shared wire encoding. Never include arbitrary server/engine errors in logs."""
import base64
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import struct
from PIL import Image
from time import perf_counter
from manhua_engine.timing import record

# png64 utility budget only; input admission is owned by the center.
MAX_MASK_BYTES = 24 * 1024 * 1024
MAX_RESULT_BYTES = 88 * 1024 * 1024
MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024


def digest(value):
    # Same canonical JSON as backend.app.providers.digest.
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('UTC timestamp required')
    return parsed.timestamp()


def png64(image, limit=MAX_MASK_BYTES):
    out = BytesIO()
    image.save(out, format='PNG', compress_level=1)
    if out.tell() > limit:
        raise NodeFailure('INPUT_INVALID')
    return base64.b64encode(out.getvalue()).decode('ascii')


def pack_result(image, original, alpha, version, analysis, translated, *, allow_tiles=False):
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
    if max(right - x, bottom - y) > 16383:
        if not allow_tiles:
            raise NodeFailure('CLASSIC_OUTPUT_TOO_LARGE')
        tiles, bodies, byte_size = [], [], 0
        record('render_diff', perf_counter() - started)
        started = perf_counter()
        # The full page is already rendered. Only final replacement pixels are partitioned.
        for top in range(y, bottom, 4096):
            for left in range(x, right, 2048):
                mask = changed[top:min(top + 4096, bottom), left:min(left + 2048, right)]
                if not mask.any():
                    continue
                ty, tx = np.flatnonzero(mask.any(axis=1)), np.flatnonzero(mask.any(axis=0))
                bx, by = left + int(tx.min()), top + int(ty.min())
                bw, bh = int(tx.max() - tx.min()) + 1, int(ty.max() - ty.min()) + 1
                data = encode_patch(final[by:by + bh, bx:bx + bw], changed[by:by + bh, bx:bx + bw])
                byte_size += len(data)
                if byte_size > MAX_RESULT_BYTES or len(tiles) >= 4096:
                    raise NodeFailure('CLASSIC_OUTPUT_TOO_LARGE')
                tiles.append({'x': bx, 'y': by, 'width': bw, 'height': bh,
                    'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data)})
                bodies.append(data)
        manifest = json.dumps({'format': 'overlay-tiles-v1', 'input_sha256': analysis['input_hash'],
            'width': image.width, 'height': image.height, 'tiles': tiles}, separators=(',', ':')).encode()
        if len(manifest) > 256 * 1024 or byte_size + len(manifest) + 12 > MAX_RESULT_BYTES:
            raise NodeFailure('CLASSIC_OUTPUT_TOO_LARGE')
        data = b'NCOT0001' + struct.pack('<I', len(manifest)) + manifest + b''.join(bodies)
        record('render_encode', perf_counter() - started)
        result.update(representation='overlay-tiles-v1', output={'sha256': hashlib.sha256(data).hexdigest(),
            'byte_size': len(data), 'width': image.width, 'height': image.height,
            'mime': 'application/vnd.nodelane.overlay-tiles'})
        return {'output_bytes': data, 'result': result}
    record('render_diff', perf_counter() - started)
    started = perf_counter()
    data = encode_patch(final[y:bottom, x:right], changed[y:bottom, x:right])
    record('render_encode', perf_counter() - started)
    result.update(representation='overlay-v1', bbox={'x': x, 'y': y, 'width': right - x, 'height': bottom - y},
        output={'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data),
                'width': right - x, 'height': bottom - y, 'mime': 'image/webp'})
    return {'output_bytes': data, 'result': result}


def encode_patch(rgb, mask):
    import numpy as np
    patch = np.zeros((*mask.shape, 4), dtype=np.uint8)
    patch[..., :3][mask] = rgb[mask]
    patch[..., 3][mask] = 255
    stream = BytesIO()
    try:
        with Image.fromarray(patch) as image:
            image.save(stream, format='WEBP', lossless=True, method=4, quality=10, exact=False)
        del patch
        data = stream.getvalue()
        if len(data) > MAX_RESULT_BYTES:
            raise NodeFailure('CLASSIC_OUTPUT_TOO_LARGE')
        # Validate before freezing. The center never decodes output pixels.
        with Image.open(BytesIO(data)) as image:
            if image.format != 'WEBP' or image.size != (mask.shape[1], mask.shape[0]) or getattr(image, 'n_frames', 1) != 1:
                raise ValueError('Invalid encoded patch')
            image.load()
            if image.mode == 'RGBA':
                with image.getchannel('A') as alpha:
                    histogram = alpha.histogram()
                if any(histogram[1:255]) or not histogram[255]:
                    raise ValueError('Invalid replacement alpha')
            elif image.mode != 'RGB':
                raise ValueError('Invalid encoded patch mode')
    except (OSError, ValueError) as error:
        raise NodeFailure('CLASSIC_OUTPUT_ENCODE_FAILED') from error
    return data


def mask_image(value, size):
    if not isinstance(value, str) or len(value) > ((MAX_CHECKPOINT_BYTES + 2) // 3) * 4:
        raise NodeFailure('INPUT_INVALID')
    mask = None
    try:
        data = base64.b64decode(value, validate=True)
        with Image.open(BytesIO(data)) as image:
            if image.format != 'PNG' or image.size != size or getattr(image, 'n_frames', 1) != 1:
                raise ValueError('Invalid mask dimensions')
            mask = image.convert('L')
            if not mask.getbbox():
                raise ValueError('Empty mask')
            return mask
    except (OSError, ValueError, SyntaxError) as error:
        if mask is not None:
            mask.close()
        raise NodeFailure('CLASSIC_OCR_INVALID') from error


class NodeFailure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class ControlFailure(NodeFailure):
    def __init__(self, code, status=0):
        self.status = status
        super().__init__(code)
