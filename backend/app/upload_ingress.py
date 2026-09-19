"""Cross-replica ingress leases; no database transaction spans client or R2 I/O."""
import asyncio
from dataclasses import dataclass
from datetime import timedelta
import hashlib
from fastapi import HTTPException
from sqlalchemy import delete, select, update
from starlette.concurrency import run_in_threadpool
from .assets import owned_asset, inspect_image, content_storage_key
from .db import session_factory
from .errors import problem
from .models import now, uid
from .scheduler import lock_scheduler
from .storage import get_store
from .system_settings import RequestLimits, get_request_limits
from .upload_models import UploadIngressLease, UploadIngressMutex
from .uploads import _active_locked, _lock_current, fail_upload, owned_upload, read_upload_stream, accept_verified_upload, upload_json


@dataclass(frozen=True)
class Ingress:
    id: str
    upload_id: str
    owner_id: str
    expected_size: int
    limits: RequestLimits


def response_for(receipt):
    if receipt.error_code:
        problem(receipt.error_code, receipt.error_message, 422)
    return upload_json(receipt)


def acquire_ingress(upload_id, owner_id):
    with session_factory()() as db:
        cfg = get_request_limits(db)
        receipt = owned_upload(db, upload_id, owner_id)
        if receipt.status != "awaiting_upload":
            if receipt.status == "verified":
                owned_asset(db, receipt.asset_id, owner_id)
            return response_for(receipt)
        if not _active_locked(db, _lock_current(db, receipt)):
            db.commit()
            return response_for(receipt)
        expected_size = receipt.expected_size
        db.commit()
    # Never hold the ingress mutex while waiting for scheduler/job locks.
    with session_factory()() as db:
        if db.get_bind().dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import insert
        else:
            from sqlalchemy.dialects.sqlite import insert
        db.execute(insert(UploadIngressMutex).values(id=1).on_conflict_do_nothing(index_elements=["id"]))
        db.scalar(select(UploadIngressMutex).where(UploadIngressMutex.id == 1).with_for_update())
        at = now()
        db.execute(delete(UploadIngressLease).where(UploadIngressLease.expires_at <= at))
        active = db.execute(select(UploadIngressLease.upload_id, UploadIngressLease.owner_id)).all()
        if (any(row.upload_id == upload_id for row in active)
                or sum(row.owner_id == owner_id for row in active) >= cfg.upload_user_concurrency
                or len(active) >= cfg.upload_global_concurrency):
            raise HTTPException(429, detail={"code": "UPLOAD_BUSY", "message": "上传连接已满，请稍后重试", "retry_after_seconds": 2},
                                headers={"Retry-After": "2"})
        lease = Ingress(uid(), upload_id, owner_id, expected_size, cfg)
        db.add(UploadIngressLease(id=lease.id, upload_id=upload_id, owner_id=owner_id,
                                 expires_at=at + timedelta(seconds=cfg.upload_ingress_lease_seconds)))
        db.commit()
        return lease


def renew_ingress(lease):
    with session_factory()() as db:
        at = now()
        changed = db.execute(update(UploadIngressLease).where(UploadIngressLease.id == lease.id,
            UploadIngressLease.expires_at > at).values(expires_at=at + timedelta(seconds=lease.limits.upload_ingress_lease_seconds)))
        db.commit()
        return changed.rowcount == 1


def release_ingress(lease):
    with session_factory()() as db:
        # Token, not upload ID: an old handler cannot release a replacement.
        db.execute(delete(UploadIngressLease).where(UploadIngressLease.id == lease.id))
        db.commit()


def current_receipt(db, lease):
    lock_scheduler(db)
    current = db.scalar(select(UploadIngressLease).where(UploadIngressLease.id == lease.id,
        UploadIngressLease.upload_id == lease.upload_id, UploadIngressLease.owner_id == lease.owner_id,
        UploadIngressLease.expires_at > now()).with_for_update())
    if current is None:
        problem("UPLOAD_LEASE_EXPIRED", "上传连接已失效，请重试", 409)
    return _lock_current(db, owned_upload(db, lease.upload_id, lease.owner_id))


