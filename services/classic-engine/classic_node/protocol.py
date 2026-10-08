"""Shared wire encoding. Never include arbitrary server/engine errors in logs."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import struct
from PIL import Image
from time import perf_counter
from .timing import record, stage

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


def tiled_output(width, height):
    return width * height > 2048 * 4096 or max(width, height) > 16383


def _visible_diff(final, original, alpha):
    """Shared exact diff/bounds for a whole page or one disjoint output tile."""
    import numpy as np
    changed = np.any(final != original, axis=2)
    if alpha is not None:
        changed &= np.asarray(alpha) > 0
    ys, xs = np.flatnonzero(changed.any(axis=1)), np.flatnonzero(changed.any(axis=0))
    bounds = (int(xs[0]), int(ys[0]), int(xs[-1]) + 1, int(ys[-1]) + 1) if len(xs) else None
    return changed, bounds


def pack_result(final, original, alpha, version, analysis, translated, *, allow_tiles=False, output_workers=1):
    """Final RGB replacement pixels; the browser preserves source alpha with source-atop."""
    started = perf_counter()
    height, width = final.shape[:2]
    result = {
        'version': version, 'input_hash': analysis['input_hash'],
        'analysis_hash': translated['analysis_hash'], 'translations_revision': translated['revision'],
        'representation': 'original', 'normalization_version': 1,
        'width': width, 'height': height, 'bbox': None, 'output': None}
    # Large negotiated pages are partitioned before diffing. Qt still lays out
    # the whole page once; only disjoint final pixels are processed in parallel.
    if allow_tiles and tiled_output(width, height):
        record('render_diff', perf_counter() - started)
        with stage('render_encode'):
            return _pack_tiled(final, original, alpha, result, output_workers)
    changed, bounds = _visible_diff(final, original, alpha)
    if bounds is None:
        record('render_diff', perf_counter() - started)
        return {'output_bytes': None, 'result': result}
    x, y, right, bottom = bounds
    if max(right - x, bottom - y) > 16383:
        raise NodeFailure('CLASSIC_OUTPUT_TOO_LARGE')
    record('render_diff', perf_counter() - started)
    started = perf_counter()
    data = encode_patch(final[y:bottom, x:right], changed[y:bottom, x:right])
    record('render_encode', perf_counter() - started)
    result.update(representation='overlay-v1', bbox={'x': x, 'y': y, 'width': right - x, 'height': bottom - y},
        output={'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data),
                'width': right - x, 'height': bottom - y, 'mime': 'image/webp'})
    return {'output_bytes': data, 'result': result}


def _pack_tiled(final, original, alpha, result, workers):
    import numpy as np
    height, width = final.shape[:2]
    alpha = np.asarray(alpha) if alpha is not None else None
    positions = [(x, y, min(width, x + 2048), min(height, y + 4096))
                 for y in range(0, height, 4096) for x in range(0, width, 2048)]
    workers = max(1, min(int(workers), len(positions)))

    def encode(position):
        x, y, right, bottom = position
        tick = perf_counter()
        pixels = final[y:bottom, x:right]
        changed, bounds = _visible_diff(pixels, original[y:bottom, x:right],
                                        alpha[y:bottom, x:right] if alpha is not None else None)
        if bounds is None:
            return None, None, perf_counter() - tick, 0.
        left, top, end_x, end_y = bounds
        diff_seconds = perf_counter() - tick
        tick = perf_counter()
        data = encode_patch(pixels[top:end_y, left:end_x], changed[top:end_y, left:end_x])
        tile = {'x': x + left, 'y': y + top, 'width': end_x - left, 'height': end_y - top,
                'sha256': hashlib.sha256(data).hexdigest(), 'byte_size': len(data)}
        return tile, data, diff_seconds, perf_counter() - tick

    tiles, bodies, size = [], [], 0
    def accept(rows):
        nonlocal size
        for tile, data, diff, encoding in rows:
            # Worker sums are diagnostic, not elapsed wall time.
            record('render_tile_diff_sum', diff)
            record('render_tile_encode_sum', encoding)
            if tile is None:
                continue
            size += len(data)
            if size > MAX_RESULT_BYTES or len(tiles) >= 4096:
                raise NodeFailure('CLASSIC_OUTPUT_TOO_LARGE')
            tiles.append(tile)
            bodies.append(data)
    if workers == 1:
        accept(map(encode, positions))
    else:
        with ThreadPoolExecutor(workers, thread_name_prefix='encode') as pool:
            # Only one bounded window can retain unfinished encoded bodies.
            for start in range(0, len(positions), workers):
                accept(pool.map(encode, positions[start:start + workers]))
    record('render_output_workers', workers)
    record('render_output_tiles', len(tiles))
    if not tiles:
        return {'output_bytes': None, 'result': result}
    if len(tiles) == 1:
        tile, data = tiles[0], bodies[0]
        result.update(representation='overlay-v1', bbox={k: tile[k] for k in ('x', 'y', 'width', 'height')},
            output={k: tile[k] for k in ('sha256', 'byte_size', 'width', 'height')})
        result['output']['mime'] = 'image/webp'
        return {'output_bytes': data, 'result': result}
    manifest = json.dumps({'format': 'overlay-tiles-v1', 'input_sha256': result['input_hash'],
        'width': width, 'height': height, 'tiles': tiles}, separators=(',', ':')).encode()
    if len(manifest) > 256 * 1024 or size + len(manifest) + 12 > MAX_RESULT_BYTES:
        raise NodeFailure('CLASSIC_OUTPUT_TOO_LARGE')
    data = b'NCOT0001' + struct.pack('<I', len(manifest)) + manifest + b''.join(bodies)
    result.update(representation='overlay-tiles-v1', output={'sha256': hashlib.sha256(data).hexdigest(),
        'byte_size': len(data), 'width': width, 'height': height, 'mime': 'application/vnd.nodelane.overlay-tiles'})
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


def mask_image(value, size, *, allow_empty=False):
    if not isinstance(value, str) or len(value) > ((MAX_CHECKPOINT_BYTES + 2) // 3) * 4:
        raise NodeFailure('INPUT_INVALID')
    mask = None
    try:
        data = base64.b64decode(value, validate=True)
        with Image.open(BytesIO(data)) as image:
            if image.format != 'PNG' or image.size != size or getattr(image, 'n_frames', 1) != 1:
                raise ValueError('Invalid mask dimensions')
            mask = image.convert('L')
            if not allow_empty and not mask.getbbox():
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
