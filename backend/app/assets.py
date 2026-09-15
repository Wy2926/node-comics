from datetime import timedelta
import hashlib
from io import BytesIO
import warnings
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session
from .config import settings
from .errors import problem, ProcessingError
from .models import Asset, now, uid
from .storage import get_store, LocalStore

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


def object_path(key: str):
    return LocalStore().path(key)


def write_object(key: str, data: bytes):
    LocalStore().put(key, data, "application/octet-stream")


def create_asset(db: Session, owner_id: str, data: bytes, *, kind="original", parent_id=None, stable_id=None, storage_backend=None):
    info = inspect_image(data, output=kind != "original")
    asset_id = stable_id or uid()
    key = f"{owner_id}/{asset_id}"
    backend = storage_backend or ("local" if kind == "original" else settings().result_storage_backend)
    expires_at = now() + timedelta(days=settings().retention_days)
    if parent_id:
        parent = db.get(Asset, parent_id)
        if not parent or parent.owner_id != owner_id:
            raise ProcessingError("INVALID_PROVIDER_OUTPUT", "结果原图的访问归属无效")
        expires_at = min(expires_at, parent.expires_at)
    get_store(backend).put(key, data, info["mime"])
    asset = Asset(id=asset_id, owner_id=owner_id, storage_key=key, storage_backend=backend, kind=kind, parent_id=parent_id, expires_at=expires_at, **info)
    db.add(asset)
    db.flush()
    return asset


def available(asset: Asset | None):
    return bool(asset and not asset.deleted_at and asset.expires_at > now() and get_store(asset.storage_backend).exists(asset.storage_key))


def read_asset(asset: Asset):
    return get_store(asset.storage_backend).read(asset.storage_key)


def delete_asset_object(asset: Asset):
    get_store(asset.storage_backend).delete(asset.storage_key)


def access_json(asset: Asset):
    if asset.storage_backend == "local":
        return {"url": f"/v1/images/{asset.id}/content", "expires_at": asset.expires_at.isoformat() + "Z", "authorization_required": True}
    current = now().replace(microsecond=0)
    ttl = min(settings().storage_url_ttl_seconds, int((asset.expires_at - now()).total_seconds()) - 1)
    if ttl < 1:
        problem("ASSET_EXPIRED", "图片已过期", 410)
    return {"url": get_store(asset.storage_backend).download_url(asset.storage_key, ttl),
            "expires_at": (current + timedelta(seconds=ttl)).isoformat() + "Z", "authorization_required": False}


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
