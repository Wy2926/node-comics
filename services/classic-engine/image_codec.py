"""Image byte conversion, independent of models and Qt."""
import base64
from io import BytesIO
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = 24_000_000


def decode(value, mode='RGB'):
    if not isinstance(value, str) or len(value) > 32 * 1024 * 1024:
        raise ValueError('Image size')
    raw = base64.b64decode(value, validate=True)
    if len(raw) > 24 * 1024 * 1024:
        raise ValueError('Image size')
    with Image.open(BytesIO(raw)) as image:
        if image.width * image.height > 24_000_000 or max(image.size) > 8192 or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('Image dimensions')
        return np.array(image.convert(mode))


def png(array):
    output = BytesIO()
    Image.fromarray(array).save(output, 'PNG')
    return base64.b64encode(output.getvalue()).decode()
