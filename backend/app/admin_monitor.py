"""Read-only operational views. Query metadata only; never read objects or OCR payloads."""
from collections import defaultdict
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, case, exists, extract, func, or_, select
from sqlalchemy.orm import Session, defer

from .auth import admin, user_json
from .config import settings
from .db import get_db
from .entitlements import entitlements_json, is_plus, is_operator_plus, iso, period_json, plus_dates
from .billing_access import access_exists
from .entitlement_models import QuotaPeriod
from .errors import problem
from .models import Attempt, ClassicState, Job, TextCall, User, now
from .queue_models import ComputeNode, ExecutionLease, JobStage, UserModeQueue
from .scheduler import ACTIVE, priority_of

router = APIRouter(prefix="/v1/admin/monitor", dependencies=[Depends(admin)])
Mode = Literal["classic", "redraw"]
Status = Literal["active", "attention", "awaiting_upload", "validating_upload", "queued", "running",
                 "outcome_unknown", "unknown_released", "succeeded", "no_text", "failed", "cancelled"]
STAGE_ORDER = {name: i for i, name in enumerate(["validate_upload", "page", "text", "redraw"])}


def seconds(start, end):
    return round(max(0, (end - start).total_seconds()), 3) if start and end else None


def duration_sql(db, start, end):
    if db.get_bind().dialect.name == "sqlite":
        return (func.julianday(end) - func.julianday(start)) * 86400
    return extract("epoch", end - start)


def lease_rows(db, job_ids):
    # Deliberately omit lease tokens, result payloads and provider credentials.
    query = select(ExecutionLease.id, ExecutionLease.job_id, ExecutionLease.stage_id,
        ExecutionLease.node_id, ExecutionLease.executor_id, ExecutionLease.generation,
        ExecutionLease.priority_class, ExecutionLease.started_at, ExecutionLease.expires_at,
        ExecutionLease.completed_at, ExecutionLease.outcome, JobStage.name.label("stage"),
        ComputeNode.name.label("node_name")).join(JobStage, JobStage.id == ExecutionLease.stage_id).join(
        ComputeNode, ComputeNode.id == ExecutionLease.node_id).where(ExecutionLease.job_id.in_(job_ids))
    grouped = defaultdict(list)
    for row in db.execute(query.order_by(ExecutionLease.started_at, ExecutionLease.id)):
        grouped[row.job_id].append(row)
    return grouped


def lease_end(row, at):
    # An expired, unreconciled lease is not an indefinitely running execution.
    return min(row.completed_at or at, row.expires_at)


def timing(job, leases, at):
    end = job.completed_at or at
    intervals = sorted((max(job.created_at, row.started_at), min(end, lease_end(row, at))) for row in leases)
    merged = []
    for start, stop in intervals:
        if stop <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(stop, merged[-1][1]))
        else:
            merged.append((start, stop))
    elapsed = seconds(job.created_at, end)
    occupied = round(sum((stop - start).total_seconds() for start, stop in merged), 3)
    return {"elapsed_seconds": elapsed, "execution_seconds": occupied,
            "non_execution_seconds": round(max(0, elapsed - occupied), 3),
            "initial_wait_seconds": seconds(job.created_at, min(end, leases[0].started_at) if leases else end),
            "worker_seconds": round(sum(seconds(start, stop) for start, stop in intervals), 3),
            "started_at": iso(leases[0].started_at) if leases else None}


def task_json(job, owner_name, leases, at):
    live = [r for r in leases if not r.completed_at and r.expires_at > at]
    final = [r for r in leases if r.outcome == "succeeded" and (
        r.stage in {"redraw", "page"} if job.status == "succeeded" else
        job.status == "no_text" and r.stage in {"page", "redraw"})]
    completed_by = final[-1] if final else None
    return {"id": job.id, "owner_id": job.owner_id, "owner_name": owner_name, "mode": job.mode,
            "target_language": job.target_language, "status": job.status, "phase": job.phase,
            "priority": priority_of(job, at) if job.status in ACTIVE else (leases[-1].priority_class if leases else None),
            "cache_hit": job.cache_hit,
            "created_at": iso(job.created_at), "completed_at": iso(job.completed_at),
            "settlement": job.settlement, "quota_pages": job.quota_pages, "error_code": job.error_code,
            "cancel_requested": job.cancel_requested, "discard_output": job.discard_output, **timing(job, leases, at),
            "nodes": list({r.node_id: {"id": r.node_id, "name": r.node_name} for r in leases}.values()),
            "running_nodes": list(dict.fromkeys(r.node_id for r in live)),
            "expired_leases": sum(not r.completed_at and r.expires_at <= at for r in leases),
            "completed_by": {"node_id": completed_by.node_id, "name": completed_by.node_name,
                             "executor_id": completed_by.executor_id} if completed_by else None}