def record_body_failure(lease, error):
    # A slow/disconnected client may retry this same reservation. Malformed
    # complete bodies retain the existing durable failure/settlement behavior.
    detail = error.detail if isinstance(error.detail, dict) else {}
    if error.status_code in {408, 429, 503} or detail.get("code") == "UPLOAD_LEASE_EXPIRED":
        return
    with session_factory()() as db:
        try:
            receipt = current_receipt(db, lease)
        except HTTPException as expired:
            if expired.status_code == 409:
                return
            raise
        fail_upload(db, receipt, detail.get("code", "INVALID_UPLOAD"),
                    detail.get("message", "上传不完整"), awaiting_only=True)
        db.commit()


def persist_received_upload(lease, data):
    with session_factory()() as db:
        receipt = current_receipt(db, lease)
        active = _active_locked(db, receipt)
        if not active or receipt.status != "awaiting_upload":
            db.commit()
            return response_for(receipt)
        expected_hash = receipt.expected_sha256
        backend, mime = receipt.storage_backend, receipt.mime
        db.commit()
    if len(data) != lease.expected_size or hashlib.sha256(data).hexdigest() != expected_hash:
        error = HTTPException(422, detail={"code": "UPLOAD_HASH_MISMATCH", "message": "实际图片摘要与提交清单不一致"})
        record_body_failure(lease, error)
        raise error
    try:
        info = inspect_image(data)
        if mime not in {'application/octet-stream', info['mime']}:
            problem('UPLOAD_MIME_MISMATCH', '实际图片格式与提交清单不一致', 422)
    except HTTPException as error:
        record_body_failure(lease, error)
        raise
    with session_factory()() as db:
        receipt = current_receipt(db, lease)
        if not _active_locked(db, receipt) or receipt.status != 'awaiting_upload':
            db.commit()
            return response_for(receipt)
        receipt.verified_info = info
        db.commit()  # Recover an uncertain PUT using this validated immutable identity.
    # Only immutable scalar metadata survives into network I/O. No pooled
    # connection remains checked out while Boto3 uploads the received bytes.
    get_store(backend).put(content_storage_key(info['sha256']), data, info['mime'], kind="original")
    with session_factory()() as db:
        receipt = current_receipt(db, lease)
        if receipt.status == 'awaiting_upload':
            accept_verified_upload(db, receipt, data, info)
        from .plan_api import bind_file_page
        from .models import Job
        if receipt.asset_id:
            bind_file_page(db, db.get(Job, receipt.job_id))
        db.commit()
        return response_for(receipt)


async def finish_thread(function, *args):
    """Wait for a started storage/cleanup thread even if its HTTP task is cancelled."""
    task = asyncio.create_task(run_in_threadpool(function, *args))
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    if cancelled:
        # Retrieve errors too, so a disconnected request cannot leave an
        # unobserved background exception or release its slot before PUT ends.
        try:
            task.result()
        finally:
            raise asyncio.CancelledError()
    return task.result()


async def begin_ingress(upload_id, owner_id):
    task = asyncio.create_task(run_in_threadpool(acquire_ingress, upload_id, owner_id))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # A cancellation may arrive after the admission COMMIT but before the
        # handler receives its token. Finish that short transaction and release.
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                pass
            except Exception:
                break
        try:
            admitted = task.result()
        except Exception:
            raise asyncio.CancelledError() from None
        if isinstance(admitted, Ingress):
            await finish_thread(release_ingress, admitted)
        raise


async def read_ingress_body(request, lease, lost):
    body = asyncio.create_task(read_upload_stream(request, lease.expected_size, limits=lease.limits))
    lost_wait = asyncio.create_task(lost.wait())
    try:
        await asyncio.wait((body, lost_wait), return_when=asyncio.FIRST_COMPLETED)
        if lost.is_set():
            problem("UPLOAD_LEASE_EXPIRED", "上传连接已失效，请重试", 409)
        return await body
    finally:
        body.cancel()
        lost_wait.cancel()
        await asyncio.gather(body, lost_wait, return_exceptions=True)


async def keep_ingress_alive(lease, stopped, lost):
    interval = lease.limits.upload_ingress_lease_seconds / 3
    while True:
        try:
            await asyncio.wait_for(stopped.wait(), timeout=interval)
            return
        except TimeoutError:
            pass
        try:
            if not await run_in_threadpool(renew_ingress, lease):
                lost.set()
                return
        except Exception:
            lost.set()
            return
