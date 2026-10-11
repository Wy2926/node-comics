"""Worker-only bounded PDF/ZIP preparation and complete PNG ZIP output.

The API must not import this module. Native decoders run in a resource-limited
child; production Linux additionally requires Landlock and seccomp confinement.
The source is spooled on disk, only one decoded page is resident at a time.
"""
from contextlib import closing, contextmanager
from dataclasses import asdict, dataclass
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
from threading import Event, Thread
import time
import unicodedata
import zipfile

MAX_PAGES = 200
MAX_SOURCE_BYTES = 200_000_000
CHUNK_BYTES = 1024 * 1024
MAX_ENTRIES = 2048
MAX_DIRECTORY_BYTES = 2 * 1024 * 1024
MAX_IPC_BYTES = 1024 * 1024
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}
METADATA_SUFFIXES = {'.txt', '.xml', '.json', '.nfo', '.md'}


class DocumentFileError(RuntimeError):
    def __init__(self, code='DOCUMENT_INVALID_FILE'):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class FileLimits:
    max_page_pixels: int = 24_000_000
    max_page_dimension: int = 20_000
    max_page_bytes: int = 128 * 1024 * 1024
    max_expanded_bytes: int = 2 * 1024 ** 3
    max_output_bytes: int = 4 * 1024 ** 3
    max_spool_bytes: int = 6 * 1024 ** 3
    parser_memory_bytes: int = 1024 ** 3
    parser_timeout_seconds: int = 300
    pdf_dpi: int = 144

def _check(callback):
    if callback:
        callback()


def _source(path, source_type):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_SOURCE_BYTES:
        raise DocumentFileError('DOCUMENT_SOURCE_TOO_LARGE')
    kind = {'application/pdf': 'pdf', 'application/zip': 'zip', 'cbz': 'zip'}.get(source_type, source_type)
    if kind not in {'pdf', 'zip'}:
        raise DocumentFileError('DOCUMENT_UNSUPPORTED_FORMAT')
    with path.open('rb') as stream:
        start = stream.read(1024)
    if (kind == 'pdf' and b'%PDF-' not in start) or (kind == 'zip' and start[:4] not in {b'PK\x03\x04', b'PK\x05\x06'}):
        raise DocumentFileError('DOCUMENT_FORMAT_MISMATCH')
    return path, kind


def _dimensions(width, height, limits):
    if (not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0
            or max(width, height) > limits.max_page_dimension or width * height > limits.max_page_pixels):
        raise DocumentFileError('DOCUMENT_PAGE_TOO_LARGE')
    return math.ceil(width), math.ceil(height)


def _page_count(count):
    if not 1 <= count <= MAX_PAGES:
        raise DocumentFileError('DOCUMENT_PAGE_LIMIT' if count else 'DOCUMENT_NO_IMAGES')


def _directory_budget(path):
    # zipfile materializes its central directory. Bound it BEFORE constructing ZipFile.
    size = path.stat().st_size
    with path.open('rb') as stream:
        stream.seek(max(0, size - 65557))
        tail = stream.read(65557)
        offset = tail.rfind(b'PK\x05\x06')
        if offset < 0 or len(tail) - offset < 22:
            raise DocumentFileError('DOCUMENT_INVALID_ARCHIVE')
        _, disk, directory_disk, disk_count, count, directory_size, directory_offset, comment = struct.unpack_from('<4s4H2LH', tail, offset)
        if offset + 22 + comment != len(tail) or disk or directory_disk or disk_count != count:
            raise DocumentFileError('DOCUMENT_INVALID_ARCHIVE')
        if count == 65535 or directory_size == 0xffffffff or directory_offset == 0xffffffff:
            end_offset = size - len(tail) + offset
            if end_offset < 20:
                raise DocumentFileError('DOCUMENT_INVALID_ARCHIVE')
            stream.seek(end_offset - 20)
            signature, disk, zip64_offset, disks = struct.unpack('<4sLQL', stream.read(20))
            if signature != b'PK\x06\x07' or disk or disks != 1 or zip64_offset + 56 > end_offset:
                raise DocumentFileError('DOCUMENT_INVALID_ARCHIVE')
            stream.seek(zip64_offset)
            record = struct.unpack('<4sQ2H2L4Q', stream.read(56))
            signature, record_size, _, _, disk, directory_disk, disk_count, count, directory_size, directory_offset = record
            if signature != b'PK\x06\x06' or not 44 <= record_size <= 1024 or disk or directory_disk or disk_count != count:
                raise DocumentFileError('DOCUMENT_INVALID_ARCHIVE')
        if count > MAX_ENTRIES or directory_size > MAX_DIRECTORY_BYTES or directory_offset + directory_size > size:
            raise DocumentFileError('DOCUMENT_ARCHIVE_BUDGET')


