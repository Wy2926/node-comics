"""Generate original, non-private comic import fixtures (Pillow + ReportLab).

RAR fixtures contain stored data and hand-authored test headers, not a compressor.
RAR5 header fields: https://www.rarlab.com/technote.htm
Outputs live under ignored artifacts/import-validation, never in a user's library.
"""
from pathlib import Path
from io import BytesIO
import struct
import zlib
import zipfile
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.lib.pdfencrypt import StandardEncryption

ROOT = Path(__file__).resolve().parents[1] / "artifacts/import-validation"
ROOT.mkdir(parents=True, exist_ok=True)


def vint(n):
    out = bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    return bytes(out + bytes([n]))


def block5(body):
    header = vint(len(body)) + body
    return struct.pack('<I', zlib.crc32(header)) + header


def block4(kind, flags, body):
    header = struct.pack('<BHH', kind, flags, len(body) + 7) + body
    return struct.pack('<H', zlib.crc32(header) & 65535) + header


entries = []
for n, color in [(10, '#cdf4df'), (2, '#dae9ff'), (1, '#ffe0ed')]:
    image = Image.new('RGB', (640, 960), color)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((45, 60, 595, 900), radius=20, fill='white', outline='#243752', width=5)
    draw.text((85, 130), f'NODE COMICS / ORIGINAL TEST PAGE {n}', fill='#243752', font_size=25)
    draw.rectangle((85, 230, 555, 520), fill=color, outline='#243752', width=4)
    draw.text((120, 650), f'PAGE {n}', fill='#243752', font_size=64)
    data = BytesIO(); image.save(data, 'PNG')
    entries.append((f'{n}.png', data.getvalue()))
    (ROOT / f'{n}.png').write_bytes(data.getvalue())

for name in ['pages.cbz', 'pages.zip', 'repacked.cbz']:
    with zipfile.ZipFile(ROOT / name, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path, data in entries:
            archive.writestr(('renamed/' if name == 'repacked.cbz' else '') + path, data)
        archive.writestr('__MACOSX/._1.png', b'not an image')
        archive.writestr('ComicInfo.xml', '<ComicInfo/>')
with zipfile.ZipFile(ROOT / 'broken-image.cbz', 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('1.png', entries[-1][1])
    archive.writestr('2.png', b'not a decodable image')
(ROOT / 'corrupt.pdf').write_bytes(b'%PDF-1.7\ninvalid')

rar4 = b'Rar!\x1a\x07\x00' + block4(0x73, 0, b'\x00' * 6)
rar5 = b'Rar!\x1a\x07\x01\x00' + block5(b'\x01\x00\x00')
for name, data in entries:
    filename = name.encode()
    body = struct.pack('<IIBIIBBHI', len(data), len(data), 2, zlib.crc32(data), 0, 20, 0x30, len(filename), 0x20) + filename
    rar4 += block4(0x74, 0x8000, body) + data
    body = b'\x02\x02' + vint(len(data)) + b'\x04' + vint(len(data)) + vint(0x20) + struct.pack('<I', zlib.crc32(data)) + b'\x00\x00' + vint(len(filename)) + filename
    rar5 += block5(body) + data
rar4 += block4(0x7b, 0x4000, b'')
rar5 += block5(b'\x05\x00\x00')
(ROOT / 'rar4.cbr').write_bytes(rar4)
(ROOT / 'rar5.rar').write_bytes(rar5)

for name, encrypted in [('pages.pdf', False), ('locked.pdf', True)]:
    pdf = canvas.Canvas(str(ROOT / name), pagesize=(320, 480), invariant=1,
                        encrypt=StandardEncryption('fixture-password') if encrypted else None)
    for _, data in reversed(entries):
        pdf.drawImage(ImageReader(BytesIO(data)), 0, 0, 320, 480)
        pdf.showPage()
    pdf.save()
print(f'Generated original fixtures in {ROOT}')
