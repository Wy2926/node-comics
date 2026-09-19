"""Authenticated original-image delivery for accepted operations."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from .auth import identity
from .db import get_db
from .errors import problem
from .jobs import job_json
from .models import Job, User, now
from .queue_models import JobStage
from .scheduler import lock_scheduler, touch_job
from .uploads import owned_upload, fail_upload
router = APIRouter(tags=['uploads'])


@router.put("/v1/uploads/{upload_id}/content")
async def upload_content(upload_id: str, request: Request, user: User = Depends(identity), db: Session = Depends(get_db)):
    from .upload_ingress import (Ingress, begin_ingress, finish_thread, keep_ingress_alive,
                                persist_received_upload, read_ingress_body, record_body_failure, release_ingress)
    owner_id = user.id
    # identity() has already queried using this dependency. Closing it returns
    # that connection before any client-controlled await or storage request.
    await run_in_threadpool(db.close)
    admission = await begin_ingress(upload_id, owner_id)
    if not isinstance(admission, Ingress):
        return admission
    stopped, lost = asyncio.Event(), asyncio.Event()
    heartbeat = asyncio.create_task(keep_ingress_alive(admission, stopped, lost))
    try:
        try:
            data = await read_ingress_body(request, admission, lost)
        except HTTPException as error:
            await finish_thread(record_body_failure, admission, error)
            raise
        if lost.is_set():
            problem("UPLOAD_LEASE_EXPIRED", "上传连接已失效，请重试", 409)
        return await finish_thread(persist_received_upload, admission, data)
    finally:
        stopped.set()
        try:
            await asyncio.shield(heartbeat)
        finally:
            await finish_thread(release_ingress, admission)


@router.post("/v1/uploads/{upload_id}/complete")
def upload_complete(upload_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    lock_scheduler(db)
    reservation = owned_upload(db, upload_id, user.id)
    job = db.get(Job, reservation.job_id)
    if reservation.status == 'verified':
        from .assets import owned_asset
        owned_asset(db, reservation.asset_id, user.id)
    if reservation.status == "awaiting_upload" and reservation.expires_at <= now() and job.status == "awaiting_upload":
        fail_upload(db, reservation, "UPLOAD_EXPIRED", "上传会话已过期，请重新提交", status="expired")
        db.commit()
        problem("UPLOAD_EXPIRED", "上传会话已过期，请重新提交", 410)
    if (reservation.status == 'awaiting_upload' and reservation.verified_info) and job.status == "awaiting_upload":
        reservation.status = "validating"
        job.status, job.phase = "validating_upload", "validating_upload"
        db.add(JobStage(job_id=job.id, name="validate_upload", status="ready"))
        touch_job(db, job)
    elif reservation.status == "awaiting_upload":
        problem("UPLOAD_INCOMPLETE", "原图尚未上传完成", 409)
    db.commit()
    return job_json(db, job)