def _safe_name(name):
    name = unicodedata.normalize('NFC', name.replace('\\', '/'))
    if (not name or len(name.encode('utf-8')) > 1024 or name.startswith('/') or ':' in name
            or any(ord(char) < 32 or ord(char) == 127 for char in name)
            or any(part in ('', '.', '..') for part in name.rstrip('/').split('/'))):
        raise DocumentFileError('DOCUMENT_UNSAFE_ARCHIVE_PATH')
    return name


def _natural(name):
    return tuple((1, int(part)) if part.isdigit() else (0, part.casefold()) for part in re.split(r'(\d+)', name)), name


def _archive_pages(path, limits):
    _directory_budget(path)
    try:
        with zipfile.ZipFile(path) as archive:
            entries, names, expanded, images = archive.infolist(), set(), 0, []
            if len(entries) > MAX_ENTRIES:
                raise DocumentFileError('DOCUMENT_ARCHIVE_BUDGET')
            for entry in entries:
                name = _safe_name(entry.orig_filename)
                identity = name.casefold().rstrip('/')
                if identity in names:
                    raise DocumentFileError('DOCUMENT_DUPLICATE_PAGE')
                names.add(identity)
                mode = entry.external_attr >> 16
                if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise DocumentFileError('DOCUMENT_UNSAFE_ARCHIVE_ENTRY')
                if entry.flag_bits & 1:
                    raise DocumentFileError('DOCUMENT_ENCRYPTED')
                if entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    raise DocumentFileError('DOCUMENT_UNSUPPORTED_COMPRESSION')
                if entry.is_dir():
                    continue
                expanded += entry.file_size
                if expanded > limits.max_expanded_bytes or entry.file_size > 200 * max(1, entry.compress_size):
                    raise DocumentFileError('DOCUMENT_ARCHIVE_BUDGET')
                if any(part.startswith('.') or part == '__MACOSX' for part in name.split('/')):
                    continue
                suffix = Path(name).suffix.lower()
                if suffix not in IMAGE_SUFFIXES | METADATA_SUFFIXES:
                    raise DocumentFileError('DOCUMENT_UNSUPPORTED_ENTRY')
                if suffix in IMAGE_SUFFIXES:
                    if not 0 < entry.file_size <= limits.max_page_bytes:
                        raise DocumentFileError('DOCUMENT_PAGE_TOO_LARGE')
                    images.append((name, entry.filename, entry.file_size, entry.CRC))
            _page_count(len(images))
            images.sort(key=lambda item: _natural(item[0]))
            return [{'page_index': index, 'source_name': name[:300],
                     'locator': {'entry': entry, 'byte_size': size, 'crc32': crc}}
                    for index, (name, entry, size, crc) in enumerate(images, 1)]
    except (zipfile.BadZipFile, struct.error, OSError, UnicodeError):
        raise DocumentFileError('DOCUMENT_INVALID_ARCHIVE') from None


