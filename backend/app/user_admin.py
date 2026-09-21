"""Paginated user entitlement history; no account mutation or object access."""
from typing import Literal
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from .auth import admin
from .db import get_db
from .entitlement_models import MembershipOperation, QuotaPeriod
from .entitlements import iso, period_json
from .errors import problem
from .models import Job, Ledger, User, now

router = APIRouter(prefix="/v1/admin/users", dependencies=[Depends(admin)])


def require_user(db, user_id):
    if db.get(User, user_id) is None:
        problem("NOT_FOUND", "用户不存在", 404)


def page(db, query, offset, limit, serialize):
    total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery()))
    rows = db.execute(query.offset(offset).limit(limit))
    return {"items": [serialize(row) for row in rows], "total": total,
            "next_offset": offset + limit if offset + limit < total else None}


@router.get("/{user_id}/quota-periods")
def quota_history(user_id: str, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
                  mode: Literal["classic", "redraw"] | None = None,
                  source: Literal["daily", "membership", "grant", "subscription"] | None = None,
                  db: Session = Depends(get_db)):
    require_user(db, user_id)
    query = select(QuotaPeriod).where(QuotaPeriod.owner_id == user_id)
    if mode:
        query = query.where(QuotaPeriod.mode == mode)
    if source:
        query = query.where(QuotaPeriod.source == source)
    at = now()
    return page(db, query.order_by(QuotaPeriod.starts_at.desc(), QuotaPeriod.id.desc()), offset, limit,
                lambda row: {**period_json(row[0]), "billing_term_id": row[0].billing_term_id,
                             "expired": row[0].ends_at <= at})


@router.get("/{user_id}/usage-ledger")
def usage_history(user_id: str, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
                  period_id: str | None = Query(None, max_length=64), job_id: str | None = Query(None, max_length=36),
                  kind: Literal["reserve", "settle", "release", "grant", "compensation"] | None = None,
                  db: Session = Depends(get_db)):
    require_user(db, user_id)
    query = select(Ledger).where(Ledger.owner_id == user_id)
    for column, value in ((Ledger.period_id, period_id), (Ledger.job_id, job_id), (Ledger.kind, kind)):
        if value:
            query = query.where(column == value)
    return page(db, query.order_by(Ledger.created_at.desc(), Ledger.id.desc()), offset, limit,
                lambda row: {**{key: getattr(row[0], key) for key in
                    ("id", "job_id", "period_id", "quota_kind", "kind", "amount", "note")},
                    "created_at": iso(row[0].created_at)})


@router.get("/{user_id}/membership-operations")
def membership_history(user_id: str, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
                       db: Session = Depends(get_db)):
    require_user(db, user_id)
    query = select(MembershipOperation, User.name).join(User, User.id == MembershipOperation.operator_id).where(
        MembershipOperation.owner_id == user_id).order_by(MembershipOperation.created_at.desc(), MembershipOperation.id.desc())
    def serialize(row):
        operation, name = row
        # Only operator-supplied business fields, never request fingerprints or bearer credentials.
        details = {key: value for key, value in operation.details.items() if key in
                   {"action", "months", "days", "monthly_pages", "kind", "pages", "note", "mode", "starts_at", "expires_at", "period_id"}}
        return {"id": operation.id, "operator_id": operation.operator_id, "operator_name": name,
                "kind": operation.transaction_key.split(":", 1)[0], "details": details,
                "created_at": iso(operation.created_at)}
    return page(db, query, offset, limit, serialize)


@router.get("/{user_id}/reserved-jobs")
def reserved_jobs(user_id: str, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
                  period_id: str | None = Query(None, max_length=64), db: Session = Depends(get_db)):
    require_user(db, user_id)
    query = select(Job.id, Job.mode, Job.status, Job.quota_pages, Job.quota_period_id, Job.created_at).where(
        Job.owner_id == user_id, Job.settlement == "reserved")
    if period_id:
        query = query.where(Job.quota_period_id == period_id)
    return page(db, query.order_by(Job.created_at.desc(), Job.id.desc()), offset, limit,
                lambda row: {**row._asdict(), "created_at": iso(row.created_at)})
