"""Reader-facing history, accounting summaries and private result feedback."""
from datetime import datetime, time, timedelta, timezone
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import CheckConstraint, ForeignKey, Index, JSON, String, UniqueConstraint, and_, exists, func, literal, or_, select, union_all
from sqlalchemy.orm import Mapped, Session, aliased, mapped_column

from .auth import admin, identity
from .db import Base, get_db
from .request_models import RequestBody
from .errors import problem
from .jobs import idem_key, job_json, owned_job
from .entitlements import entitlements_json
from .schemas import EntitlementsResponse
from .models import Asset, Job, Ledger, User, now, uid
from .results import ReaderEntry
from .system_settings import get_request_limits
from .schemas import JobResponse
from .providers import digest
from .feedback_limits import lock_feedback_admission, reserve_feedback_receipt

router = APIRouter(tags=["Reader"])


class LatestResult(BaseModel):
    latest: JobResponse | None
    result: JobResponse | None


@router.get("/v1/jobs/{job_id}/latest-result", response_model=LatestResult)
def latest_result(job_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    reference = owned_job(db, job_id, user.id)
    Job = ReaderEntry
    query = select(Job).where(
        Job.owner_id == user.id, Job.source_sha256 == reference.source_sha256,
        Job.mode == reference.mode, Job.target_language == reference.target_language
    ).order_by(Job.created_at.desc(), Job.version.desc(), Job.id.desc())
    latest = db.scalar(query.limit(1))
    delivered = db.scalar(query.where(Job.status == "succeeded").limit(1))
    return {"latest": job_json(db, latest) if latest else None, "result": job_json(db, delivered) if delivered else None}


class Feedback(Base):
    __tablename__ = "translation_feedback"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id"))
    access_id: Mapped[str | None] = mapped_column(ForeignKey("result_accesses.id"))
    output_asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"))
    issues: Mapped[list] = mapped_column(JSON)
    comment: Mapped[str] = mapped_column(String(500), default="")
    status: Mapped[str] = mapped_column(String(20), default="received")
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(default=now)
    updated_at: Mapped[datetime] = mapped_column(default=now)
    __table_args__ = (UniqueConstraint("owner_id", "idempotency_key"),
                     CheckConstraint('(job_id IS NOT NULL AND access_id IS NULL) OR (job_id IS NULL AND access_id IS NOT NULL)'),
                     Index("ix_feedback_owner_created", "owner_id", "created_at"),
                     Index("ix_feedback_job", "job_id"))


class FeedbackRequest(RequestBody):
    issues: list[Literal["missing_text", "meaning", "typesetting", "art_changed", "other"]] = Field(default_factory=list, max_length=5)
    comment: str = Field(default="", max_length=500)
    output_asset_id: str | None = Field(default=None, max_length=36)

    @field_validator("comment")
    @classmethod
    def clean_comment(cls, value):
        return value.strip()

    @field_validator("issues")
    @classmethod
    def unique_issues(cls, value):
        return sorted(set(value))

    @model_validator(mode="after")
    def meaningful(self):
        if not self.issues and not self.comment:
            raise ValueError("请选择问题类型或填写补充说明")
        return self


class FeedbackResponse(BaseModel):
    id: str
    job_id: str
    output_asset_id: str
    issues: list[str]
    comment: str
    status: str
    created_at: str
    updated_at: str


class FeedbackPage(BaseModel):
    items: list[FeedbackResponse]
    total: int
    next_offset: int | None


class FeedbackUpdate(RequestBody):
    status: Literal["received", "reviewing", "resolved"]


def feedback_json(row):
    return {name: getattr(row, name) for name in ("id", "output_asset_id", "issues", "comment", "status")} | {
        "job_id": row.job_id or row.access_id,
        "created_at": row.created_at.isoformat() + "Z", "updated_at": row.updated_at.isoformat() + "Z"}


@router.post("/v1/jobs/{job_id}/feedback", response_model=FeedbackResponse, status_code=201)
def submit_feedback(job_id: str, body: FeedbackRequest,
                    idempotency_key: Annotated[str | None, Header()] = None,
                    user: User = Depends(identity), db: Session = Depends(get_db)):
    key = idem_key(idempotency_key)
    owner_id = user.id
    # End the identity read transaction before taking the account admission lock.
    # One connection then covers the receipt check, budget and feedback insert.
    db.rollback()
    limits = get_request_limits(db)
    admission = lock_feedback_admission(db, owner_id, limits=limits)
    job = owned_job(db, job_id, owner_id)
    # Local copies can outlive access grants. Feedback still targets that exact,
    # immutable job output; it does not restore image access or attach new bytes.
    if job.status != "succeeded" or not job.output_asset_id:
        problem("NO_TRANSLATION_RESULT", "此任务没有可反馈的译图", 409)
    if body.output_asset_id and body.output_asset_id != job.output_asset_id:
        problem("RESULT_MISMATCH", "反馈与正在查看的译图不一致", 409)
    request_hash = digest({"job_id": job_id, "output_asset_id": job.output_asset_id,
                           "issues": body.issues, "comment": body.comment})
    previous = db.scalar(select(Feedback).where(Feedback.owner_id == owner_id, Feedback.idempotency_key == key))
    if previous:
        if previous.request_hash != request_hash:
            problem("IDEMPOTENCY_CONFLICT", "此反馈编号已用于其他内容", 409)
        result = feedback_json(previous)
        db.commit()
        return result
    reserve_feedback_receipt(db, admission, limits=limits)
    row = Feedback(owner_id=owner_id, job_id=job_id if isinstance(job, Job) else None,
                   access_id=None if isinstance(job, Job) else job_id, output_asset_id=job.output_asset_id,
                   issues=body.issues, comment=body.comment, idempotency_key=key, request_hash=request_hash)
    db.add(row)
    db.commit()
    return feedback_json(row)


def feedback_page(db, offset, limit, owner_id=None):
    query = select(Feedback)
    if owner_id is not None:
        query = query.where(Feedback.owner_id == owner_id)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.scalars(query.order_by(Feedback.created_at.desc(), Feedback.id.desc()).offset(offset).limit(limit))
    return {"items": [feedback_json(row) for row in rows], "total": total,
            "next_offset": offset + limit if offset + limit < total else None}


@router.get("/v1/me/feedback", response_model=FeedbackPage)
def my_feedback(offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100),
                user: User = Depends(identity), db: Session = Depends(get_db)):
    return feedback_page(db, offset, limit, user.id)