@contextmanager
def _pdf(path):
    try:
        import pypdfium2 as pdfium  # Deliberately worker-only/lazy.
    except ImportError:
        raise DocumentFileError('DOCUMENT_PDF_RUNTIME_MISSING') from None
    document = None
    try:
        document = pdfium.PdfDocument(str(path))
        if pdfium.raw.FPDF_GetSecurityHandlerRevision(document.raw) != -1:
            raise DocumentFileError('DOCUMENT_ENCRYPTED')
        # No init_forms, JavaScript actions, attachment extraction or external callbacks.
        yield document
    except pdfium.PdfiumError as error:
        code = 'DOCUMENT_ENCRYPTED' if getattr(error, 'err_code', None) == 4 else 'DOCUMENT_INVALID_PDF'
        raise DocumentFileError(code) from None
    finally:
        if document is not None:
            document.close()


def scan_source(path, source_type, *, limits=None):
    limits = limits or FileLimits()
    path, kind = _source(path, source_type)
    if kind == 'zip':
        return _archive_pages(path, limits)
    with _pdf(path) as document:
        _page_count(len(document))
        pages = []
        for number in range(len(document)):
            with closing(document[number]) as page:
                width, height = page.get_size()
                width, height = _dimensions(width * limits.pdf_dpi / 72, height * limits.pdf_dpi / 72, limits)
                pages.append({'page_index': number + 1, 'source_name': f'{number + 1:04}.png',
                              'locator': {'pdf_page': number + 1}, 'width': width, 'height': height})
        return pages


class _BoundedWriter:
    def __init__(self, stream, maximum):
        self.stream, self.maximum = stream, maximum

    def write(self, value):
        if self.stream.tell() + len(value) > self.maximum:
            raise DocumentFileError('DOCUMENT_SPOOL_BUDGET')
        return self.stream.write(value)

    def __getattr__(self, name):
        return getattr(self.stream, name)


class _ZipWriter(_BoundedWriter):
    """Append-only ZIP data descriptors let us hash the final bytes once."""
    def __init__(self, stream, maximum):
        super().__init__(stream, maximum)
        self.digest = hashlib.sha256()

    def seek(self, *args):
        raise OSError('ZIP writer is append-only')

    def write(self, value):
        written = super().write(value)
        self.digest.update(memoryview(value)[:written])
        return written


def _save_png(image, path, limits, *, remaining):
    from PIL import Image, ImageCms, ImageOps
    _dimensions(*image.size, limits)
    if getattr(image, 'n_frames', 1) != 1:
        raise DocumentFileError('DOCUMENT_ANIMATED_IMAGE')
    image.load()
    oriented = ImageOps.exif_transpose(image)
    try:
        profile = image.info.get('icc_profile')
        if profile:
            # Convert declared colors, then drop profile and orientation metadata.
            normalized = ImageCms.profileToProfile(oriented, ImageCms.ImageCmsProfile(BytesIO(profile)),
                ImageCms.createProfile('sRGB'), outputMode='RGBA' if 'A' in oriented.getbands() else 'RGB')
        else:
            normalized = oriented.convert('RGBA' if 'A' in oriented.getbands() or 'transparency' in oriented.info else 'RGB')
        try:
            normalized.info.clear()
            with path.open('xb') as output:
                normalized.save(_BoundedWriter(output, min(limits.max_page_bytes, remaining)), format='PNG', compress_level=3)
            width, height = normalized.size
        finally:
            normalized.close()
    finally:
        oriented.close()
    with path.open('rb') as output:
        sha = hashlib.file_digest(output, 'sha256').hexdigest()
    return {'path': path, 'sha256': sha, 'byte_size': path.stat().st_size,
            'mime': 'image/png', 'width': width, 'height': height}