def task_query():
    return select(Job, User.name).options(defer(Job.config)).join(User, User.id == Job.owner_id)


@router.get("/tasks")
def tasks(status: Status | None = None, mode: Mode | None = None,
          priority: Literal["realtime", "preload"] | None = None,
          owner_id: str | None = Query(None, max_length=36), node_id: str | None = Query(None, max_length=80),
          q: str = Query("", max_length=120), offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
          db: Session = Depends(get_db)):
    at, query = now(), task_query()
    if status:
        statuses = ACTIVE if status == "active" else {"outcome_unknown", "unknown_released", "failed"} if status == "attention" else {status}
        query = query.where(Job.status.in_(statuses))
    if mode:
        query = query.where(Job.mode == mode)
    if priority:
        real = and_(Job.realtime_until.is_not(None), Job.realtime_until > at)
        query = query.where(real if priority == "realtime" else or_(Job.realtime_until.is_(None), Job.realtime_until <= at))
    if owner_id:
        query = query.where(Job.owner_id == owner_id)
    if node_id:
        query = query.where(exists(select(ExecutionLease.id).where(ExecutionLease.job_id == Job.id, ExecutionLease.node_id == node_id)))
    if q.strip():
        value = q.strip()
        query = query.where(or_(Job.id.contains(value, autoescape=True), User.name.contains(value, autoescape=True)))
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.execute(query.order_by(Job.created_at.desc(), Job.id.desc()).offset(offset).limit(limit)).all()
    leases = lease_rows(db, [job.id for job, _ in rows]) if rows else {}
    return {"items": [task_json(job, name, leases.get(job.id, []), at) for job, name in rows],
            "total": total, "next_offset": offset + limit if offset + limit < total else None, "generated_at": iso(at)}


@router.get("/tasks/{job_id}")
def task_detail(job_id: str, db: Session = Depends(get_db)):
    row = db.execute(task_query().where(Job.id == job_id)).first()
    if not row:
        problem("NOT_FOUND", "任务不存在", 404)
    at = now()
    job, name = row
    leases = lease_rows(db, [job.id])[job.id]
    stages = db.execute(select(JobStage.id, JobStage.name, JobStage.status, JobStage.attempts,
        JobStage.available_at, JobStage.completed_at).where(JobStage.job_id == job.id)).all()
    executions = [{"id": r.id, "stage": r.stage, "generation": r.generation, "node_id": r.node_id,
        "node_name": r.node_name, "executor_id": r.executor_id, "priority": r.priority_class,
        "started_at": iso(r.started_at), "completed_at": iso(r.completed_at), "expires_at": iso(r.expires_at),
        "seconds": seconds(r.started_at, lease_end(r, at)),
        "outcome": r.outcome or ("expired" if r.expires_at <= at else "running")} for r in leases]
    calls = db.execute(select(TextCall.id, TextCall.model, TextCall.provider_id, TextCall.sequence,
        TextCall.group_index, TextCall.started_at, TextCall.completed_at, TextCall.cost_state,
        TextCall.accounted_micros, TextCall.error_code).where(TextCall.job_id == job.id).order_by(TextCall.started_at)).all()
    provider = db.execute(select(Attempt.provider_id, Attempt.cost_state).where(Attempt.id == job.attempt_id)).first() if job.attempt_id else None
    return {**task_json(job, name, leases, at), "generated_at": iso(at), "error_message": job.error_message,
        "timings": db.scalar(select(ClassicState.timings).where(ClassicState.job_id == job.id)) or {},
        "provider": {"id": provider.provider_id, "cost_state": provider.cost_state} if provider else None,
        "stages": [{"name": s.name, "status": s.status, "attempts": s.attempts,
                    "available_at": iso(s.available_at), "completed_at": iso(s.completed_at)}
                   for s in sorted(stages, key=lambda s: STAGE_ORDER.get(s.name, 99))],
        "executions": executions, "text_cost_micros": sum(c.accounted_micros for c in calls),
        "text_calls": [{"id": c.id, "model": c.model, "provider_id": c.provider_id, "sequence": c.sequence,
            "group": c.group_index, "started_at": iso(c.started_at), "completed_at": iso(c.completed_at),
            "seconds": seconds(c.started_at, c.completed_at), "cost_state": c.cost_state,
            "accounted_micros": c.accounted_micros, "error_code": c.error_code} for c in calls]}