@router.get("/v1/admin/feedback", response_model=FeedbackPage)
def admin_feedback(offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100),
                   user: User = Depends(admin), db: Session = Depends(get_db)):
    return feedback_page(db, offset, limit)


@router.patch("/v1/admin/feedback/{feedback_id}", response_model=FeedbackResponse)
def review_feedback(feedback_id: str, body: FeedbackUpdate, user: User = Depends(admin), db: Session = Depends(get_db)):
    row = db.get(Feedback, feedback_id)
    if not row:
        problem("NOT_FOUND", "找不到此反馈", 404)
    row.status, row.updated_at = body.status, now()
    db.commit()
    return feedback_json(row)


class UsageDay(BaseModel):
    date: str
    delivered: int
    classic: int
    redraw: int


class UsageSummary(BaseModel):
    entitlements: EntitlementsResponse
    timezone: str
    start_date: str
    end_date: str
    generated_at: str
    delivered: int
    free_delivered: int
    included_delivered: int
    by_mode: dict[str, int]
    quota_used: dict[str, int]
    days: list[UsageDay]


@router.get("/v1/me/usage/summary", response_model=UsageSummary)
def usage_summary(days: int = Query(7, ge=1, le=90), timezone_name: str = Query("UTC", alias="timezone", max_length=80),
                  user: User = Depends(identity), db: Session = Depends(get_db)):
    try:
        zone = ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError):
        problem("INVALID_TIMEZONE", "统计时区无效", 422)
    end_day = datetime.now(timezone.utc).astimezone(zone).date()
    start_day = end_day - timedelta(days=days - 1)
    start = datetime.combine(start_day, time.min, zone).astimezone(timezone.utc).replace(tzinfo=None)
    end = datetime.combine(end_day + timedelta(days=1), time.min, zone).astimezone(timezone.utc).replace(tzinfo=None)
    daily = {(start_day + timedelta(days=i)).isoformat(): {"delivered": 0, "classic": 0, "redraw": 0} for i in range(days)}
    totals = {"classic": 0, "redraw": 0}
    consumed = {"classic": 0, "redraw": 0}
    # Stream the whole interval, never just the account ledger's first page.
    # Local dates are derived via IANA timezone rules, including DST transitions.
    entries = select(Ledger.created_at, Ledger.amount, Job.mode).outerjoin(Job, Job.id == Ledger.job_id).where(
        Ledger.owner_id == user.id, Ledger.kind == "settle", Ledger.created_at >= start, Ledger.created_at < end)
    for created_at, amount, mode in db.execute(entries).yield_per(1000):
        if mode in consumed:
            consumed[mode] += amount
    delivered = select(Job.completed_at, Job.mode, Job.settlement).where(Job.owner_id == user.id, Job.status == "succeeded",
                                 Job.output_asset_id.is_not(None), Job.completed_at >= start, Job.completed_at < end)
    count = free = included = 0
    for completed_at, mode, settlement in db.execute(delivered).yield_per(1000):
        day = completed_at.replace(tzinfo=timezone.utc).astimezone(zone).date().isoformat()
        count += 1
        included += settlement == "included"
        free += settlement in ("free", "released")
        daily[day]["delivered"] += 1
        if mode in totals:
            totals[mode] += 1
            daily[day][mode] += 1
    return {"entitlements": entitlements_json(db, user), "timezone": timezone_name,
            "start_date": start_day.isoformat(), "end_date": end_day.isoformat(),
            "generated_at": now().isoformat() + "Z", "delivered": count, "included_delivered": included,
            "free_delivered": free, "by_mode": totals, "quota_used": consumed,
            "days": [{"date": day, **values} for day, values in daily.items()]}
