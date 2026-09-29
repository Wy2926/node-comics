"""Private, immutable files on the center's shared durable volume."""
import errno
import hashlib
import os
import shutil
from uuid import uuid4
from .config import settings


class StorageError(Exception):
    def __init__(self, code="STORAGE_UNAVAILABLE"):
        self.code = code
        super().__init__("Private file storage unavailable")


def validate_key(key):
    if not key or chr(92) in key or ":" in key or any(part in ("", ".", "..") for part in key.split("/")):
        raise ValueError("Invalid storage key")


def sync_directory(path):
    if os.name != 'nt':
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


class LocalStore:
    def path(self, key):
        validate_key(key)
        root = settings().storage_path.resolve()
        path = (root / key).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Invalid storage key")
        return path

    def put(self, key, data, mime, *, kind=None):
        from io import BytesIO
        return self.put_file(key, BytesIO(data), mime, kind=kind)

    def put_file(self, key, stream, mime, *, kind=None):
        path = self.path(key)
        cfg = settings()
        maximum = cfg.max_upload_bytes if kind in {'original', 'upload'} else cfg.cluster_max_result_bytes
        stream.seek(0, 2)
        length = stream.tell()
        stream.seek(0)
        if not 0 < length <= maximum:
            raise StorageError()
        temporary = cfg.storage_path.resolve() / 'staging' / (str(uuid4()) + '.part')
        def stream_hash(handle):
            handle.seek(0)
            result = hashlib.sha256()
            while chunk := handle.read(1024 * 1024):
                result.update(chunk)
            handle.seek(0)
            return result.digest()

        def verify_existing():
            with path.open('rb') as existing:
                if stream_hash(existing) != stream_hash(stream):
                    raise StorageError('STORAGE_CONFLICT')

        try:
            if path.is_file():
                verify_existing()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with temporary.open('xb') as output:
                    shutil.copyfileobj(stream, output, 1024 * 1024)
                    output.flush()
                    os.fsync(output.fileno())
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    # A concurrent replay may publish first; immutable bytes must agree.
                    verify_existing()
            ancestor = path.parent
            root = cfg.storage_path.resolve()
            while ancestor != root:
                sync_directory(ancestor)
                ancestor = ancestor.parent
            sync_directory(root)
        except OSError as error:
            raise StorageError('STORAGE_FULL' if error.errno == errno.ENOSPC else 'STORAGE_UNAVAILABLE') from None
        finally:
            temporary.unlink(missing_ok=True)
            stream.seek(0)

    def read(self, key):
        try:
            with self.path(key).open('rb') as stream:
                data = stream.read(max(settings().max_upload_bytes, settings().cluster_max_result_bytes) + 1)
            if len(data) > max(settings().max_upload_bytes, settings().cluster_max_result_bytes):
                raise StorageError()
            return data
        except OSError:
            raise StorageError() from None

    def exists(self, key):
        return self.path(key).is_file()

    def delete(self, key):
        path = self.path(key)
        path.unlink(missing_ok=True)
        if path.parent.exists():
            sync_directory(path.parent)
        # Each input owns a directory; retaining it would leak an inode per job.
        # Only remove that empty task directory, never shared result prefixes.
        if path.parent.parent == settings().storage_path.resolve() / 'inputs':
            try:
                path.parent.rmdir()
            except OSError:
                pass
            else:
                sync_directory(path.parent.parent)


def get_store():
    return LocalStore()
