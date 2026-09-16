"""Bounded authenticated uploads and immutable validated original images.

The control API accepts an actual bounded byte stream, rather than relying on a
client Content-Length or a presigned PUT that could store an oversized object.
Temporary keys never become worker inputs. The validator reads and validates
one bounded byte buffer and writes those exact bytes to a server-only asset key.
All functions leave transaction ownership to the API/scheduler.
"""
from datetime import timedelta
import asyncio
import hashlib
import re
from fastapi import HTTPException
from sqlalchemy import select
from .assets import available, content_storage_key, create_asset, inspect_image
from .config import settings
from .errors import problem, ProcessingError
from .models import Asset, Job, now, uid
from .storage import get_store, StorageError
from .upload_models import UploadReservation

UPLOAD_ACTIVE = {"awaiting_upload", "uploaded", "validating"}


def _validating(job):
    return bool(job and (job.status == "validating_upload"
                        or (job.status == "running" and job.phase == "validate_upload")))


def _value(descriptor, name, default=None):
    return descriptor.get(name, default) if isinstance(descriptor, dict) else getattr(descriptor, name, default)


def create_upload(db, job, descriptor):
    """Create within the same transaction that admitted/reserved the parent job."""
    expected_hash = _value(descriptor, "sha256")
    expected_size = _value(descriptor, "byte_size", _value(descriptor, "size"))
    mime = _value(descriptor, "mime", "application/octet-stream")
    if not isinstance(expected_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
        problem("INVALID_IMAGE_HASH", "请提供图片的 SHA-256 摘要", 422)
    if type(expected_size) is not int or not 0 < expected_size <= settings().max_upload_bytes:
        problem("IMAGE_TOO_LARGE", "图片字节数超过上传限制", 413)
    if mime not in {"image/png", "image/jpeg", "image/webp", "application/octet-stream"}:
        problem("UNSUPPORTED_IMAGE", "仅支持静态 PNG、JPEG 或 WebP 图片", 422)
    existing = db.scalar(select(UploadReservation).where(UploadReservation.job_id == job.id))
    if existing:
        if existing.expected_sha256 != expected_hash or existing.expected_size != expected_size:
            problem("IDEMPOTENCY_CONFLICT", "上传任务已绑定其他图片", 409)
        return existing
    backend = settings().result_storage_backend
    if backend != "r2" and not settings().dev_auth:
        raise ValueError("Production originals require private R2 storage")
    stamp, reservation_id = now(), uid()
    reservation = UploadReservation(
        id=reservation_id, job_id=job.id, owner_id=job.owner_id, mode=job.mode,
        expected_sha256=expected_hash, expected_size=expected_size, mime=mime,
        storage_key=f"{job.owner_id}/uploads/{reservation_id}", storage_backend=backend,
        status="awaiting_upload", created_at=stamp,
        expires_at=stamp + timedelta(seconds=min(settings().upload_session_ttl_seconds,
                                                settings().upload_session_max_lifetime_seconds)),
        max_expires_at=stamp + timedelta(seconds=settings().upload_session_max_lifetime_seconds))
    db.add(reservation)
    db.flush()
    return reservation


def owned_upload(db, upload_id, owner_id, *, lock=False):
    query = select(UploadReservation).where(UploadReservation.id == upload_id, UploadReservation.owner_id == owner_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    reservation = db.scalar(query)
    if not reservation:
        problem("NOT_FOUND", "找不到此上传任务", 404)
    return reservation


def upload_json(reservation):
    return {"id": reservation.id, "job_id": reservation.job_id, "status": reservation.status,
            "asset_id": reservation.asset_id,
            "url": f"/v1/uploads/{reservation.id}/content", "method": "PUT",
            "headers": {"Content-Type": reservation.mime}, "authorization_required": True,
            "expires_at": reservation.expires_at.isoformat() + "Z",
            "error": ({"code": reservation.error_code, "message": reservation.error_message}
                      if reservation.error_code else None)}


async def read_upload_stream(request, expected_size, *, limits=None):
    """Count bytes including chunked requests; never trust a declared length."""
    maximum = min(settings().max_upload_bytes, expected_size)
    if not 0 < maximum <= settings().max_upload_bytes:
        problem("IMAGE_TOO_LARGE", "图片字节数超过上传限制", 413)
    length = request.headers.get("content-length")
    if length is not None and (not length.isdigit() or int(length) > maximum):
        problem("IMAGE_TOO_LARGE", "上传字节数超过预留限制", 413)
    data = bytearray()
    loop = asyncio.get_running_loop()
    cfg = limits or settings()
    deadline = loop.time() + cfg.upload_body_timeout_seconds
    idle_deadline = loop.time() + cfg.upload_idle_timeout_seconds
    stream = request.stream().__aiter__()
    while True:
        remaining = min(deadline, idle_deadline) - loop.time()
        if remaining <= 0:
            problem("UPLOAD_TIMEOUT", "上传接收超时，请重试", 408)
        try:
            chunk = await asyncio.wait_for(anext(stream), timeout=remaining)
        except StopAsyncIteration:
            break
        except TimeoutError:
            problem("UPLOAD_TIMEOUT", "上传接收超时，请重试", 408)
        if len(data) + len(chunk) > maximum:
            problem("IMAGE_TOO_LARGE", "上传字节数超过预留限制", 413)
        data.extend(chunk)
        if chunk:
            idle_deadline = loop.time() + cfg.upload_idle_timeout_seconds
    if len(data) != expected_size:
        problem("UPLOAD_SIZE_MISMATCH", "实际图片大小与提交清单不一致", 422)
    return bytes(data)


def _owned(reservation, owner):
    owner_id = owner if isinstance(owner, str) else owner.id
    if reservation.owner_id != owner_id:
        problem("NOT_FOUND", "找不到此上传任务", 404)


def _lock_current(db, reservation):
    """Take locks in global scheduler -> upload -> job order after external I/O."""
    from .scheduler import lock_scheduler
    lock_scheduler(db)
    current = db.scalar(select(UploadReservation).where(UploadReservation.id == reservation.id)
                        .with_for_update().execution_options(populate_existing=True))
    if current is None:
        problem("NOT_FOUND", "找不到此上传任务", 404)
    db.scalar(select(Job).where(Job.id == current.job_id).with_for_update(key_share=True)
              .execution_options(populate_existing=True))
    return current


def _fail_locked(db, reservation, code, message, *, status="failed"):
    if reservation.status not in UPLOAD_ACTIVE:
        return None
    from .jobs import settle
    reservation.status, reservation.error_code, reservation.error_message = status, code, message
    reservation.completed_at = now()
    job = db.get(Job, reservation.job_id)
    if job and (job.status == "awaiting_upload" or _validating(job)):
        job.status, job.phase = ("cancelled", "cancelled") if status == "cancelled" else ("failed", "upload_failed")
        job.error_code, job.error_message, job.completed_at = code, message, now()
        from .scheduler import touch_job
        touch_job(db, job)
        settle(db, job, success=False)
    return None


def fail_upload(db, reservation, code, message, *, status="failed", lease_id=None, lease_token=None,
                awaiting_only=False):
    """Persist failure and release exactly the parent reservation; caller commits."""
    reservation = _lock_current(db, reservation)
    _check_validation_lease(db, reservation, lease_id, lease_token, refresh=True)
    if awaiting_only:
        # A request body can fail after another request has already uploaded or
        # queued valid bytes. Only the first, still-unaccepted body may fail the
        # session; malformed retries must not revoke accepted server work.
        job = db.get(Job, reservation.job_id)
        if reservation.status != "awaiting_upload" or not job or job.status != "awaiting_upload":
            return None
    return _fail_locked(db, reservation, code, message, status=status)


def _active_locked(db, reservation):
    if reservation.status not in UPLOAD_ACTIVE:
        return False
    job = db.get(Job, reservation.job_id)
    if reservation.expires_at <= now() and not _validating(job):
        _fail_locked(db, reservation, "UPLOAD_EXPIRED", "上传会话已过期，请重新提交", status="expired")
        return False
    if not job or job.cancel_requested or job.discard_output or not (job.status == "awaiting_upload" or _validating(job)):
        _fail_locked(db, reservation, "UPLOAD_CANCELLED", "上传任务已取消", status="cancelled")
        return False
    return True


def receive_upload(db, reservation, owner, data, *, prewritten=False):
    """Persist bounded staging bytes. API reads the stream before entering a DB lock."""
    _owned(reservation, owner)
    if reservation.status == "verified":
        return reservation
    if reservation.status in {"uploaded", "validating"} and _validating(db.get(Job, reservation.job_id)):
        # A retry cannot reset the priority, lifetime or state of validation work.
        return reservation
    if reservation.status not in UPLOAD_ACTIVE or reservation.expires_at <= now():
        _active_locked(db, _lock_current(db, reservation))
        return reservation
    if len(data) > settings().max_upload_bytes or len(data) != reservation.expected_size:
        fail_upload(db, reservation, "UPLOAD_SIZE_MISMATCH", "实际图片大小与提交清单不一致", awaiting_only=True)
        return reservation
    if hashlib.sha256(data).hexdigest() != reservation.expected_sha256:
        fail_upload(db, reservation, "UPLOAD_HASH_MISMATCH", "实际图片摘要与提交清单不一致", awaiting_only=True)
        return reservation
    if not prewritten:
        get_store(reservation.storage_backend).put(reservation.storage_key, data, reservation.mime, kind="upload")
    reservation = _lock_current(db, reservation)
    if not _active_locked(db, reservation):
        return reservation
    if reservation.status != "awaiting_upload":
        # A concurrent PUT/complete may have accepted these same bytes while
        # this request was in storage I/O. Preserve its state and lifetime.
        return reservation
    reservation.status = "uploaded"
    reservation.expires_at = min(reservation.max_expires_at, now() + timedelta(seconds=settings().upload_session_ttl_seconds))
    return reservation


def _check_validation_lease(db, reservation, lease_id, lease_token, *, refresh=False):
    if lease_id is None:
        return
    from .scheduler import current_lease
    if refresh:
        # Refresh the lease and stage as well as the job. A cached pre-I/O lease
        # must not let a late node finish after another node acquired its work.
        db.expire_all()
    lease, stage, job = current_lease(db, lease_id, lease_token)
    if job.id != reservation.job_id or stage.name != "validate_upload":
        raise ProcessingError("LEASE_EXPIRED", "上传校验授权与此任务不匹配")


def _verified_asset(db, reservation):
    asset = db.get(Asset, reservation.asset_id)
    if not available(asset):
        raise ProcessingError("ASSET_EXPIRED", "原图已删除或过期")
    return asset


def complete_upload(db, reservation, owner, *, lease_id=None, lease_token=None):
    """Return the validated asset, or None with a durable per-page failure receipt.

    Storage outages propagate as StorageError and leave the task retryable. An
    uncertain staging PUT is safe to repeat because bytes must match its digest.
    """
    _owned(reservation, owner)
    _check_validation_lease(db, reservation, lease_id, lease_token)
    if reservation.status == "verified":
        return _verified_asset(db, reservation)
    if reservation.status not in UPLOAD_ACTIVE or (reservation.expires_at <= now()
                                                  and not _validating(db.get(Job, reservation.job_id))):
        _active_locked(db, _lock_current(db, reservation))
        return None
    if reservation.status not in {"uploaded", "validating"}:
        problem("UPLOAD_INCOMPLETE", "请先完成图片上传", 409)
    store = get_store(reservation.storage_backend)
    data = store.read(reservation.storage_key)
    if len(data) != reservation.expected_size or hashlib.sha256(data).hexdigest() != reservation.expected_sha256:
        return fail_upload(db, reservation, "UPLOAD_HASH_MISMATCH", "实际图片与提交清单不一致",
                           lease_id=lease_id, lease_token=lease_token)
    try:
        info = inspect_image(data)
    except HTTPException as exc:
        return fail_upload(db, reservation, exc.detail["code"], exc.detail["message"],
                           lease_id=lease_id, lease_token=lease_token)
    if reservation.mime not in {"application/octet-stream", info["mime"]}:
        return fail_upload(db, reservation, "UPLOAD_MIME_MISMATCH", "实际图片格式与提交清单不一致",
                           lease_id=lease_id, lease_token=lease_token)
    # The stable server-only key survives uncertain PUTs/transaction rollbacks.
    # Never COPY from the temporary key after validation: it may have changed.
    store.put(content_storage_key(info["sha256"]), data, info["mime"], kind="original")
    reservation = _lock_current(db, reservation)
    _check_validation_lease(db, reservation, lease_id, lease_token, refresh=True)
    if reservation.status == "verified":
        return _verified_asset(db, reservation)
    if not _active_locked(db, reservation):
        return None
    asset = create_asset(db, reservation.owner_id, data, stable_id=reservation.id,
                         storage_backend=reservation.storage_backend, prewritten=True, verified_info=info)
    job = db.get(Job, reservation.job_id)
    job.input_asset_id, job.status, job.phase = asset.id, "queued", "queued"
    if not job.input_pinned:
        asset.active_references += 1
        job.input_pinned = True
    from .scheduler import ensure_stages
    ensure_stages(db, job)
    reservation.asset_id, reservation.status, reservation.completed_at = asset.id, "verified", now()
    # Retain staging bytes through commit. No age-based orphan sweep is used.
    return asset


def expire_uploads(db, *, limit=100):
    from .scheduler import lock_scheduler
    lock_scheduler(db)
    reservations = db.scalars(select(UploadReservation).join(Job, Job.id == UploadReservation.job_id).where(
        UploadReservation.status.in_({"awaiting_upload", "uploaded"}), UploadReservation.expires_at <= now(),
        Job.status == "awaiting_upload")
        .order_by(UploadReservation.expires_at, UploadReservation.id).limit(limit)
        .with_for_update(skip_locked=True)).all()
    for reservation in reservations:
        _fail_locked(db, reservation, "UPLOAD_EXPIRED", "上传会话已过期，请重新提交", status="expired")
    return len(reservations)
