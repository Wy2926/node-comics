"""Short-lived R2 transfers. Never reuse the credentialed control client."""
import hashlib
import os
from pathlib import Path
import stat
from urllib.parse import urlsplit

import httpx

from .protocol import ControlFailure, NodeFailure


class ObjectTransfer:
    def __init__(self, *, transport=None):
        self.client = httpx.Client(trust_env=False, follow_redirects=False, timeout=30, transport=transport)

    def close(self):
        self.client.close()

    @staticmethod
    def target(transfer):
        url = transfer.get('url', '')
        parsed = urlsplit(url)
        headers = transfer.get('headers') or {}
        allowed = {'content-type', 'content-length', 'x-amz-meta-sha256', 'if-none-match', 'if-match'}
        if (parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.r2.cloudflarestorage.com')
                or parsed.username or parsed.password or parsed.fragment
                or any(key.lower() not in allowed for key in headers)):
            raise NodeFailure('DOCUMENT_TRANSFER_INVALID')
        return url, headers


    def download_to_file(self, ref, transfer, destination, check=lambda: None):
        """Stream the single source object to an exclusive workspace staging file."""
        url, headers = self.target(transfer)
        path, created = Path(destination), False
        digest, size = hashlib.sha256(), 0
        try:
            check()
            with path.open('xb') as output:
                created = True
                with self.client.stream('GET', url, headers=headers) as response:
                    if response.status_code != 200:
                        raise ControlFailure('DOCUMENT_TRANSFER_FAILED', response.status_code)
                    for chunk in response.iter_bytes(64 * 1024):
                        check()
                        size += len(chunk)
                        if size > ref['byte_size']:
                            raise NodeFailure('INPUT_INVALID')
                        digest.update(chunk)
                        output.write(chunk)
                if size != ref['byte_size'] or digest.hexdigest() != ref['sha256']:
                    raise NodeFailure('INPUT_HASH_MISMATCH')
                output.flush()
                os.fsync(output.fileno())
            return path
        except BaseException as error:
            if created:
                path.unlink(missing_ok=True)
            if isinstance(error, httpx.HTTPError):
                raise ControlFailure('DOCUMENT_TRANSFER_FAILED') from None
            raise

    def upload_file(self, ref, transfer, path, check=lambda: None):
        """Upload the final ZIP without materializing it in RAM or SQLite."""
        url, headers = self.target(transfer)
        path = Path(path)
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)
                or info.st_size != ref['byte_size']):
            raise NodeFailure('INPUT_HASH_MISMATCH')
        with path.open('rb') as source:
            opened = os.fstat(source.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_size) != (info.st_dev, info.st_ino, info.st_size):
                raise NodeFailure('INPUT_HASH_MISMATCH')
            digest = hashlib.sha256()
            while chunk := source.read(64 * 1024):
                check()
                digest.update(chunk)
            if digest.hexdigest() != ref['sha256']:
                raise NodeFailure('INPUT_HASH_MISMATCH')
            source.seek(0)

            def chunks():
                size = 0
                while chunk := source.read(64 * 1024):
                    check()
                    size += len(chunk)
                    if size > ref['byte_size']:
                        raise NodeFailure('INPUT_HASH_MISMATCH')
                    yield chunk
                if size != ref['byte_size']:
                    raise NodeFailure('INPUT_HASH_MISMATCH')

            try:
                with self.client.stream('PUT', url, headers=headers, content=chunks()) as response:
                    if response.status_code not in (200, 201, 204, 412):
                        raise ControlFailure('DOCUMENT_TRANSFER_FAILED', response.status_code)
            except httpx.HTTPError:
                raise ControlFailure('DOCUMENT_TRANSFER_FAILED') from None
