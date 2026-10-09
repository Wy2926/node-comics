"""Operator-only membership, quota and execution history routes."""
from typing import Annotated, Literal
from datetime import timedelta
from fastapi import APIRouter, BackgroundTasks, Depends, Header, Query
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .auth import admin, user_json
from .config import settings
from .db import get_db
from .errors import problem
from .jobs import idem_key, job_json
from .entitlements import change_membership, compensate, entitlements_json
from .models import Attempt, Job, TextCall, User, now
from .queue_models import ComputeNode, ExecutionLease
from .request_models import RequestBody

router = APIRouter()


class MembershipRequest(RequestBody):
    action: Literal["extend", "expire"] = "extend"
    months: int | None = Field(default=None, ge=1, le=120, strict=True)
    days: int | None = Field(default=None, ge=1, le=3660, strict=True)
    monthly_pages: int | None = Field(default=None, ge=0, le=1_000_000, strict=True)
    note: str = Field(min_length=1, max_length=200)


class CompensationRequest(RequestBody):
    kind: Literal["classic_daily", "classic_monthly"]
    pages: int = Field(ge=1, le=1_000_000, strict=True)
    note: str = Field(min_length=1, max_length=200)


@router.get("/v1/admin/jobs")
def admin_jobs(status: str | None = Query(None, max_length=24), offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), user: User = Depends(admin), db: Session = Depends(get_db)):
    query = select(Job)
    if status:
        query = query.where(Job.status == status)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    jobs = db.scalars(query.order_by(Job.created_at.desc()).offset(offset).limit(limit)).all()
    items = []
    for job in jobs:
        attempt = db.get(Attempt, job.attempt_id) if job.attempt_id else None
        calls = db.scalars(select(TextCall).where(TextCall.job_id == job.id).order_by(TextCall.started_at)).all()
        items.append({**job_json(db, job), "owner_id": job.owner_id, "provider_id": attempt.provider_id if attempt else None,
                      "provider_request_id": attempt.request_id if attempt else None, "provider_usage": attempt.usage if attempt else None, "provider_cost_state": attempt.cost_state if attempt else None,
                      'text_cost_micros': sum(call.accounted_micros for call in calls),
                      'text_calls': [{'id': call.id, 'group': call.group_index, 'sequence': call.sequence, 'model': call.model, 'provider_id': call.provider_id,
                                      'request_id': call.request_id, 'usage': call.usage, 'cost_state': call.cost_state,
                                      'accounted_micros': call.accounted_micros, 'error_code': call.error_code} for call in calls]})
    return {"items": items, "total": total, "next_offset": offset + limit if offset + limit < total else None}


@router.get("/v1/admin/jobs/{job_id}/attempts")
def admin_job_attempts(job_id: str, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
                       user: User = Depends(admin), db: Session = Depends(get_db)):
    if not db.get(Job, job_id):
        problem("NOT_FOUND", "任务不存在", 404)
    query = select(Attempt).where(Attempt.job_id == job_id)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.scalars(query.order_by(Attempt.started_at.desc(), Attempt.id).offset(offset).limit(limit))
    def stamp(value):
        return value.isoformat() + "Z" if value else None
    return {"items": [{"id": row.id, "provider_id": row.provider_id, "request_id": row.request_id,
        "started_at": stamp(row.started_at), "call_started_at": stamp(row.call_started_at),
        "completed_at": stamp(row.completed_at), "heartbeat_at": stamp(row.heartbeat_at),
        "lease_expires_at": stamp(row.lease_expires_at), "cost_state": row.cost_state,
        "usage": row.usage, "error_code": row.error_code, "recovered": row.recovered} for row in rows],
        "total": total, "next_offset": offset + limit if offset + limit < total else None}


@router.get("/v1/admin/users")
def admin_users(offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), user: User = Depends(admin), db: Session = Depends(get_db)):
    rows = db.scalars(select(User).where(User.kind == 'registered').order_by(User.created_at.desc()).offset(offset).limit(limit))
    return {"items": [{**user_json(row), "entitlements": entitlements_json(db, row)} for row in rows], "total": db.scalar(select(func.count()).select_from(User).where(User.kind == 'registered'))}


@router.post("/v1/admin/users/{user_id}/membership")
def admin_membership(user_id: str, body: MembershipRequest, tasks: BackgroundTasks, idempotency_key: Annotated[str | None, Header()] = None,
                     user: User = Depends(admin), db: Session = Depends(get_db)):
    result = change_membership(db, user_id, user.id, idem_key(idempotency_key), **body.model_dump())
    from .billing_renewal import process_owner
    tasks.add_task(process_owner, user_id)
    return result


@router.post("/v1/admin/users/{user_id}/quota-compensations")
def admin_compensation(user_id: str, body: CompensationRequest, idempotency_key: Annotated[str | None, Header()] = None,
                       user: User = Depends(admin), db: Session = Depends(get_db)):
    return compensate(db, user_id, user.id, idem_key(idempotency_key), **body.model_dump())


@router.get("/v1/admin/compute-nodes")
def compute_nodes(user: User = Depends(admin), db: Session = Depends(get_db)):
    busy = dict(db.execute(select(ExecutionLease.node_id, func.count()).where(ExecutionLease.completed_at.is_(None)).group_by(ExecutionLease.node_id)).all())
    at = now()
    return {"items": [{"id": n.id, "name": n.name, "resource_id": n.resource_id, "device": n.device,
        "capabilities": n.capabilities, "engine_version": n.engine_version, "capacity": n.capacity,
        "config_version": n.config_version, "applied_config_version": n.applied_config_version,
        "config_error": n.config_error, "supported_languages": n.supported_languages,
        "running": busy.get(n.id, 0), "enabled": n.enabled,
        "online": bool(n.heartbeat_at and n.heartbeat_at > at - timedelta(seconds=settings().cluster_node_timeout_seconds)),
        "heartbeat_at": n.heartbeat_at.isoformat() + "Z" if n.heartbeat_at else None} for n in db.scalars(select(ComputeNode).order_by(ComputeNode.id))]}
