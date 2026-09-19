"""Private R2 object storage and an explicitly isolated local test adapter.

Originals and final images live remotely. Local objects are disposable stage
checkpoints only; an execution node must be able to rebuild them from R2.
Never log SDK requests or presigned URLs.
"""
from functools import lru_cache
import base64
import os
from typing import Protocol
from uuid import uuid4
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from .config import settings


class StorageError(Exception):
    def __init__(self):
        super().__init__("Private object storage unavailable")


class ObjectStore(Protocol):
    def put(self, key: str, data: bytes, mime: str, *, kind: str | None = None) -> None: ...
    def read(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...
    def download_url(self, key: str, expires: int) -> str | None: ...
    def upload_url(self, key: str, info: dict, expires: int) -> dict | None: ...


def validate_key(key):
    if not key or "\\" in key or ":" in key or any(part in ("", ".", "..") for part in key.split("/")):
        raise ValueError("Invalid storage key")


class LocalStore:
    def path(self, key):
        validate_key(key)
        root = settings().storage_path.resolve()
        path = (root / key).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Invalid storage key")
        return path

    def put(self, key, data, mime, *, kind=None):
        path = self.path(key)
        if key.startswith("objects/sha256/") and path.is_file():
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".{uuid4()}.tmp")
        try:
            with temporary.open("xb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            if key.startswith("objects/sha256/"):
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    pass
            else:
                os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def read(self, key):
        return self.path(key).read_bytes()

    def exists(self, key):
        return self.path(key).is_file()

    def delete(self, key):
        self.path(key).unlink(missing_ok=True)

    def download_url(self, key, expires):
        return None

    def upload_url(self, key, info, expires):
        return None


class S3Store:
    """S3 operations shared by compatible providers; R2 is configured first."""
    def __init__(self, client, bucket, prefix):
        self.client, self.bucket, self.prefix = client, bucket, prefix

    def _params(self, key):
        validate_key(key)
        return {"Bucket": self.bucket, "Key": self.prefix + key}

    def _call(self, operation, **params):
        try:
            return getattr(self.client, operation)(**params)
        except (BotoCoreError, ClientError, OSError):
            raise StorageError() from None

    def put(self, key, data, mime, *, kind=None):
        if kind not in {"original", "upload", "classic", "redraw"}:
            raise ValueError("Remote storage accepts originals, uploads and final translation results only")
        if len(data) > settings().max_upload_bytes:
            raise StorageError()
        params = dict(self._params(key), Body=data, ContentType=mime, CacheControl="private, no-store")
        if key.startswith("objects/sha256/"):
            params["IfNoneMatch"] = "*"
        try:
            self.client.put_object(**params)
        except ClientError as error:
            if params.get("IfNoneMatch") == "*" and error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 412:
                return
            raise StorageError() from None
        except (BotoCoreError, OSError):
            raise StorageError() from None

    def read(self, key):
        body = self._call("get_object", **self._params(key))["Body"]
        try:
            data = body.read(settings().max_upload_bytes + 1)
            if len(data) > settings().max_upload_bytes:
                raise StorageError()
            return data
        except (BotoCoreError, OSError):
            raise StorageError() from None
        finally:
            body.close()

    def exists(self, key):
        try:
            self.client.head_object(**self._params(key))
            return True
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
                return False
            raise StorageError() from None
        except (BotoCoreError, OSError):
            raise StorageError() from None

    def delete(self, key):
        self._call("delete_object", **self._params(key))

    def download_url(self, key, expires):
        try:
            return self.client.generate_presigned_url("get_object", Params=self._params(key), ExpiresIn=expires, HttpMethod="GET")
        except (BotoCoreError, ClientError, OSError):
            raise StorageError() from None

    def upload_url(self, key, info, expires):
        # The URL signs one immutable object, exact length, type and checksum.
        # No remote request is made while the controller holds a lease lock.
        headers = {'Content-Type': info['mime'], 'Content-Length': str(info['byte_size']),
                   'Content-MD5': base64.b64encode(bytes.fromhex(info['md5'])).decode(),
                   'Cache-Control': 'private, no-store', 'If-None-Match': '*'}
        params = {**self._params(key), 'ContentType': info['mime'], 'ContentLength': info['byte_size'],
                  'ContentMD5': headers['Content-MD5'], 'CacheControl': headers['Cache-Control'], 'IfNoneMatch': '*'}
        try:
            url = self.client.generate_presigned_url('put_object', Params=params, ExpiresIn=expires, HttpMethod='PUT')
            return {'url': url, 'headers': headers}
        except (BotoCoreError, ClientError, OSError):
            raise StorageError() from None

@lru_cache(maxsize=4)
def r2_store(endpoint, bucket, access_key, secret_key, prefix, timeout):
    # Explicit credentials avoid ambient AWS credentials and the IMDS chain.
    client = boto3.session.Session().client("s3", endpoint_url=endpoint, region_name="auto",
        aws_access_key_id=access_key, aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                      connect_timeout=timeout, read_timeout=timeout,
                      retries={"mode": "standard", "total_max_attempts": 3},
                      request_checksum_calculation="when_required", response_checksum_validation="when_required"))
    return S3Store(client, bucket, prefix)


def get_store(backend: str) -> ObjectStore:
    if backend == "local":
        return LocalStore()
    cfg = settings()
    if backend == "r2" and cfg.r2_endpoint_url:
        return r2_store(cfg.r2_endpoint_url, cfg.r2_bucket, cfg.r2_access_key_id.get_secret_value(),
                        cfg.r2_secret_access_key.get_secret_value(), cfg.r2_key_prefix, cfg.storage_timeout_seconds)
    raise StorageError()
