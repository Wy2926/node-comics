"""Account mode queues and bounded, versioned realtime reading intent."""
from datetime import timedelta
from typing import Literal
from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from .auth import admin, identity
from .config import settings
from .db import get_db
from .entitlements import locked_user
from .errors import problem
from .jobs import job_json
from .models import Job, User, now
from .providers import digest
from .request_models import RequestBody
from .scheduler import ACTIVE, active_count, limits_for, lock_scheduler, queue_for, touch_job

router = APIRouter(tags=["queues"])
Mode = Literal["classic", "redraw"]


def queue_json(db, user, mode):
    row = queue_for(db, user.id, mode)
    counts = dict(db.execute(select(Job.status, func.count()).where(Job.owner_id == user.id, Job.mode == mode).group_by(Job.status)).all())
    count = sum(counts.get(s, 0) for s in ACTIVE)
    limits = limits_for(user)
    reserved = bool(row.next_upload_session and row.next_upload_until and row.next_upload_until > now() and count < limits["capacity"])
    realtime = db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == user.id, Job.mode == mode, Job.status.in_(ACTIVE), Job.realtime_until > now()))
    return {"mode": mode, **limits, "in_flight": count + int(reserved), "upload_reserved": reserved,
        "upload_reservation_session_id": row.next_upload_session if reserved else None,
        "available_slots": max(0, limits["capacity"] - active_count(db, user.id) - int(reserved)), "realtime_count": realtime,
        "queued": counts.get("queued", 0), "running": counts.get("running", 0),
        "awaiting_upload": counts.get("awaiting_upload", 0) + counts.get("validating_upload", 0),
        "outcome_unknown": counts.get("outcome_unknown", 0), "paused": row.paused, "version": row.version,
        "session_id": row.session_id, "session_expires_at": row.session_expires_at.isoformat() + "Z" if row.session_expires_at else None}


@router.get("/v1/me/queues")
def queues(user: User = Depends(identity), db: Session = Depends(get_db)):
    lock_scheduler(db)
    result = {"items": [queue_json(db, user, mode) for mode in ("classic", "redraw")]}
    db.commit()
    return result


@router.get("/v1/admin/users/{user_id}/queues")
def user_queues(user_id: str, operator: User = Depends(admin), db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if not user:
        problem("NOT_FOUND", "找不到此用户", 404)
    lock_scheduler(db)
    result = {"items": [queue_json(db, user, mode) for mode in ("classic", "redraw")]}
    db.commit()
    return result


@router.get("/v1/me/queues/{mode}/items")
def queue_items(mode: Mode, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100),
                user: User = Depends(identity), db: Session = Depends(get_db)):
    query = select(Job).where(Job.owner_id == user.id, Job.mode == mode, Job.status.in_(ACTIVE))
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    jobs = db.scalars(query.order_by(Job.priority_rank, Job.created_at, Job.id).offset(offset).limit(limit))
    return {"items": [job_json(db, j) for j in jobs], "total": total, "next_offset": offset + limit if offset + limit < total else None}


class PriorityRequest(RequestBody):
    session_id: str = Field(min_length=1, max_length=80)
    sequence: int = Field(ge=0, le=2147483647)
    expected_version: int = Field(ge=0)
    realtime_job_ids: list[str] = Field(default_factory=list, max_length=100)
    ordered_job_ids: list[str] = Field(default_factory=list, max_length=500)
    ttl_seconds: int = Field(default=90, ge=1, le=300)
    takeover: bool = False
    reserve_next_upload: bool = False


def priority_result(db, row):
    return {"version": row.version, "session_id": row.session_id,
        "realtime_job_ids": list(db.scalars(select(Job.id).where(Job.owner_id == row.owner_id, Job.mode == row.mode,
            Job.status.in_(ACTIVE), Job.realtime_until > now()).order_by(Job.priority_rank))),
        "expires_at": row.session_expires_at.isoformat() + "Z" if row.session_expires_at else None}


