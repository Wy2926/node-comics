"""Shared wire encoding. Never include arbitrary server/engine errors in logs."""
import base64
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
from PIL import Image

MAX_IMAGE_BYTES = 24 * 1024 * 1024
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