@router.get("/overview")
def overview(db: Session = Depends(get_db)):
    at = now()
    since = at - timedelta(hours=24)
    priority = case((Job.realtime_until > at, "realtime"), else_="preload")
    groups = db.execute(select(Job.mode, Job.status, priority, func.count(), func.min(Job.created_at))
        .where(Job.status.in_(ACTIVE)).group_by(Job.mode, Job.status, priority)).all()
    queues = [{"mode": mode, "status": status, "priority": p, "count": count,
               "oldest_seconds": seconds(oldest, at)} for mode, status, p, count, oldest in groups]
    recent = db.execute(select(Job.mode, Job.status, func.count(),
        func.avg(duration_sql(db, Job.created_at, Job.completed_at))).where(Job.completed_at >= since).group_by(Job.mode, Job.status)).all()
    stages = db.execute(select(JobStage.name, JobStage.status, func.count()).join(Job, Job.id == JobStage.job_id).where(
        Job.status.in_(ACTIVE)).group_by(JobStage.name, JobStage.status)).all()
    nodes = db.execute(select(ComputeNode.enabled, ComputeNode.heartbeat_at)).all()
    online = sum(bool(enabled and heartbeat and heartbeat > at - timedelta(seconds=settings().cluster_node_timeout_seconds)) for enabled, heartbeat in nodes)
    lease_status = case((ExecutionLease.expires_at > at, "running"), else_="expired")
    lease_counts = db.execute(select(lease_status, func.count()).where(
        ExecutionLease.completed_at.is_(None)).group_by(lease_status)).all()
    user_count = db.scalar(select(func.count()).select_from(User))
    plus_count = db.scalar(select(func.count()).select_from(User).where(or_(
        and_(User.plus_started_at <= at, User.plus_expires_at > at),
        access_exists(at))))
    return {"generated_at": iso(at), "window_hours": 24, "users": {"total": user_count, "plus": plus_count,
        "submitted_24h": db.scalar(select(func.count(func.distinct(Job.owner_id))).where(Job.created_at >= since))},
        "nodes": {"total": len(nodes), "online_enabled": online}, "leases": dict(lease_counts),
        "queues": queues, "stages": [{"name": name, "status": status, "count": count} for name, status, count in stages],
        "completed_24h": [{"mode": mode, "status": status, "count": count, "avg_elapsed_seconds": round(max(0, avg), 3)}
                          for mode, status, count, avg in recent],
        "submitted_24h": db.scalar(select(func.count()).select_from(Job).where(Job.created_at >= since))}