@router.post("/v1/me/queues/{mode}/priority")
def priority(mode: Mode, body: PriorityRequest, user: User = Depends(identity), db: Session = Depends(get_db)):
    lock_scheduler(db)
    user = locked_user(db, user.id)
    row = queue_for(db, user.id, mode)
    request_hash = digest(body.model_dump(exclude={"expected_version"}))
    if row.session_id == body.session_id and body.sequence <= row.session_sequence:
        if body.sequence == row.session_sequence and row.priority_request_hash == request_hash:
            return priority_result(db, row)
        problem("STALE_PRIORITY", "较新的阅读位置已经生效，请刷新队列", 409)
    if row.version != body.expected_version:
        problem("QUEUE_VERSION_CONFLICT", "队列已更新，请合并最新阅读顺序", 409, version=row.version)
    if row.session_id and row.session_id != body.session_id and row.session_expires_at and row.session_expires_at > now() and not body.takeover:
        problem("READING_SESSION_ACTIVE", "另一设备正在控制阅读优先级", 409)
    realtime = list(dict.fromkeys(body.realtime_job_ids))
    ordered = list(dict.fromkeys(realtime + body.ordered_job_ids))
    if len(realtime) > limits_for(user)["realtime_limit"]:
        problem("REALTIME_LIMIT", "实时任务数量超过当前套餐名额", 422)
    jobs = db.scalars(select(Job).where(Job.id.in_(ordered), Job.owner_id == user.id, Job.mode == mode)).all() if ordered else []
    if len(jobs) != len(ordered):
        problem("NOT_FOUND", "排序中包含不属于本账户或模式的任务", 404)
    expires = now() + timedelta(seconds=min(body.ttl_seconds, settings().priority_ttl_seconds))
    ranks = {job_id: rank for rank, job_id in enumerate(ordered)}
    realtime_ids = set(realtime)
    for job in db.scalars(select(Job).where(Job.owner_id == user.id, Job.mode == mode, Job.status.in_(ACTIVE))):
        rank = ranks.get(job.id, 1000000)
        realtime_until = expires if job.id in realtime_ids and job.status != "outcome_unknown" else None
        # A reading heartbeat changes only its small realtime window. Unchanged
        # preload rows must not produce hundreds of DB writes and sync events.
        if job.priority_rank == rank and job.realtime_until == realtime_until:
            continue
        job.priority_rank, job.realtime_until = rank, realtime_until
        touch_job(db, job)
    row.session_id, row.session_sequence, row.session_expires_at = body.session_id, body.sequence, expires
    row.priority_request_hash, row.version = request_hash, row.version + 1
    if body.reserve_next_upload:
        row.next_upload_session, row.next_upload_until = body.session_id, expires
    elif row.next_upload_session == body.session_id:
        row.next_upload_session = row.next_upload_until = None
    db.flush()
    result = priority_result(db, row)
    db.commit()
    return result


class PauseRequest(RequestBody):
    paused: bool


@router.post("/v1/me/queues/{mode}/pause")
def pause(mode: Mode, body: PauseRequest, user: User = Depends(identity), db: Session = Depends(get_db)):
    lock_scheduler(db)
    row = queue_for(db, user.id, mode)
    if row.paused != body.paused:
        row.paused, row.version = body.paused, row.version + 1
    result = queue_json(db, user, mode)
    db.commit()
    return result


@router.get("/v1/me/translation-changes")
def changes(cursor: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=100),
            user: User = Depends(identity), db: Session = Depends(get_db)):
    # All job visibility revisions are assigned under the scheduler transaction lock;
    # a smaller uncommitted revision can never appear behind an acknowledged cursor.
    lock_scheduler(db)
    rows = list(db.scalars(select(Job).where(Job.owner_id == user.id, Job.change_sequence > cursor)
        .order_by(Job.change_sequence, Job.id).limit(limit + 1)))
    selected = rows[:limit]
    result = {"items": [job_json(db, j) for j in selected], "deleted_job_ids": [],
        "cursor": str(selected[-1].change_sequence if selected else cursor), "has_more": len(rows) > limit}
    db.commit()
    return result
