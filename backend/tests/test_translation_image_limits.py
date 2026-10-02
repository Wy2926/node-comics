from io import BytesIO

import pytest
from fastapi import HTTPException
from PIL import Image

from app.assets import inspect_image, inspect_image_file
from app.config import Settings


def png(width, height):
    stream = BytesIO()
    Image.new('RGB', (width, height), 'white').save(stream, 'PNG')
    stream.seek(0)
    return stream


def test_center_defaults_allow_ordinary_strips(monkeypatch):
    cfg = Settings(_env_file=None)
    assert (cfg.max_dimension, cfg.max_upload_bytes) == (100_000, 128 * 1024 * 1024)
    monkeypatch.setattr('app.assets.settings', lambda: cfg)
    info = inspect_image_file(png(800, 12000))
    assert (info['width'], info['height']) == (800, 12000)


@pytest.mark.parametrize('size', [(800, 16001), (1, 100_000)])
def test_center_allows_long_images_through_the_dimension_boundary(monkeypatch, size):
    monkeypatch.setattr('app.assets.settings', lambda: Settings(_env_file=None))
    info = inspect_image_file(png(*size))
    assert (info['width'], info['height']) == size


def test_center_has_no_independent_pixel_limit(monkeypatch):
    monkeypatch.setattr('app.assets.settings', lambda: Settings(_env_file=None))
    stream = png(6000, 6000)
    assert inspect_image_file(stream)['width'] == 6000
    assert inspect_image(stream.getvalue())['height'] == 6000


def test_center_rejects_excessive_dimension_before_loading(monkeypatch):
    size = (1, 100_001)
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
