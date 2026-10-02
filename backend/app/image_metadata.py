"""Bounded container inspection, without decompressing or allocating image pixels."""
import re
import struct
import zlib

MAX_METADATA_BYTES = 4 * 1024 * 1024
MAX_RECORDS = 65536
JPEG_MARKER = re.compile(b'\xff([^\xff])')


def _read(handle, count):
    data = handle.read(count)
    if len(data) != count:
        raise ValueError('Truncated image container')
    return data


def _orientation(data):
    if data.startswith(b'Exif\0\0'):
        data = data[6:]
    if len(data) < 8 or data[:2] not in (b'II', b'MM'):
        raise ValueError('Invalid EXIF header')
    endian = '<' if data[:2] == b'II' else '>'
    if struct.unpack_from(endian + 'H', data, 2)[0] != 42:
        raise ValueError('Invalid EXIF header')
    offset = struct.unpack_from(endian + 'I', data, 4)[0]
    if offset < 8 or offset + 2 > len(data):
        raise ValueError('Invalid EXIF directory')
    count = struct.unpack_from(endian + 'H', data, offset)[0]
    if offset + 2 + count * 12 + 4 > len(data):
        raise ValueError('Truncated EXIF directory')
    orientation = 1
    for index in range(count):
        entry = offset + 2 + index * 12
        tag, kind, length = struct.unpack_from(endian + 'HHI', data, entry)
        if tag == 274:
            if kind != 3 or length != 1:
                raise ValueError('Invalid EXIF orientation')
            orientation = struct.unpack_from(endian + 'H', data, entry + 8)[0]
            if not 1 <= orientation <= 8:
                raise ValueError('Invalid EXIF orientation')
    return orientation


def _metadata(handle, count):
    if count > MAX_METADATA_BYTES:
        raise ValueError('Image metadata exceeds limit')
    return _read(handle, count)


def _png(handle, length):
    _read(handle, 8)
    width = height = None
    color = None
    icc, orientation = False, 1
    image_bytes, image_ended, palette = 0, False, False
    animation_header, frame_header = False, False
    for index in range(MAX_RECORDS):
        size, kind = struct.unpack('>I4s', _read(handle, 8))
        if size > length - handle.tell() - 4 or not re.fullmatch(b'[A-Za-z]{4}', kind):
            raise ValueError('Invalid PNG chunk')
        if index == 0 and (kind != b'IHDR' or size != 13):
            raise ValueError('Invalid PNG header')
        if kind == b'IHDR' and index != 0:
            raise ValueError('Duplicate PNG header')
        if kind[0] & 32 == 0 and kind not in (b'IHDR', b'PLTE', b'IDAT', b'IEND'):
            raise ValueError('Unknown critical PNG chunk')
        if kind == b'IDAT':
            if image_ended:
                raise ValueError('Nonconsecutive PNG image chunks')
            image_bytes += size
        elif image_bytes:
            image_ended = True
        if kind in (b'IHDR', b'eXIf', b'acTL', b'fcTL'):
            data = _metadata(handle, size)
            checksum = zlib.crc32(data, zlib.crc32(kind))
        else:
            checksum = zlib.crc32(kind)
            remaining = size
            while remaining:
                data = _read(handle, min(remaining, 64 * 1024))
                checksum = zlib.crc32(data, checksum)
                remaining -= len(data)
        if struct.unpack('>I', _read(handle, 4))[0] != checksum & 0xffffffff:
            raise ValueError('Invalid PNG checksum')
        if kind == b'IHDR':
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', data)
            allowed = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            if depth not in allowed.get(color, ()) or compression or filtering or interlace not in (0, 1):
                raise ValueError('Invalid PNG image header')
        elif kind == b'PLTE':
            if palette or image_bytes or not 0 < size <= 768 or size % 3:
                raise ValueError('Invalid PNG palette')
            palette = True
        elif kind == b'iCCP':
            icc = icc or bool(size)
        elif kind == b'eXIf':
            value = _orientation(data)
            orientation = value if value != 1 else orientation
        elif kind == b'acTL':
            if animation_header or size != 8 or struct.unpack_from('>I', data)[0] != 1:
                raise ValueError('Animated PNG is unsupported')
            animation_header = True
        elif kind == b'fcTL':
            if frame_header or not animation_header or size != 26 or struct.unpack_from('>II', data, 4) != (width, height):
                raise ValueError('Invalid PNG frame')
            frame_header = True
        elif kind == b'fdAT':
            raise ValueError('Animated PNG is unsupported')
        elif kind == b'IEND':
            if size or not image_bytes or color == 3 and not palette or handle.tell() != length:
                raise ValueError('Invalid PNG image length')
            return width, height, icc, orientation
    raise ValueError('PNG chunk count exceeds limit')


def _jpeg_marker(handle, scan):
    if not scan:
        if _read(handle, 1) != b'\xff':
            raise ValueError('Invalid JPEG marker')
        while chunk := handle.read(64 * 1024):
            start = handle.tell() - len(chunk)
            offset = len(chunk) - len(chunk.lstrip(b'\xff'))
            if offset == len(chunk):
                continue
            value = chunk[offset]
            handle.seek(start + offset + 1)
            if value == 0:
                raise ValueError('Invalid JPEG marker')
            return value
        raise ValueError('Missing JPEG marker')
    carry = b''
    while chunk := handle.read(64 * 1024):
        start = handle.tell() - len(chunk) - len(carry)
        data = carry + chunk
        for match in JPEG_MARKER.finditer(data):
            value = match[1][0]
            if value != 0 and not 0xd0 <= value <= 0xd7:
                handle.seek(start + match.end())
                return value
        carry = b'\xff' if data.endswith(b'\xff') else b''
    raise ValueError('Missing JPEG end marker')


