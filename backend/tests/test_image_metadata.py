import hashlib
from io import BytesIO
import struct
import zlib

from fastapi import HTTPException
from PIL import Image
import pytest

from app.assets import inspect_image, inspect_image_file
from app.config import Settings
from app.image_metadata import image_metadata


def encoded(format, **options):
    stream = BytesIO()
    Image.new('RGB', (37, 61), '#aabbcc').save(stream, format, **options)
    return stream.getvalue()


@pytest.mark.parametrize('format,options', [('PNG', {}), ('JPEG', {}), ('JPEG', {'progressive': True}),
    ('WEBP', {}), ('WEBP', {'lossless': True})])
def test_center_reads_dimensions_and_hash_without_opening_a_pixel_decoder(monkeypatch, format, options):
    raw = encoded(format, **options)
    monkeypatch.setattr(Image, 'open', lambda *args, **kwargs: pytest.fail('Center must not create a pixel decoder'))
    info = inspect_image(raw)
    assert (info['width'], info['height']) == (37, 61)
    assert info['sha256'] == hashlib.sha256(raw).hexdigest() and info['byte_size'] == len(raw)
    assert inspect_image_file(BytesIO(raw)) == info


def png_chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def header_only_png(width, height):
    # Deliberately undecodable compressed pixels: the node must reject them.
    return b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + \
        png_chunk(b'IDAT', b'invalid compressed pixels') + png_chunk(b'IEND', b'')


def test_center_can_admit_huge_dimensions_without_allocating_or_inflating_pixels(monkeypatch):
    monkeypatch.setattr('app.assets.settings', lambda: Settings(_env_file=None))
    raw = header_only_png(100_000, 100_000)
    with pytest.raises(OSError):
        with Image.open(BytesIO(header_only_png(1, 1))) as image:
            image.load()
    info = inspect_image(raw)
    assert (info['width'], info['height']) == (100_000, 100_000)


@pytest.mark.parametrize('format', ['PNG', 'JPEG', 'WEBP'])
@pytest.mark.parametrize('metadata', ['orientation', 'icc'])
def test_input_normalization_is_checked_for_each_format_without_pixels(format, metadata):
    if metadata == 'orientation':
        exif = Image.Exif()
        exif[274] = 6
        raw = encoded(format, exif=exif)
    else:
        raw = encoded(format, icc_profile=b'profile')
    with pytest.raises(HTTPException) as error:
        inspect_image(raw)
    assert error.value.detail['code'] == 'INPUT_NOT_NORMALIZED'
    assert inspect_image(raw, output=True)['width'] == 37


@pytest.mark.parametrize('format', ['PNG', 'WEBP'])
def test_animated_inputs_are_rejected_without_pixels(format):
    stream = BytesIO()
    first, second = Image.new('RGB', (37, 61), 'white'), Image.new('RGB', (37, 61), 'black')
    first.save(stream, format, save_all=True, append_images=[second], duration=100)
    with pytest.raises(HTTPException) as error:
        inspect_image(stream.getvalue())
    assert error.value.detail['code'] == 'UNSUPPORTED_IMAGE'


@pytest.mark.parametrize('format', ['PNG', 'JPEG', 'WEBP'])
def test_truncated_containers_are_rejected_without_pixels(format):
    with pytest.raises(HTTPException) as error:
        inspect_image(encoded(format)[:-3])
    assert error.value.detail['code'] == 'UNSUPPORTED_IMAGE'


@pytest.mark.parametrize('progressive', [False, True])
@pytest.mark.parametrize('padding_size', [1, 2, 3, 64 * 1024 + 3])
def test_jpeg_record_padding_preserves_uploaded_size_and_hash(monkeypatch, progressive, padding_size):
    raw = encoded('JPEG', progressive=progressive) + b'\0' * padding_size
    with Image.open(BytesIO(raw)) as image:
        image.load()
    monkeypatch.setattr(Image, 'open', lambda *args, **kwargs: pytest.fail('Center must not decode pixels'))

    class BoundedFile(BytesIO):
        def read(self, size=-1):
            assert 0 <= size <= 64 * 1024
            return super().read(size)

    info = inspect_image_file(BoundedFile(raw))
    assert (info['width'], info['height'], info['mime']) == (37, 61, 'image/jpeg')
    assert info['byte_size'] == len(raw) and info['sha256'] == hashlib.sha256(raw).hexdigest()


@pytest.mark.parametrize('tail', [b'\0x', b'\0\xff\xd8', b'\0\xff\xd9'])
def test_jpeg_nonzero_trailing_data_is_still_rejected(tail):
    with pytest.raises(HTTPException) as error:
        inspect_image(encoded('JPEG') + tail)
    assert error.value.detail['code'] == 'UNSUPPORTED_IMAGE'


def test_jpeg_zero_padding_does_not_replace_missing_end_marker():
    with pytest.raises(HTTPException) as error:
        inspect_image(encoded('JPEG')[:-2] + b'\0' * 3)
    assert error.value.detail['code'] == 'UNSUPPORTED_IMAGE'


def test_png_crc_and_webp_riff_lengths_are_verified():
    png = bytearray(encoded('PNG'))
    png[-1] ^= 1
    with pytest.raises(ValueError):
        image_metadata(BytesIO(png))
    webp = bytearray(encoded('WEBP'))
    webp[4:8] = struct.pack('<I', len(webp))
    with pytest.raises(ValueError):
        image_metadata(BytesIO(webp))


def test_inspection_reads_image_payload_in_bounded_chunks():
    class BoundedFile(BytesIO):
        def read(self, size=-1):
            assert 0 <= size <= 64 * 1024
            return super().read(size)
    raw = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + \
        png_chunk(b'IDAT', b'x' * (1024 * 1024)) + png_chunk(b'IEND', b'')
    assert image_metadata(BoundedFile(raw))['width'] == 1


def test_jpeg_long_ff_padding_is_scanned_in_bounded_chunks():
    from app.image_metadata import _jpeg_marker
    class CountedFile(BytesIO):
        calls = 0
        def read(self, size=-1):
            assert 0 <= size <= 64 * 1024
            self.calls += 1
            return super().read(size)
    for scan in (False, True):
        stream = CountedFile(b'\xff' * (2 * 1024 * 1024) + b'\xd9')
        assert _jpeg_marker(stream, scan) == 0xd9
        assert stream.calls <= 34


def test_palette_transparency_and_normalized_exif_are_supported():
    palette = Image.new('P', (37, 61), 1)
    stream = BytesIO()
    palette.save(stream, 'PNG', transparency=1)
    assert inspect_image(stream.getvalue())['width'] == 37
    exif = Image.Exif()
    exif[274] = 1
    for format in ('PNG', 'JPEG', 'WEBP'):
        assert inspect_image(encoded(format, exif=exif))['height'] == 61
