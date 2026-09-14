from datetime import timedelta
import hashlib
from io import BytesIO
import os
from pathlib import Path
import warnings
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session
from .config import settings
from .errors import problem, ProcessingError
from .models import Asset, now, uid

MIMES = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


def inspect_image(data: bytes, *, output=False):
    cfg = settings()
    try:
        if not data or len(data) > cfg.max_upload_bytes:
            raise ValueError("size")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format not in MIMES or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("format")
                width, height = image.size
                mime = MIMES[image.format]
                if width < 1 or height < 1 or width * height > cfg.max_pixels or max(width, height) > cfg.max_dimension:
                    raise ValueError("dimensions")
                image.verify()
            with Image.open(BytesIO(data)) as image:
                image.load()
        return {"width": width, "height": height, "mime": mime, "byte_size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        if output:
            raise ProcessingError("INVALID_PROVIDER_OUTPUT", "供应商未返回符合限制的有效图片") from exc
        if str(exc) in ("size", "dimensions"):
            problem("IMAGE_TOO_LARGE", f"图片超过限制：{cfg.max_upload_bytes // 1024 // 1024} MB、{cfg.max_pixels // 1_000_000} 百万像素、单边 {cfg.max_dimension} 像素", 413)
        problem("UNSUPPORTED_IMAGE", "请选择可正常解码的静态 PNG、JPEG 或 WebP 图片", 422)


def object_path(key: str) -> Path:
    root = settings().storage_path.resolve()
    path = (root / key).resolve()
    if not path.is_relative_to(root):
        raise ValueError("Invalid storage key")
    return path


def write_object(key: str, data: bytes):
    path = object_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{uid()}.tmp")
    try:
        with temporary.open("xb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def create_asset(db: Session, owner_id: str, data: bytes, *, kind="original", parent_id=None, stable_id=None):
    info = inspect_image(data, output=kind != "original")
    asset_id = stable_id or uid()
    key = f"{owner_id}/{asset_id}"
    write_object(key, data)
    expires_at = now() + timedelta(days=settings().retention_days)
    if parent_id:
        parent = db.get(Asset, parent_id)
        if not parent or parent.owner_id != owner_id:
            raise ProcessingError("INVALID_PROVIDER_OUTPUT", "结果原图的访问归属无效")
        expires_at = min(expires_at, parent.expires_at)
    asset = Asset(id=asset_id, owner_id=owner_id, storage_key=key, kind=kind, parent_id=parent_id, expires_at=expires_at, **info)
    db.add(asset)
    db.flush()
    return asset


def available(asset: Asset | None):
    return bool(asset and not asset.deleted_at and asset.expires_at > now() and object_path(asset.storage_key).is_file())


def owned_asset(db: Session, asset_id: str, owner_id: str):
    asset = db.get(Asset, asset_id)
    if not asset or asset.owner_id != owner_id:
        problem("NOT_FOUND", "找不到此图片", 404)
    if not available(asset) or (asset.parent_id and not available(db.get(Asset, asset.parent_id))):
        problem("ASSET_EXPIRED", "图片已删除或过期，请重新上传本地原图", 410)
    return asset


def asset_json(asset: Asset):
    return {"id": asset.id, "width": asset.width, "height": asset.height, "mime": asset.mime, "sha256": asset.sha256, "byte_size": asset.byte_size, "kind": asset.kind, "expires_at": asset.expires_at.isoformat() + "Z"}


async def upload_bytes(image):
    data = await image.read(settings().max_upload_bytes + 1)
    await image.close()
    return data