def _jpeg(handle, length):
    if _read(handle, 2) != b'\xff\xd8':
        raise ValueError('Invalid JPEG header')
    width = height = None
    icc, orientation, scan, saw_scan = False, 1, False, False
    frames = {0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf}
    for _ in range(MAX_RECORDS):
        marker = _jpeg_marker(handle, scan)
        scan = False
        if marker == 0xd9:
            if width is None or not saw_scan or handle.tell() != length:
                raise ValueError('Invalid JPEG image length')
            return width, height, icc, orientation
        if marker == 0xd8 or 0xd0 <= marker <= 0xd7:
            raise ValueError('Invalid JPEG marker ordering')
        if marker == 1:
            continue
        size = struct.unpack('>H', _read(handle, 2))[0] - 2
        if size < 0 or size > length - handle.tell():
            raise ValueError('Invalid JPEG segment')
        if marker in frames or marker in (0xe1, 0xe2, 0xda):
            data = _read(handle, size)
        else:
            handle.seek(size, 1)
        if marker in frames:
            if width is not None or size < 6:
                raise ValueError('Invalid JPEG frame')
            height, width, components = struct.unpack_from('>HHB', data, 1)
            if not 1 <= components <= 4 or size != 6 + components * 3:
                raise ValueError('Invalid JPEG components')
        elif marker == 0xe1 and data.startswith(b'Exif\0\0'):
            value = _orientation(data)
            orientation = value if value != 1 else orientation
        elif marker == 0xe2 and data.startswith(b'ICC_PROFILE\0'):
            icc = True
        elif marker == 0xda:
            if width is None or size < 6 or size != 4 + 2 * data[0]:
                raise ValueError('Invalid JPEG scan')
            scan, saw_scan = True, True
    raise ValueError('JPEG marker count exceeds limit')


def _webp(handle, length):
    header = _read(handle, 12)
    if header[:4] != b'RIFF' or header[8:] != b'WEBP' or struct.unpack_from('<I', header, 4)[0] + 8 != length:
        raise ValueError('Invalid WebP container')
    canvas = image_size = None
    icc, orientation = False, 1
    for index in range(MAX_RECORDS):
        if handle.tell() == length:
            if image_size is None or canvas is not None and canvas != image_size:
                raise ValueError('Invalid WebP dimensions')
            return *image_size, icc, orientation
        kind, size = struct.unpack('<4sI', _read(handle, 8))
        if size + (size & 1) > length - handle.tell():
            raise ValueError('Invalid WebP chunk length')
        start = handle.tell()
        if kind == b'VP8X':
            data = _read(handle, 10) if size == 10 else b''
            if index or canvas is not None or len(data) != 10 or data[0] & 0xc3 or any(data[1:4]):
                raise ValueError('Invalid or animated WebP header')
            canvas = (int.from_bytes(data[4:7], 'little') + 1, int.from_bytes(data[7:10], 'little') + 1)
        elif kind in (b'VP8 ', b'VP8L'):
            if image_size is not None:
                raise ValueError('Multiple WebP frames')
            if kind == b'VP8 ':
                data = _read(handle, 10) if size >= 10 else b''
                if len(data) != 10 or data[0] & 1 or data[3:6] != b'\x9d\x01\x2a':
                    raise ValueError('Invalid WebP bitstream header')
                image_size = tuple(value & 0x3fff for value in struct.unpack_from('<HH', data, 6))
            else:
                data = _read(handle, 5) if size >= 5 else b''
                if len(data) != 5 or data[0] != 0x2f:
                    raise ValueError('Invalid lossless WebP header')
                bits = int.from_bytes(data[1:], 'little')
                if bits >> 29:
                    raise ValueError('Unsupported lossless WebP version')
                image_size = ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
        elif kind in (b'ANIM', b'ANMF'):
            raise ValueError('Animated WebP is unsupported')
        elif kind == b'ICCP':
            icc = icc or bool(size)
        elif kind == b'EXIF':
            value = _orientation(_metadata(handle, size))
            orientation = value if value != 1 else orientation
        handle.seek(start + size + (size & 1))
    raise ValueError('WebP chunk count exceeds limit')


def image_metadata(handle):
    """Return container dimensions and normalization metadata; leave pixels to nodes."""
    handle.seek(0, 2)
    length = handle.tell()
    handle.seek(0)
    signature = handle.read(12)
    handle.seek(0)
    if signature.startswith(b'\x89PNG\r\n\x1a\n'):
        mime, parser = 'image/png', _png
    elif signature.startswith(b'\xff\xd8'):
        mime, parser = 'image/jpeg', _jpeg
    elif signature[:4] == b'RIFF' and signature[8:12] == b'WEBP':
        mime, parser = 'image/webp', _webp
    else:
        raise ValueError('Unsupported image container')
    width, height, icc, orientation = parser(handle, length)
    if not width or not height:
        raise ValueError('Invalid image dimensions')
    handle.seek(0)
    return {'width': width, 'height': height, 'mime': mime, 'icc_profile': icc, 'orientation': orientation}