@router.get("/nodes")
def nodes(db: Session = Depends(get_db)):
    at, since = now(), now() - timedelta(hours=24)
    active = defaultdict(lambda: {"running": 0, "expired": 0, "oldest_started_at": None})
    for node, expiry, started in db.execute(select(ExecutionLease.node_id, ExecutionLease.expires_at,
            ExecutionLease.started_at).where(ExecutionLease.completed_at.is_(None))):
        entry = active[node]
        entry["running" if expiry > at else "expired"] += 1
        entry["oldest_started_at"] = min(entry["oldest_started_at"] or started, started)
    recent = defaultdict(list)
    execution_end = case((ExecutionLease.completed_at > ExecutionLease.expires_at, ExecutionLease.expires_at), else_=ExecutionLease.completed_at)
    for node, outcome, count, avg in db.execute(select(ExecutionLease.node_id, ExecutionLease.outcome, func.count(),
            func.avg(duration_sql(db, ExecutionLease.started_at, execution_end))).where(
            ExecutionLease.completed_at >= since).group_by(ExecutionLease.node_id, ExecutionLease.outcome)):
        recent[node].append({"outcome": outcome, "count": count, "avg_seconds": round(max(0, avg), 3)})
    items = []
    for node in db.scalars(select(ComputeNode).order_by(ComputeNode.id)):
        usage = active[node.id]
        items.append({"id": node.id, "name": node.name, "resource_id": node.resource_id, "device": node.device,
            "kind": "control_pool" if node.engine_version == "control" else "compute_node", "capacity": node.capacity,
            "capabilities": node.capabilities, "engine_version": node.engine_version, "enabled": node.enabled,
            "config_version": node.config_version, "applied_config_version": node.applied_config_version,
            "config_error": node.config_error, "supported_languages": node.supported_languages,
            "online": bool(node.heartbeat_at and node.heartbeat_at > at - timedelta(seconds=settings().cluster_node_timeout_seconds)),
            "heartbeat_at": iso(node.heartbeat_at), "heartbeat_age_seconds": seconds(node.heartbeat_at, at),
            "running": usage["running"], "expired_leases": usage["expired"],
            "occupied": usage["running"] + usage["expired"], "oldest_execution_seconds": seconds(usage["oldest_started_at"], at),
            "completed_24h": recent[node.id]})
    return {"items": items, "generated_at": iso(at), "timeout_seconds": settings().cluster_node_timeout_seconds}


@router.get("/users")
def users(q: str = Query("", max_length=120), plan: Literal["free", "plus"] | None = None,
          offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100), db: Session = Depends(get_db)):
    at, query = now(), select(User)
    if q.strip():
        query = query.where(or_(User.name.contains(q.strip(), autoescape=True), User.id.contains(q.strip(), autoescape=True)))
    if plan:
        plus = or_(and_(User.plus_started_at.is_not(None), User.plus_expires_at.is_not(None), User.plus_started_at <= at, User.plus_expires_at > at),
                   access_exists(at))
        query = query.where(plus if plan == "plus" else ~plus)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = list(db.scalars(query.order_by(User.created_at.desc(), User.id).offset(offset).limit(limit)))
    stats = defaultdict(dict)
    latest = {}
    if rows:
        ids = [u.id for u in rows]
        for owner, status, count in db.execute(select(Job.owner_id, Job.status, func.count()).where(Job.owner_id.in_(ids)).group_by(Job.owner_id, Job.status)):
            stats[owner][status] = count
        latest = dict(db.execute(select(Job.owner_id, func.max(Job.created_at)).where(Job.owner_id.in_(ids)).group_by(Job.owner_id)).all())
    return {"items": [{**user_json(u), "created_at": iso(u.created_at), "plan": "plus" if is_plus(db, u, at) else "free",
        "plus_expires_at": iso(plus_dates(db, u, at)[1]), "last_submitted_at": iso(latest.get(u.id)),
        "jobs": stats[u.id], "active_jobs": sum(stats[u.id].get(s, 0) for s in ACTIVE)} for u in rows],
        "total": total, "next_offset": offset + limit if offset + limit < total else None, "generated_at": iso(at)}


@router.get("/users/{user_id}")
def user_detail(user_id: str, db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if not user:
        problem("NOT_FOUND", "用户不存在", 404)
    return {**user_json(user), "created_at": iso(user.created_at), "entitlements": entitlements_json(db, user),
            "operator_membership": {"active": is_operator_plus(user), "expires_at": iso(user.plus_expires_at)},
            "grants": [period_json(row) for row in db.scalars(select(QuotaPeriod).where(
                QuotaPeriod.owner_id == user.id, QuotaPeriod.source == "grant")
                .order_by(QuotaPeriod.starts_at.desc(), QuotaPeriod.id).limit(50))]}
