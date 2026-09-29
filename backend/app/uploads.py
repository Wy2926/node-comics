"""Bounded authenticated uploads and immutable validated original images.

The control API accepts an actual bounded byte stream, rather than relying on a
client Content-Length alone. Ingress validates a temporary file and publishes
the immutable original once.
Recovery rereads only that validated original after an uncertain write/commit.
All functions leave transaction ownership to the API/scheduler.
"""
from datetime import timedelta
import asyncio
import errno
import hashlib
import re
from fastapi import HTTPException
from sqlalchemy import select
from .assets import available, asset_storage_key, create_asset, inspect_image
from .config import settings
from .errors import problem, ProcessingError
from .models import Asset, Job, now, uid
from .storage import get_store, StorageError
from .upload_models import UploadReservation

UPLOAD_ACTIVE = {"awaiting_upload", "validating"}


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
    stamp, reservation_id = now(), uid()
    reservation = UploadReservation(
        id=reservation_id, job_id=job.id, owner_id=job.owner_id, mode=job.mode,
        expected_sha256=expected_hash, expected_size=expected_size, mime=mime,
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


async def read_upload_stream(request, expected_size, *, limits=None):
    """Bounded streaming ingress into the center volume, never a page-sized bytearray."""
    from tempfile import NamedTemporaryFile
    from starlette.concurrency import run_in_threadpool
    cfg = limits or settings()
    maximum = min(settings().max_upload_bytes, expected_size)
    if not 0 < maximum <= settings().max_upload_bytes:
        problem('IMAGE_TOO_LARGE', '图片字节数超过限制', 413)
    length = request.headers.get('content-length')
    if length is not None and (not length.isdigit() or int(length) > maximum):
        problem('IMAGE_TOO_LARGE', '上传字节数超过预留限制', 413)
    root = settings().storage_path
    (root / 'staging').mkdir(mode=0o700, parents=True, exist_ok=True)
    handle = NamedTemporaryFile(mode='w+b', prefix='input-', suffix='.part', dir=root / 'staging')
    try:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + cfg.upload_body_timeout_seconds
        idle_deadline = loop.time() + cfg.upload_idle_timeout_seconds
        stream, received = request.stream().__aiter__(), 0
        while True:
            remaining = min(deadline, idle_deadline) - loop.time()
            if remaining <= 0:
                problem('UPLOAD_TIMEOUT', '上传接收超时，请重试', 408)
            try:
                chunk = await asyncio.wait_for(anext(stream), timeout=remaining)
            except StopAsyncIteration:
                break
            except TimeoutError:
                problem('UPLOAD_TIMEOUT', '上传接收超时，请重试', 408)
            received += len(chunk)
            if received > maximum:
                problem('IMAGE_TOO_LARGE', '上传字节数超过预留限制', 413)
            await run_in_threadpool(handle.write, chunk)
            if chunk:
                idle_deadline = loop.time() + cfg.upload_idle_timeout_seconds
        if received != expected_size:
            problem('UPLOAD_SIZE_MISMATCH', '实际图片大小与提交清单不一致', 422)
        handle.flush()
        handle.seek(0)
        return handle
    except OSError as error:
        handle.close()
        raise StorageError('STORAGE_FULL' if error.errno == errno.ENOSPC else 'STORAGE_UNAVAILABLE') from None
    except BaseException:
        handle.close()
        raise


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
    if reservation.expires_at <= now() and not reservation.verified_info and not _validating(job):
        _fail_locked(db, reservation, "INPUT_EXPIRED", "原图输入已过期，请手动重试", status="expired")
        return False
    if not job or job.cancel_requested or job.discard_output or not (job.status == "awaiting_upload" or _validating(job)):
        _fail_locked(db, reservation, "UPLOAD_CANCELLED", "上传任务已取消", status="cancelled")
        return False
    return True


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
    if not asset or asset.deleted_at:
        raise ProcessingError("ASSET_EXPIRED", "输入描述已删除或过期")
    return asset


def complete_upload(db, reservation, owner, *, lease_id=None, lease_token=None):
    """Return the validated asset, or None with a durable per-page failure receipt.

    Storage outages propagate as StorageError and leave the task retryable.
    Recovery reads the immutable original; it never writes a second copy.
    """
    _owned(reservation, owner)
    _check_validation_lease(db, reservation, lease_id, lease_token)
    if reservation.status == "verified":
        return _verified_asset(db, reservation)
    if reservation.status not in UPLOAD_ACTIVE or (reservation.expires_at <= now()
                                                  and not _validating(db.get(Job, reservation.job_id))):
        _active_locked(db, _lock_current(db, reservation))
        return None
    if reservation.status != "validating" or not reservation.verified_info:
        problem("UPLOAD_INCOMPLETE", "请先完成图片上传", 409)
    store = get_store()
    key = asset_storage_key(reservation.id, "original")
    db.commit()  # Release the pooled connection during object I/O.
    data = store.read(key)
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
    return accept_verified_upload(db, reservation, data, info, lease_id=lease_id, lease_token=lease_token)


def accept_verified_upload(db, reservation, data, info, *, lease_id=None, lease_token=None):
    """Publish only after exact validated bytes have been durably written."""
    reservation = _lock_current(db, reservation)
    _check_validation_lease(db, reservation, lease_id, lease_token, refresh=True)
    if reservation.status == "verified":
        return _verified_asset(db, reservation)
    if not _active_locked(db, reservation):
        return None
    asset = create_asset(db, reservation.owner_id, data, stable_id=reservation.id,
                         prewritten=True, verified_info=info)
    job = db.get(Job, reservation.job_id)
    asset.purged_at, asset.expires_at = None, None
    job.input_asset_id, job.status, job.phase = asset.id, "queued", "queued"
    if not job.input_pinned:
        asset.active_references += 1
        job.input_pinned = True
    from .scheduler import ensure_stages
    ensure_stages(db, job)
    reservation.asset_id, reservation.status, reservation.completed_at = asset.id, "verified", now()
    return asset


def expire_uploads(db, *, limit=100):
    from .scheduler import lock_scheduler
    lock_scheduler(db)
    reservations = db.scalars(select(UploadReservation).join(Job, Job.id == UploadReservation.job_id).where(
        UploadReservation.status == "awaiting_upload", UploadReservation.expires_at <= now(),
        Job.status == "awaiting_upload", UploadReservation.verified_info["sha256"].as_string().is_(None))
        .order_by(UploadReservation.expires_at, UploadReservation.id).limit(limit)
        .with_for_update(skip_locked=True)).all()
    for reservation in reservations:
        _fail_locked(db, reservation, "INPUT_EXPIRED", "原图输入已过期，请手动重试", status="expired")
    return len(reservations)


def recover_received_uploads(limit=100):
    """Schedule validation of immutable originals written before an API crash.

    The validated identity was committed before storage I/O. Inspect only bounded
    receipts whose ingress lease is gone, then use the existing fenced worker
    stage to reread and verify bytes. No database connection spans object I/O.
    """
    from .db import session_factory
    from .upload_ingress import ingress_snapshot
    from .queue_models import JobStage
    from .scheduler import lock_scheduler, touch_job
    with session_factory()() as db:
        rows = db.execute(select(UploadReservation.id,
            UploadReservation.expected_sha256, UploadReservation.expires_at)
            .where(UploadReservation.status == 'awaiting_upload', UploadReservation.verified_info["sha256"].as_string().is_not(None))
            .order_by(UploadReservation.created_at).limit(limit)).all()
    _, active = ingress_snapshot([row.id for row in rows])
    restored = 0
    for row in rows:
        if active[row.id]:
            continue
        try:
            present = get_store().exists(asset_storage_key(row.id, "original"))
        except (StorageError, OSError):
            continue
        if not present and row.expires_at > now():
            continue
        with session_factory()() as db:
            lock_scheduler(db)
            receipt = db.get(UploadReservation, row.id)
            if not receipt or receipt.status != 'awaiting_upload':
                continue
            if ingress_snapshot([row.id])[1][row.id]:
                continue
            if present:
                job = db.get(Job, receipt.job_id)
                if not _active_locked(db, receipt):
                    db.commit()
                    continue
                receipt.status = 'validating'
                job.status, job.phase = 'validating_upload', 'validating_upload'
                if not db.scalar(select(JobStage.id).where(JobStage.job_id == job.id, JobStage.name == 'validate_upload')):
                    db.add(JobStage(job_id=job.id, name='validate_upload', status='ready'))
                touch_job(db, job)
                restored += 1
            else:
                _fail_locked(db, receipt, 'INPUT_EXPIRED', '原图输入已过期，请手动重试', status='expired')
            db.commit()
    return restored


def pause_missing_input(db, job):
    """Preserve admission/settlement and checkpoints while the client repairs input."""
    receipt = db.scalar(select(UploadReservation).where(UploadReservation.job_id == job.id))
    if receipt is None:
        from .assets import descriptor_available
        source = db.get(Asset, job.input_asset_id)
        if not descriptor_available(source):
            return False
        receipt = create_upload(db, job, {'sha256': source.sha256, 'byte_size': source.byte_size, 'mime': source.mime})
        receipt.asset_id = source.id
    source = db.get(Asset, job.input_asset_id) if job.input_asset_id else None
    if source:
        # Keep the immutable descriptor but use this reservation's private path.
        source.storage_key = asset_storage_key(receipt.id, 'original')
        source.purged_at, source.expires_at = None, None
    receipt.status, receipt.verified_info, receipt.error_code, receipt.error_message = 'awaiting_upload', None, None, None
    receipt.completed_at = None
    receipt.expires_at = now() + timedelta(seconds=settings().upload_session_ttl_seconds)
    receipt.max_expires_at = receipt.expires_at
    job.status, job.phase = 'awaiting_upload', 'restore_input'
    from .scheduler import touch_job
    touch_job(db, job)
    return True
