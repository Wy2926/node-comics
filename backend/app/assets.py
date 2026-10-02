import hashlib
from io import BytesIO
from sqlalchemy import event, select
from sqlalchemy.orm import Session
from .config import settings
from .errors import problem, ProcessingError
from .image_metadata import image_metadata
from .models import Asset, now, uid
from .storage import get_store, LocalStore

def inspect_image(data: bytes, *, output=False):
    return inspect_image_file(BytesIO(data), output=output)


def inspect_image_file(handle, *, output=False):
    """Validate bounded bytes and metadata; pixel validity belongs to the node."""
    cfg = settings()
    handle.seek(0, 2)
    length = handle.tell()
    handle.seek(0)
    maximum = cfg.cluster_max_result_bytes if output else cfg.max_upload_bytes
    try:
        if not 0 < length <= maximum:
            raise ValueError('size')
        metadata = image_metadata(handle)
        if max(metadata['width'], metadata['height']) > cfg.max_dimension:
            raise ValueError('dimensions')
        if not output and (metadata['icc_profile'] or metadata['orientation'] != 1):
            problem('INPUT_NOT_NORMALIZED', '请先规范化原图方向和色彩', 422)
        sha = hashlib.file_digest(handle, 'sha256').hexdigest()
    except (ValueError, OSError) as error:
        if output:
            raise ProcessingError('INVALID_PROVIDER_OUTPUT', '供应商图片容器或元数据无效') from error
        if str(error) in ('size', 'dimensions'):
            problem('IMAGE_TOO_LARGE', f'图片超过限制：{maximum // 1024 // 1024} MB、单边 {cfg.max_dimension} 像素', 413)
        problem('UNSUPPORTED_IMAGE', '请选择静态 PNG、JPEG 或 WebP 图片', 422)
    finally:
        handle.seek(0)
    return {key: metadata[key] for key in ('width', 'height', 'mime')} | {'byte_size': length, 'sha256': sha}


def object_path(key: str):
    return LocalStore().path(key)


def asset_storage_key(asset_id, kind):
    return f"inputs/{asset_id}/source" if kind == 'original' else f"results/{asset_id[:2]}/{asset_id}"


def descriptor_available(asset):
    return bool(asset and not asset.deleted_at)


def create_asset(db: Session, owner_id: str, data: bytes, *, kind="original", parent_id=None, stable_id=None,
                 prewritten=False, verified_info=None, representation=None,
                 bbox=None, normalization_version=1, storage_key=None):
    info = verified_info if verified_info is not None else inspect_image(data, output=kind != "original")
    if verified_info is not None and not prewritten:
        raise ValueError("Prevalidated metadata requires a prewritten file")
    asset_id = stable_id or uid()
    key = storage_key or asset_storage_key(asset_id, kind)
    parent = db.get(Asset, parent_id) if parent_id else None
    if parent_id and (not parent or parent.owner_id != owner_id):
        raise ProcessingError("INVALID_PROVIDER_OUTPUT", "结果输入描述的访问归属无效")
    representation = representation or ('original' if kind == 'original' else 'full-image-v1')
    existing = db.get(Asset, asset_id)
    if existing:
        if (existing.owner_id != owner_id or existing.sha256 != info['sha256'] or existing.kind != kind
                or existing.parent_id != parent_id or existing.storage_key != key
                or existing.representation != representation or existing.bbox != bbox):
            raise ProcessingError('ASSET_ID_CONFLICT', '文件编号已绑定其他结果')
        return existing
    if not prewritten:
        get_store().put(key, data, info['mime'], kind=kind)
    if not get_store().exists(key):
        raise ProcessingError('STORAGE_UNAVAILABLE', '文件尚未耐久保存')
    asset = Asset(id=asset_id, owner_id=owner_id, storage_key=key, kind=kind,
        parent_id=parent_id, representation=representation, bbox=bbox, normalization_version=normalization_version,
        expires_at=None, **info)
    db.add(asset)
    db.flush()
    return asset


def available(asset: Asset | None):
    return bool(asset and not asset.deleted_at and not asset.purged_at
        and (asset.expires_at is None or asset.expires_at > now() or asset.active_references > 0)
        and get_store().exists(asset.storage_key))


def read_asset(asset: Asset):
    return get_store().read(asset.storage_key)



def owned_asset(db: Session, asset_id: str, owner_id: str):
    asset = db.get(Asset, asset_id)
    if not asset or asset.owner_id != owner_id:
        problem("NOT_FOUND", "找不到此图片", 404)
    if not available(asset):
        problem("ASSET_EXPIRED", "图片已删除或过期，请重新上传本地原图", 410)
    return asset



async def upload_bytes(image):
    data = await image.read(settings().max_upload_bytes + 1)
    await image.close()
    return data


def schedule_input_cleanup(db, job):
    """Revoke execution access in the terminal transaction; unlink only after commit."""
    if not job.input_asset_id:
        return
    source = db.get(Asset, job.input_asset_id)
    if source and source.kind == 'original':
        source.expires_at = now()
        db.info.setdefault('cleanup_inputs', set()).add(source.id)


def cleanup_inputs(asset_ids):
    from .db import session_factory
    from .models import Job
    from .scheduler import ACTIVE
    for asset_id in asset_ids:
        with session_factory()() as db:
            source = db.get(Asset, asset_id)
            if not source or source.kind != 'original' or source.purged_at:
                continue
            if db.scalar(select(Job.id).where(Job.input_asset_id == asset_id, Job.status.in_(ACTIVE)).limit(1)):
                continue
            try:
                get_store().delete(source.storage_key)
            except OSError:
                continue
            source.purged_at = now()
            db.commit()


@event.listens_for(Session, 'after_commit')
def _cleanup_after_commit(session):
    ids = session.info.pop('cleanup_inputs', set())
    if ids:
        try:
            cleanup_inputs(ids)
        except Exception:
            import logging
            logging.getLogger(__name__).warning('Deferred input file cleanup')


@event.listens_for(Session, 'after_rollback')
def _discard_uncommitted_cleanup(session):
    session.info.pop('cleanup_inputs', None)
