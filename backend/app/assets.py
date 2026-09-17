from datetime import timedelta
from contextlib import contextmanager
import hashlib
from io import BytesIO
import warnings
from PIL import Image, UnidentifiedImageError
from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session
from .config import settings
from .errors import problem, ProcessingError
from .models import Asset, now, uid
from .storage import get_store, LocalStore

MIMES = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


@contextmanager
def decoded_image(data: bytes, *, output=False):
    """Validate once and keep decoded pixels available to the caller."""
    cfg = settings()
    image = None
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
            image = Image.open(BytesIO(data))
            image.load()
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        if image is not None:
            image.close()
        if output:
            raise ProcessingError("INVALID_PROVIDER_OUTPUT", "供应商未返回符合限制的有效图片") from exc
        if str(exc) in ("size", "dimensions"):
            problem("IMAGE_TOO_LARGE", f"图片超过限制：{cfg.max_upload_bytes // 1024 // 1024} MB、{cfg.max_pixels // 1_000_000} 百万像素、单边 {cfg.max_dimension} 像素", 413)
        problem("UNSUPPORTED_IMAGE", "请选择可正常解码的静态 PNG、JPEG 或 WebP 图片", 422)
    try:
        yield image, {"width": width, "height": height, "mime": mime,
                      "byte_size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    finally:
        image.close()


def inspect_image(data: bytes, *, output=False):
    with decoded_image(data, output=output) as (_, info):
        return info


def object_path(key: str):
    return LocalStore().path(key)


def write_object(key: str, data: bytes):
    LocalStore().put(key, data, "application/octet-stream")


def retention_deadline():
    days = settings().retention_days
    return now() + timedelta(days=days) if days else None


def extend_original_retention(db, original, deadline):
    """A result cannot outlive its source; NULL means unlimited retention."""
    condition = Asset.expires_at.is_not(None) if deadline is None else Asset.expires_at < deadline
    db.execute(update(Asset).where(Asset.id == original.id, condition).values(expires_at=deadline))


def content_storage_key(sha256):
    return f"objects/sha256/{sha256[:2]}/{sha256}"


def grant_asset(db, owner_id, source, *, parent_id=None):
    """Create an account-local reference without copying shared image bytes."""
    if source.owner_id == owner_id and source.parent_id == parent_id:
        return source
    asset = Asset(owner_id=owner_id, kind=source.kind, parent_id=parent_id,
        storage_key=source.storage_key, storage_backend=source.storage_backend,
        sha256=source.sha256, mime=source.mime, width=source.width, height=source.height,
        byte_size=source.byte_size, expires_at=retention_deadline())
    db.add(asset)
    db.flush()
    if parent_id:
        extend_original_retention(db, db.get(Asset, parent_id), asset.expires_at)
    return asset


def find_shared_original(db, owner_id, sha256, *, byte_size=None, mime=None):
    """A submitted content digest can claim a verified shared original.

    Object sharing is explicit product behavior. Asset IDs, jobs and file names
    remain private to each account; no remote I/O is needed for this lookup.
    """
    rows = db.scalars(select(Asset).where(Asset.kind == "original", Asset.sha256 == sha256,
        Asset.deleted_at.is_(None), Asset.purged_at.is_(None),
        or_(Asset.expires_at.is_(None), Asset.expires_at > now(), Asset.active_references > 0))
        .order_by((Asset.owner_id == owner_id).desc(), Asset.created_at.desc(), Asset.id))
    for source in rows:
        if not available(source):
            continue
        if byte_size is not None and source.byte_size != byte_size:
            problem("UPLOAD_SIZE_MISMATCH", "图片大小与已验证内容不一致", 422)
        if mime not in (None, "application/octet-stream", source.mime):
            problem("UPLOAD_MIME_MISMATCH", "图片格式与已验证内容不一致", 422)
        return grant_asset(db, owner_id, source)
    return None


def create_asset(db: Session, owner_id: str, data: bytes, *, kind="original", parent_id=None, stable_id=None,
                 storage_backend=None, prewritten=False, verified_info=None):
    # Internal control-service callers may prewrite a validated buffer outside
    # scheduler locks, then finalize metadata in a short transaction. Neither
    # prewritten nor verified_info is accepted from a public API request.
    info = verified_info if verified_info is not None else inspect_image(data, output=kind != "original")
    if verified_info is not None and not prewritten:
        raise ValueError("Prevalidated metadata requires a prewritten object")
    asset_id = stable_id or uid()
    is_result = kind in {"classic", "redraw"}
    is_durable = is_result or kind == "original"
    key = content_storage_key(info["sha256"]) if is_durable else f"{owner_id}/{asset_id}"
    if not is_durable and storage_backend not in (None, "local"):
        raise ValueError("Intermediate images must use disposable local storage")
    backend = (storage_backend or settings().result_storage_backend) if is_durable else "local"
    if is_durable and backend == "local" and not settings().dev_auth:
        raise ValueError("Production originals and results require private R2 storage")
    expires_at = retention_deadline() if is_durable else now() + timedelta(days=1)
    parent = None
    if parent_id:
        parent = db.get(Asset, parent_id)
        if not parent or parent.owner_id != owner_id:
            raise ProcessingError("INVALID_PROVIDER_OUTPUT", "结果原图的访问归属无效")
        if not is_result and parent.expires_at is not None:
            expires_at = min(expires_at, parent.expires_at)
    existing = db.get(Asset, asset_id)
    if existing:
        if (existing.owner_id != owner_id or existing.sha256 != info["sha256"]
                or existing.kind != kind or existing.parent_id != parent_id):
            raise ProcessingError("ASSET_ID_CONFLICT", "图片写入编号已被其他内容使用")
        return existing
    if not prewritten:
        # Metadata hits avoid even sending a repeated PUT; the store also fences
        # concurrent first writes with an immutable content-addressed key.
        existing_object = db.scalar(select(Asset).where(Asset.storage_backend == backend,
            Asset.storage_key == key, Asset.deleted_at.is_(None), Asset.purged_at.is_(None)).limit(1))
        if not existing_object or not available(existing_object):
            get_store(backend).put(key, data, info["mime"], kind=kind)
    if parent is not None and is_result:
        # Conditional UPDATE avoids shortening retention when different nodes
        # finish translations of one original concurrently. Do it after object
        # PUT so no parent write lock spans the remote transfer.
        extend_original_retention(db, parent, expires_at)
    asset = Asset(id=asset_id, owner_id=owner_id, storage_key=key, storage_backend=backend, kind=kind, parent_id=parent_id, expires_at=expires_at, **info)
    db.add(asset)
    db.flush()
    return asset


def available(asset: Asset | None):
    # Routine job queries/cache matching must not issue remote HEAD requests.
    # Database tombstones/expiry remain authoritative; the signed GET discovers
    # missing objects. Local existence checks are cheap and retained.
    return bool(asset and not asset.deleted_at and not asset.purged_at
                and (asset.expires_at is None or asset.expires_at > now() or getattr(asset, "active_references", 0) > 0)
                and (asset.storage_backend != "local" or get_store(asset.storage_backend).exists(asset.storage_key)))


def read_asset(asset: Asset):
    return get_store(asset.storage_backend).read(asset.storage_key)


def delete_asset_object(asset: Asset):
    # A user deletes their grant, not the shared physical image. Durable objects
    # are retained even with no DB references (including after DB restoration).
    if asset.kind not in {"original", "classic", "redraw"}:
        get_store(asset.storage_backend).delete(asset.storage_key)


def access_json(asset: Asset):
    if asset.storage_backend == "local":
        return {"url": f"/v1/images/{asset.id}/content", "expires_at": asset.expires_at.isoformat() + "Z" if asset.expires_at else None, "authorization_required": True}
    current = now().replace(microsecond=0)
    ttl = settings().storage_url_ttl_seconds
    if asset.expires_at is not None and not getattr(asset, "active_references", 0):
        ttl = min(ttl, int((asset.expires_at - now()).total_seconds()) - 1)
    if ttl < 1:
        problem("ASSET_EXPIRED", "图片已过期", 410)
    return {"url": get_store(asset.storage_backend).download_url(asset.storage_key, ttl),
            "expires_at": (current + timedelta(seconds=ttl)).isoformat() + "Z", "authorization_required": False}


def record_user_access(db, asset):
    # Signing/downloading in the product is a user access. Worker reads and
    # metadata polling intentionally do not affect future inactivity policies.
    stamp = now()
    db.execute(update(Asset).where(Asset.id == asset.id,
        or_(Asset.last_accessed_at.is_(None), Asset.last_accessed_at < stamp)).values(last_accessed_at=stamp))


def owned_asset(db: Session, asset_id: str, owner_id: str):
    asset = db.get(Asset, asset_id)
    if not asset or asset.owner_id != owner_id:
        problem("NOT_FOUND", "找不到此图片", 404)
    if not available(asset) or (asset.parent_id and not available(db.get(Asset, asset.parent_id))):
        problem("ASSET_EXPIRED", "图片已删除或过期，请重新上传本地原图", 410)
    return asset


def asset_json(asset: Asset):
    return {"id": asset.id, "width": asset.width, "height": asset.height, "mime": asset.mime, "sha256": asset.sha256, "byte_size": asset.byte_size, "kind": asset.kind, "expires_at": asset.expires_at.isoformat() + "Z" if asset.expires_at else None}


async def upload_bytes(image):
    data = await image.read(settings().max_upload_bytes + 1)
    await image.close()
    return data