def normalize_pages(path, source_type, directory, *, manifest=None, limits=None, check_cancelled=None):
    from PIL import Image, UnidentifiedImageError
    limits = limits or FileLimits()
    path, kind = _source(path, source_type)
    actual = scan_source(path, kind, limits=limits)
    if manifest is not None and manifest != actual:
        raise DocumentFileError('DOCUMENT_MANIFEST_MISMATCH')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    used = path.stat().st_size

    def finish(page, image, *, temporary_bytes=0):
        nonlocal used
        _check(check_cancelled)
        target = directory / f"{page['page_index']:04}.png"
        result = _save_png(image, target, limits, remaining=limits.max_spool_bytes - used - temporary_bytes)
        used += result['byte_size']
        if used > limits.max_spool_bytes:
            target.unlink(missing_ok=True)
            raise DocumentFileError('DOCUMENT_SPOOL_BUDGET')
        return {**result, 'page_index': page['page_index'], 'source_name': page['source_name']}

    try:
        if kind == 'zip':
            with zipfile.ZipFile(path) as archive:
                for page in actual:
                    _check(check_cancelled)
                    # A per-page temporary file bounds decompression and gives PIL random access.
                    with tempfile.TemporaryFile(dir=directory) as spool:
                        written = 0
                        with archive.open(page['locator']['entry']) as source:
                            while chunk := source.read(CHUNK_BYTES):
                                _check(check_cancelled)
                                written += len(chunk)
                                if written > page['locator']['byte_size'] or used + written > limits.max_spool_bytes:
                                    raise DocumentFileError('DOCUMENT_ARCHIVE_BUDGET')
                                spool.write(chunk)
                        if written != page['locator']['byte_size']:
                            raise DocumentFileError('DOCUMENT_INVALID_ARCHIVE')
                        spool.seek(0)
                        with Image.open(spool) as image:
                            if image.format not in {'PNG', 'JPEG', 'WEBP', 'GIF'}:
                                raise DocumentFileError('DOCUMENT_UNSUPPORTED_ENTRY')
                            yield finish(page, image, temporary_bytes=written)
        else:
            with _pdf(path) as document:
                for entry in actual:
                    _check(check_cancelled)
                    with closing(document[entry['page_index'] - 1]) as page:
                        bitmap = page.render(scale=limits.pdf_dpi / 72, may_draw_forms=False,
                            fill_color=(255, 255, 255, 255), limit_image_cache=True)
                        try:
                            image = bitmap.to_pil()
                            try:
                                yield finish(entry, image)
                            finally:
                                image.close()
                        finally:
                            bitmap.close()
    except DocumentFileError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, zipfile.BadZipFile, OSError, ValueError):
        raise DocumentFileError('DOCUMENT_INVALID_PAGE') from None


