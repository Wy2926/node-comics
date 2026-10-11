"""Private R2 objects. Control methods never download file bytes or import parsers.

Input uploads are multipart-only and completed with a server-read part list.
Trusted compute outputs use unique lease keys and conditional, digest-bound PUTs.
An R2 multipart ETag is an opaque revision, never a content SHA-256.
"""
from contextlib import contextmanager
import base64
import hashlib
import json
from pathlib import Path
import re
from threading import Lock
from urllib.parse import quote
from weakref import finalize

from .config import MAX_SOURCE_BYTES, get_document_settings


CHUNK_BYTES = 1024 * 1024
MAX_JSON_BYTES = 16 * 1024 * 1024


class DocumentStoreError(RuntimeError):
    def __init__(self, code='DOCUMENT_STORAGE_UNAVAILABLE'):
        self.code = code
        super().__init__(code)  # Never expose signed URLs, credentials or upstream error bodies.


def _sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value):
        raise DocumentStoreError('DOCUMENT_INVALID_OBJECT')
    return value


class DocumentStore:
    def __init__(self, config=None, *, client=None):
        self.config = (config or get_document_settings()).model_copy(deep=True)
        self._client = client
        self._client_lock = Lock()

    @property
    def client(self):
        if not self.config.enabled:
            raise DocumentStoreError('DOCUMENT_STORAGE_DISABLED')
        with self._client_lock:
            if self._client is None:
                import boto3
                from botocore.config import Config
                # Sessions are not shared across threads; the resulting client is.
                self._client = boto3.Session().client('s3', endpoint_url=self.config.r2_endpoint_url,
                    region_name='auto', aws_access_key_id=self.config.r2_access_key_id.get_secret_value(),
                    aws_secret_access_key=self.config.r2_secret_access_key.get_secret_value(),
                    config=Config(signature_version='s3v4', connect_timeout=10, read_timeout=60,
                        retries={'max_attempts': 2, 'mode': 'standard'},
                        request_checksum_calculation='when_required', response_checksum_validation='when_required',
                        s3={'addressing_style': 'path'}))
                # Retired stores remain usable by in-flight callers. Close only
                # after their last reference disappears, or at process exit.
                # Injected clients remain owned by the caller/test fixture.
                finalize(self, self._client.close)
            return self._client

    def key(self, category, job_id, *parts):
        value = '/'.join((self.config.r2_key_prefix, category, str(job_id), *(str(part) for part in parts)))
        return self._key(value)

    def _key(self, key):
        prefix = self.config.r2_key_prefix + '/'
        if (not isinstance(key, str) or len(key) > 900 or not key.startswith(prefix)
                or not re.fullmatch(r'[A-Za-z0-9_./-]+', key)
                or any(part in ('', '.', '..') for part in key.split('/'))):
            raise DocumentStoreError('DOCUMENT_INVALID_OBJECT')
        pieces = key[len(prefix):].split('/')
        if len(pieces) < 3 or pieces[0] not in {'input', 'work', 'output'}:
            raise DocumentStoreError('DOCUMENT_INVALID_OBJECT')
        return key

    def _call(self, method, **kwargs):
        try:
            return getattr(self.client, method)(Bucket=self.config.r2_bucket, **kwargs)
        except DocumentStoreError:
            raise
        except Exception as error:
            # SDK exception text can contain request details; keep only a fixed error code.
            code = getattr(error, 'response', {}).get('Error', {}).get('Code', '')
            mapped = {'404': 'DOCUMENT_OBJECT_NOT_FOUND', 'NoSuchKey': 'DOCUMENT_OBJECT_NOT_FOUND',
                      'NotFound': 'DOCUMENT_OBJECT_NOT_FOUND', 'NoSuchUpload': 'DOCUMENT_UPLOAD_NOT_FOUND',
                      'PreconditionFailed': 'DOCUMENT_OBJECT_CONFLICT', '412': 'DOCUMENT_OBJECT_CONFLICT',
                      'InvalidPart': 'DOCUMENT_UPLOAD_INCOMPLETE', 'EntityTooSmall': 'DOCUMENT_UPLOAD_INCOMPLETE'}
            raise DocumentStoreError(mapped.get(code, 'DOCUMENT_STORAGE_UNAVAILABLE')) from None

    def _sign(self, operation, params, headers=None):
        try:
            url = self.client.generate_presigned_url(operation,
                Params={'Bucket': self.config.r2_bucket, **params}, ExpiresIn=self.config.signed_url_seconds)
        except DocumentStoreError:
            raise
        except Exception:
            raise DocumentStoreError() from None
        return {'url': url, 'headers': headers or {}, 'expires_in': self.config.signed_url_seconds}

    def create_multipart(self, key, mime, *, sha256=None):
        key = self._key(key)
        params = {'Key': key, 'ContentType': mime, 'CacheControl': 'private, no-store'}
        if sha256 is not None:
            params['Metadata'] = {'sha256': _sha(sha256)}
        return self._call('create_multipart_upload', **params)['UploadId']

    def presign_upload_part(self, key, upload_id, part_number, *, byte_size=None):
        if type(part_number) is not int or not 1 <= part_number <= 40:
            raise DocumentStoreError('DOCUMENT_INVALID_PART')
        params = {'Key': self._key(key), 'UploadId': upload_id, 'PartNumber': part_number}
        # Content-Length is supplied by the browser for a sliced Blob, not set via fetch headers.
        if byte_size is not None:
            if type(byte_size) is not int or not 0 < byte_size <= self.config.upload_part_bytes:
                raise DocumentStoreError('DOCUMENT_INVALID_PART')
            params['ContentLength'] = byte_size
        return self._sign('upload_part', params)

    def list_parts(self, key, upload_id):
        key, rows, marker = self._key(key), [], 0
        while True:
            reply = self._call('list_parts', Key=key, UploadId=upload_id, MaxParts=100,
                               **({'PartNumberMarker': marker} if marker else {}))
            rows.extend({'part_number': part['PartNumber'], 'etag': part['ETag'], 'byte_size': part['Size']}
                        for part in reply.get('Parts', []))
            if len(rows) > 40:
                raise DocumentStoreError('DOCUMENT_UPLOAD_INCOMPLETE')
            if not reply.get('IsTruncated'):
                return rows
            next_marker = reply.get('NextPartNumberMarker', 0)
            if next_marker <= marker:
                raise DocumentStoreError('DOCUMENT_UPLOAD_INCOMPLETE')
            marker = next_marker

    def complete_multipart(self, key, upload_id, *, expected_size, expected_sha256=None):
        key = self._key(key)
        if type(expected_size) is not int or not 0 < expected_size <= MAX_SOURCE_BYTES:
            raise DocumentStoreError('DOCUMENT_SOURCE_TOO_LARGE')
        try:
            parts = self.list_parts(key, upload_id)
        except DocumentStoreError as error:
            if error.code != 'DOCUMENT_UPLOAD_NOT_FOUND':
                raise
            # Completion may have succeeded before a network/DB interruption.
            result = self.head(key)
        else:
            expected_parts = (expected_size + self.config.upload_part_bytes - 1) // self.config.upload_part_bytes
            if len(parts) != expected_parts or any(part['part_number'] != index for index, part in enumerate(parts, 1)):
                raise DocumentStoreError('DOCUMENT_UPLOAD_INCOMPLETE')
            for index, part in enumerate(parts):
                expected = min(self.config.upload_part_bytes, expected_size - index * self.config.upload_part_bytes)
                if part['byte_size'] != expected:
                    raise DocumentStoreError('DOCUMENT_UPLOAD_SIZE_MISMATCH')
            self._call('complete_multipart_upload', Key=key, UploadId=upload_id,
                MultipartUpload={'Parts': [{'PartNumber': part['part_number'], 'ETag': part['etag']} for part in parts]})
            result = self.head(key)
        if result['byte_size'] != expected_size:
            raise DocumentStoreError('DOCUMENT_UPLOAD_SIZE_MISMATCH')
        if expected_sha256 is not None and result.get('sha256') not in (None, _sha(expected_sha256)):
            raise DocumentStoreError('DOCUMENT_OBJECT_MISMATCH')
        return result

    def abort_multipart(self, key, upload_id):
        try:
            self._call('abort_multipart_upload', Key=self._key(key), UploadId=upload_id)
        except DocumentStoreError as error:
            if error.code != 'DOCUMENT_UPLOAD_NOT_FOUND':
                raise

    def head(self, key):
        key = self._key(key)
        reply = self._call('head_object', Key=key)
        result = {'key': key, 'byte_size': reply['ContentLength'],
                  'mime': reply.get('ContentType', 'application/octet-stream'), 'etag': reply.get('ETag', '')}
        sha = reply.get('Metadata', {}).get('sha256')
        if sha:
            result['sha256'] = _sha(sha)
        return result

    def verify(self, ref):
        expected = self._descriptor(ref)
        actual = self.head(expected['key'])
        if any(actual.get(field) != expected[field] for field in ('sha256', 'byte_size', 'mime')):
            raise DocumentStoreError('DOCUMENT_OBJECT_MISMATCH')
        return {**expected, 'etag': actual['etag']}

    def _descriptor(self, ref):
        if not isinstance(ref, dict):
            raise DocumentStoreError('DOCUMENT_INVALID_OBJECT')
        key, sha, size, mime = self._key(ref.get('key')), _sha(ref.get('sha256')), ref.get('byte_size'), ref.get('mime')
        if (type(size) is not int or not 0 < size <= self.config.max_output_bytes
                or mime not in {'image/png', 'application/json', 'application/zip', 'application/pdf', 'application/octet-stream'}):
            raise DocumentStoreError('DOCUMENT_INVALID_OBJECT')
        result = {'key': key, 'sha256': sha, 'byte_size': size, 'mime': mime}
        for name in ('width', 'height'):
            if name in ref:
                if type(ref[name]) is not int or ref[name] <= 0:
                    raise DocumentStoreError('DOCUMENT_INVALID_OBJECT')
                result[name] = ref[name]
        if ref.get('etag'):
            result['etag'] = ref['etag']
        return result

    def presign_get(self, ref):
        key = self._key(ref if isinstance(ref, str) else ref.get('key'))
        params, headers = {'Key': key}, {}
        if isinstance(ref, dict) and ref.get('etag'):
            params['IfMatch'] = headers['If-Match'] = ref['etag']
        return self._sign('get_object', params, headers)

    def presign_download(self, key, filename=None):
        params = {'Key': self._key(key)}
        if filename:
            safe = str(filename).replace('\\', '/').rsplit('/', 1)[-1][:180]
            safe = ''.join(char for char in safe if ord(char) >= 32 and ord(char) != 127)
            params['ResponseContentDisposition'] = "attachment; filename=\"translated.zip\"; filename*=UTF-8''" + quote(safe, safe='')
        return self._sign('get_object', params)

    def presign_put(self, ref):
        ref = self._descriptor(ref)
        if ref['key'].startswith(self.config.r2_key_prefix + '/input/'):
            raise DocumentStoreError('DOCUMENT_INPUT_MULTIPART_REQUIRED')
        headers = {'Content-Type': ref['mime'], 'Content-Length': str(ref['byte_size']),
                   'x-amz-meta-sha256': ref['sha256'], 'If-None-Match': '*'}
        return self._sign('put_object', {'Key': ref['key'], 'ContentType': ref['mime'],
            'ContentLength': ref['byte_size'], 'Metadata': {'sha256': ref['sha256']}, 'IfNoneMatch': '*'}, headers)

    @contextmanager
    def open_stream(self, ref):
        expected = self._descriptor(ref)
        response = self._call('get_object', Key=expected['key'],
                              **({'IfMatch': expected['etag']} if expected.get('etag') else {}))
        body = response['Body']
        try:
            if response['ContentLength'] != expected['byte_size']:
                raise DocumentStoreError('DOCUMENT_OBJECT_MISMATCH')
            yield body
        finally:
            body.close()

    def get_to_file(self, ref, destination, *, check_cancelled=None):
        ref = self._descriptor(ref)
        destination = Path(destination)
        digest, received, created = hashlib.sha256(), 0, False
        try:
            with destination.open('xb') as output:
                created = True
                with self.open_stream(ref) as source:
                    while chunk := source.read(CHUNK_BYTES):
                        if check_cancelled:
                            check_cancelled()
                        received += len(chunk)
                        if received > ref['byte_size']:
                            raise DocumentStoreError('DOCUMENT_OBJECT_MISMATCH')
                        digest.update(chunk)
                        output.write(chunk)
            if received != ref['byte_size'] or digest.hexdigest() != ref['sha256']:
                raise DocumentStoreError('DOCUMENT_OBJECT_MISMATCH')
        except BaseException:
            # Only this call's exclusive destination is eligible for cleanup.
            if created:
                destination.unlink(missing_ok=True)
            raise
        return destination

    def put_file(self, key, path, mime, *, check_cancelled=None, **metadata):
        if set(metadata) - {'width', 'height'}:
            raise DocumentStoreError('DOCUMENT_INVALID_OBJECT')
        path, key = Path(path), self._key(key)
        if key.startswith(self.config.r2_key_prefix + '/input/'):
            raise DocumentStoreError('DOCUMENT_INPUT_MULTIPART_REQUIRED')
        with path.open('rb') as stream:
            size = path.stat().st_size
            sha = hashlib.file_digest(stream, 'sha256').hexdigest()
            ref = self._descriptor({'key': key, 'sha256': sha, 'byte_size': size, 'mime': mime, **metadata})
            if check_cancelled:
                check_cancelled()
            stream.seek(0)
            if size > self.config.upload_part_bytes:
                try:
                    return self.verify(ref)
                except DocumentStoreError as error:
                    if error.code != 'DOCUMENT_OBJECT_NOT_FOUND':
                        raise
                upload_id = self.create_multipart(key, mime, sha256=sha)
                finished = False
                try:
                    parts = []
                    while chunk := stream.read(self.config.upload_part_bytes):
                        if check_cancelled:
                            check_cancelled()
                        number = len(parts) + 1
                        reply = self._call('upload_part', Key=key, UploadId=upload_id, PartNumber=number,
                            Body=chunk, ContentLength=len(chunk),
                            ContentMD5=base64.b64encode(hashlib.md5(chunk, usedforsecurity=False).digest()).decode())
                        parts.append({'PartNumber': number, 'ETag': reply['ETag']})
                    if check_cancelled:
                        check_cancelled()
                    try:
                        self._call('complete_multipart_upload', Key=key, UploadId=upload_id,
                                   MultipartUpload={'Parts': parts})
                    except DocumentStoreError:
                        # Completion may have reached R2 despite an ambiguous transport outcome.
                        self.verify(ref)
                    result = self.verify(ref)
                    finished = True
                    return result
                finally:
                    if not finished:
                        try:
                            self.abort_multipart(key, upload_id)
                        except DocumentStoreError:
                            pass  # Lifecycle/maintenance also abort abandoned multipart sessions.
            try:
                self._call('put_object', Key=key, Body=stream, ContentLength=size, ContentType=mime,
                           CacheControl='private, no-store', Metadata={'sha256': sha}, IfNoneMatch='*')
            except DocumentStoreError as error:
                if error.code != 'DOCUMENT_OBJECT_CONFLICT':
                    raise
            return self.verify(ref)

    def put_json(self, key, value, *, maximum=MAX_JSON_BYTES):
        data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        if not 0 < maximum <= self.config.max_output_bytes or len(data) > maximum:
            raise DocumentStoreError('DOCUMENT_JSON_TOO_LARGE')
        key, sha = self._key(key), hashlib.sha256(data).hexdigest()
        ref = {'key': key, 'sha256': sha, 'byte_size': len(data), 'mime': 'application/json'}
        if key.startswith(self.config.r2_key_prefix + '/input/'):
            raise DocumentStoreError('DOCUMENT_INPUT_MULTIPART_REQUIRED')
        try:
            self._call('put_object', Key=key, Body=data, ContentLength=len(data), ContentType='application/json',
                       CacheControl='private, no-store', Metadata={'sha256': sha}, IfNoneMatch='*')
        except DocumentStoreError as error:
            if error.code != 'DOCUMENT_OBJECT_CONFLICT':
                raise
        return self.verify(ref)

    def get_json(self, ref, *, maximum=MAX_JSON_BYTES):
        ref = self._descriptor(ref)
        if ref['byte_size'] > maximum or ref['mime'] != 'application/json':
            raise DocumentStoreError('DOCUMENT_JSON_TOO_LARGE')
        with self.open_stream(ref) as stream:
            data = stream.read(ref['byte_size'] + 1)
        if len(data) != ref['byte_size'] or hashlib.sha256(data).hexdigest() != ref['sha256']:
            raise DocumentStoreError('DOCUMENT_OBJECT_MISMATCH')
        try:
            return json.loads(data)
        except (ValueError, UnicodeError):
            raise DocumentStoreError('DOCUMENT_INVALID_JSON') from None

    def delete(self, key):
        self._call('delete_object', Key=self._key(key))

    def delete_prefix(self, prefix, *, limit=1000):
        # Caller must first establish terminal state/current generation in the DB.
        prefix = prefix.rstrip('/') + '/'
        self._key(prefix + 'cleanup')  # At least category/job identity; never a bucket/root wipe.
        if not 1 <= limit <= 1000:
            raise ValueError('Cleanup batches must be bounded')
        result = self._call('list_objects_v2', Prefix=prefix, MaxKeys=limit)
        keys = [self._key(item['Key']) for item in result.get('Contents', [])]
        if keys:
            reply = self._call('delete_objects', Delete={'Objects': [{'Key': key} for key in keys], 'Quiet': True})
            if reply.get('Errors'):
                raise DocumentStoreError()
        return {'deleted': len(keys), 'more': bool(result.get('IsTruncated'))}


_store_lock = Lock()
_store = None


def get_document_store():
    """One current-config connection pool per process, never an unbounded cache."""
    global _store
    config = get_document_settings()
    with _store_lock:
        if _store is None or _store.config != config:
            _store = DocumentStore(config)
        return _store
