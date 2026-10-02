"""Bounded binary WebP tile artifact validation; no source pixels are retained here."""
import hashlib
from io import BytesIO
import json
import struct
from .image_metadata import image_metadata

MIME = 'application/vnd.nodelane.overlay-tiles'
MAGIC = b'NCOT0001'
MAX_MANIFEST = 256 * 1024


def verify_tiles(handle, result):
    header = handle.read(12)
    if len(header) != 12 or header[:8] != MAGIC:
        raise ValueError('Invalid tile container')
    length = struct.unpack('<I', header[8:])[0]
    if not 0 < length <= MAX_MANIFEST:
        raise ValueError('Invalid tile manifest')
    manifest = json.loads(handle.read(length))
    if (not isinstance(manifest, dict) or manifest.get('format') != 'overlay-tiles-v1' or manifest.get('input_sha256') != result['input_hash']
            or any(type(manifest.get(key)) is not int for key in ('width', 'height'))
            or (manifest.get('width'), manifest.get('height')) != (result['width'], result['height'])):
        raise ValueError('Invalid tile identity')
    tiles = manifest.get('tiles')
    if not isinstance(tiles, list) or not 0 < len(tiles) <= 4096:
        raise ValueError('Invalid tile count')
    boxes = []
    for tile in tiles:
        if not isinstance(tile, dict) or any(type(tile.get(key)) is not int for key in ('x', 'y', 'width', 'height', 'byte_size')):
            raise ValueError('Invalid tile metadata')
        x, y, width, height, size = (tile[key] for key in ('x', 'y', 'width', 'height', 'byte_size'))
        if (x < 0 or y < 0 or not 0 < width <= 2048 or not 0 < height <= 4096
                or x + width > result['width'] or y + height > result['height'] or not 0 < size <= result['output']['byte_size']):
            raise ValueError('Invalid tile bounds')
        if any(x < bx + bw and bx < x + width and y < by + bh and by < y + height for bx, by, bw, bh in boxes):
            raise ValueError('Overlapping tiles')
        boxes.append((x, y, width, height))
        data = handle.read(size)
        if len(data) != size or hashlib.sha256(data).hexdigest() != tile.get('sha256'):
            raise ValueError('Invalid tile digest')
        metadata = image_metadata(BytesIO(data))
        if metadata['mime'] != 'image/webp' or (metadata['width'], metadata['height']) != (width, height):
            raise ValueError('Invalid tile container')
    if handle.read(1):
        raise ValueError('Invalid tile length')