def package_zip(pages, destination, *, store=None, limits=None, check_cancelled=None):
    limits = limits or FileLimits()
    pages, destination = list(pages), Path(destination)
    _page_count(len(pages))
    if [page.get('page_index') for page in pages] != list(range(1, len(pages) + 1)):
        raise DocumentFileError('DOCUMENT_INCOMPLETE_PAGES')
    if any(page.get('mime') != 'image/png' for page in pages):
        raise DocumentFileError('DOCUMENT_INVALID_OUTPUT')
    predicted = sum(page['byte_size'] for page in pages) + len(pages) * 256 + 128
    if predicted > min(limits.max_output_bytes, limits.max_spool_bytes):
        raise DocumentFileError('DOCUMENT_OUTPUT_TOO_LARGE')
    created = False
    try:
        with destination.open('xb') as output:
            created = True
            writer = _ZipWriter(output, min(limits.max_output_bytes, limits.max_spool_bytes))
            with zipfile.ZipFile(writer,
                                 mode='w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                for page in pages:
                    _check(check_cancelled)
                    context = store.open_stream(page) if store is not None else Path(page['path']).open('rb')
                    digest, size, signature = hashlib.sha256(), 0, b''
                    info = zipfile.ZipInfo(f"{page['page_index']:04}.png", date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type, info.external_attr = zipfile.ZIP_STORED, 0o100600 << 16
                    with context as source, archive.open(info, 'w', force_zip64=True) as target:
                        while chunk := source.read(CHUNK_BYTES):
                            _check(check_cancelled)
                            if len(signature) < 8:
                                signature = (signature + chunk)[:8]
                            size += len(chunk)
                            if size > page['byte_size']:
                                raise DocumentFileError('DOCUMENT_OUTPUT_MISMATCH')
                            digest.update(chunk)
                            target.write(chunk)
                    if (signature != b'\x89PNG\r\n\x1a\n' or size != page['byte_size']
                            or digest.hexdigest() != page['sha256']):
                        raise DocumentFileError('DOCUMENT_OUTPUT_MISMATCH')
                if len(archive.infolist()) != len(pages):
                    raise DocumentFileError('DOCUMENT_INCOMPLETE_PAGES')
            sha = writer.digest.hexdigest()
        return {'path': destination, 'sha256': sha, 'byte_size': destination.stat().st_size, 'mime': 'application/zip'}
    except BaseException:
        if created:
            destination.unlink(missing_ok=True)
        raise


def _child_environment(output):
    environment = {name: os.environ[name] for name in ('SYSTEMROOT', 'WINDIR', 'PATH') if name in os.environ}
    environment.update(PYTHONUTF8='1', TMPDIR=str(output), TMP=str(output), TEMP=str(output),
                       NODE_PARSER_PARENT_PID=str(os.getpid()))
    return environment


def _sandbox_command(source, output):
    if sys.platform != 'linux':
        raise DocumentFileError('DOCUMENT_SANDBOX_UNAVAILABLE')
    return [sys.executable, '-I', str(Path(__file__).with_name('linux_sandbox.py')),
            str(source), str(output)]


def check_parser_sandbox(spool_path=None, *, require_sandbox=True):
    """Prove library loading and kernel-enforced denials before advertising v2."""
    if not require_sandbox:
        return False  # Only an explicit isolated development/test override may disable it.
    if spool_path is not None:
        Path(spool_path).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='sandbox-probe-', dir=spool_path) as temporary:
        root = Path(temporary).resolve()
        output = root / 'output'
        output.mkdir()
        forbidden = root / 'private'
        forbidden.write_bytes(b'private-probe')
        source = root / 'probe'
        source.touch()
        command = _sandbox_command(source, output) + [str(forbidden)]
        try:
            result = subprocess.run(command, env=_child_environment(output), stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except (OSError, subprocess.TimeoutExpired):
            raise DocumentFileError('DOCUMENT_SANDBOX_UNAVAILABLE') from None
        if result.returncode or result.stdout.strip() != b'document-sandbox-ok':
            raise DocumentFileError('DOCUMENT_SANDBOX_UNAVAILABLE')
    return True


def run_file_operation(action, source, source_type, directory=None, manifest=None, *, limits=None,
                       timeout=None, check_cancelled=None, require_sandbox=True):
    """Bounded child result (<=200 descriptors); decoded pixels never cross IPC.

    normalize saves all pages under max_spool_bytes in the caller's private
    workspace. The caller owns their durable checkpoints and eventual cleanup.
    """
    if action not in {'scan', 'normalize'}:
        raise ValueError('Unknown document file operation')
    limits = limits or FileLimits()
    timeout = limits.parser_timeout_seconds if timeout is None else timeout
    source = Path(source).resolve(strict=True)
    if action == 'normalize' and directory is None:
        raise ValueError('Normalization requires a task-private output directory')
    with tempfile.TemporaryDirectory(prefix='document-parser-', dir=source.parent) as temporary:
        output = Path(directory).resolve() if directory else Path(temporary)
        output.mkdir(parents=True, exist_ok=True)
        payload = {'action': action, 'source': str(source), 'source_type': source_type,
                   'directory': str(output), 'manifest': manifest, 'limits': asdict(limits)}
        environment = _child_environment(output)
        command = [sys.executable, '-m', 'comic_document_files']
        sandboxed = sys.platform.startswith('linux') and require_sandbox
        if require_sandbox and not sys.platform.startswith('linux'):
            raise DocumentFileError('DOCUMENT_SANDBOX_UNAVAILABLE')
        if sandboxed:
            command = _sandbox_command(source, output)
        data = json.dumps(payload, ensure_ascii=False).encode()
        if len(data) > MAX_IPC_BYTES:
            raise DocumentFileError('DOCUMENT_MANIFEST_TOO_LARGE')
        request_file = tempfile.TemporaryFile(dir=temporary)
        request_file.write(data)
        request_file.seek(0)
        try:
            process = subprocess.Popen(command, cwd=Path(__file__).resolve().parent.parent, env=environment,
                stdin=request_file, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except OSError:
            request_file.close()
            raise DocumentFileError('DOCUMENT_PARSE_FAILED') from None
        result = bytearray()
        overflow = Event()

        def read_result():
            while chunk := process.stdout.read(65536):
                if len(result) + len(chunk) > MAX_IPC_BYTES:
                    overflow.set()
                    process.kill()
                    return
                result.extend(chunk)

        reader = Thread(target=read_result, daemon=True)
        reader.start()
        started = time.monotonic()
        try:
            while process.poll() is None:
                _check(check_cancelled)
                if time.monotonic() - started > timeout:
                    raise DocumentFileError('DOCUMENT_PARSE_TIMEOUT')
                time.sleep(0.05)
            reader.join()
            if overflow.is_set():
                raise DocumentFileError('DOCUMENT_PARSE_FAILED')
            if process.returncode != 0:
                raise DocumentFileError('DOCUMENT_SANDBOX_UNAVAILABLE' if sandboxed and not result else 'DOCUMENT_PARSE_FAILED')
            try:
                reply = json.loads(result)
            except (ValueError, UnicodeError):
                raise DocumentFileError('DOCUMENT_PARSE_FAILED') from None
            if reply.get('error'):
                code = reply['error']
                raise DocumentFileError(code if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,59}', code)
                                        else 'DOCUMENT_PARSE_FAILED')
            value = reply['result']
            if action == 'normalize':
                if (not isinstance(value, list) or not 1 <= len(value) <= MAX_PAGES
                        or [page.get('page_index') for page in value] != list(range(1, len(value) + 1))
                        or manifest is not None and len(value) != len(manifest)):
                    raise DocumentFileError('DOCUMENT_INCOMPLETE_PAGES')
                for page in value:
                    filename = Path(page['path']).name
                    if filename != f"{page['page_index']:04}.png":
                        raise DocumentFileError('DOCUMENT_PARSE_FAILED')
                    candidate = output / filename
                    # A decoder compromise must not trick the privileged parent into
                    # opening a symlink to a file outside the narrow parser sandbox.
                    info = candidate.lstat()
                    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                            or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)
                            or candidate.resolve().parent != output.resolve()
                            or info.st_size != page.get('byte_size') or not 0 < info.st_size <= limits.max_page_bytes
                            or page.get('mime') != 'image/png'):
                        raise DocumentFileError('DOCUMENT_INVALID_PAGE')
                    _dimensions(page.get('width', 0), page.get('height', 0), limits)
                    page['path'] = candidate
            return value
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            reader.join()
            request_file.close()
            if process.stdout:
                process.stdout.close()


def _limit_child(limits):
    if sys.platform != 'win32':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (limits.parser_memory_bytes, limits.parser_memory_bytes))
        resource.setrlimit(resource.RLIMIT_CPU, (limits.parser_timeout_seconds, limits.parser_timeout_seconds + 1))
        resource.setrlimit(resource.RLIMIT_FSIZE, (limits.max_spool_bytes, limits.max_spool_bytes))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def _child(payload=None):
    if payload is None:
        payload = json.loads(sys.stdin.buffer.read(MAX_IPC_BYTES + 1))
        _limit_child(FileLimits(**payload['limits']))
    limits = FileLimits(**payload['limits'])
    try:
        if payload['action'] == 'scan':
            result = scan_source(payload['source'], payload['source_type'], limits=limits)
        else:
            result = list(normalize_pages(payload['source'], payload['source_type'], payload['directory'],
                                          manifest=payload['manifest'], limits=limits))
        reply = {'result': result}
    except DocumentFileError as error:
        reply = {'error': error.code}
    except Exception:
        reply = {'error': 'DOCUMENT_PARSE_FAILED'}
    sys.stdout.write(json.dumps(reply, default=str, ensure_ascii=False))
