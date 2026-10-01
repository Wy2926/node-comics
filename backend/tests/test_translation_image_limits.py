from io import BytesIO

import pytest
from fastapi import HTTPException
from PIL import Image

from app.assets import inspect_image_file
from app.config import Settings


def png(width, height):
    stream = BytesIO()
    Image.new('RGB', (width, height), 'white').save(stream, 'PNG')
    stream.seek(0)
    return stream


def test_center_defaults_allow_ordinary_strips(monkeypatch):
    cfg = Settings(_env_file=None)
    assert (cfg.max_dimension, cfg.max_pixels, cfg.max_upload_bytes) == (16000, 32_000_000, 128 * 1024 * 1024)
    monkeypatch.setattr('app.assets.settings', lambda: cfg)
    info = inspect_image_file(png(800, 12000))
    assert (info['width'], info['height']) == (800, 12000)


@pytest.mark.parametrize('size', [(800, 16001), (6000, 6000)])
def test_center_rejects_excessive_dimensions_or_pixels_before_loading(monkeypatch, size):
    stream = png(*size)
    monkeypatch.setattr('app.assets.settings', lambda: Settings(_env_file=None))
    with pytest.raises(HTTPException) as error:
        inspect_image_file(stream)
    assert error.value.status_code == 413
    assert error.value.detail['code'] == 'IMAGE_TOO_LARGE'


def test_center_still_enforces_configured_stream_bytes(monkeypatch):
    monkeypatch.setattr('app.assets.settings', lambda: Settings(_env_file=None, max_upload_bytes=2))
    with pytest.raises(HTTPException) as error:
        inspect_image_file(BytesIO(b'too long'))
    assert error.value.detail['code'] == 'IMAGE_TOO_LARGE'
