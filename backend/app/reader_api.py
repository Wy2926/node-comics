"""Reader-facing history, accounting summaries and private result feedback."""
from collections import Counter, defaultdict
from datetime import datetime, time, timedelta, timezone
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import ForeignKey, Index, JSON, String, UniqueConstraint, and_, exists, func, literal, or_, select, union_all
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, aliased, mapped_column

from .auth import admin, identity
from .batch_items import BatchItem
from .db import Base, get_db
from .request_models import RequestBody
from .errors import problem
from .jobs import idem_key, job_json, locked_user, owned_job
from .entitlements import entitlements_json
from .schemas import EntitlementsResponse
from .models import Asset, Job, Batch, Ledger, User, now, uid
from .schemas import JobResponse
from .providers import digest

router = APIRouter(tags=["Reader"])


class LatestResult(BaseModel):
    latest: JobResponse | None
    result: JobResponse | None


@router.get("/v1/jobs/{job_id}/latest-result", response_model=LatestResult)
def latest_result(job_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    reference = owned_job(db, job_id, user.id)
    source = db.get(Asset, reference.input_asset_id)
    query = select(Job).join(Asset, Asset.id == Job.input_asset_id).where(
        Job.owner_id == user.id, Asset.owner_id == user.id, Asset.sha256 == source.sha256,
        Job.mode == reference.mode, Job.target_language == reference.target_language
    ).order_by(Job.created_at.desc(), Job.version.desc(), Job.id.desc())
    latest = db.scalar(query.limit(1))
    delivered = db.scalar(query.where(Job.status == "succeeded").limit(1))
    return {"latest": job_json(db, latest) if latest else None, "result": job_json(db, delivered) if delivered else None}


class Feedback(Base):
    __tablename__ = "translation_feedback"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"))
    output_asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"))
    issues: Mapped[list] = mapped_column(JSON)
    comment: Mapped[str] = mapped_column(String(500), default="")
    status: Mapped[str] = mapped_column(String(20), default="received")
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(default=now)
    updated_at: Mapped[datetime] = mapped_column(default=now)
    __table_args__ = (UniqueConstraint("owner_id", "idempotency_key"),
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
    return {name: getattr(row, name) for name in ("id", "job_id", "output_asset_id", "issues", "comment", "status")} | {
        "created_at": row.created_at.isoformat() + "Z", "updated_at": row.updated_at.isoformat() + "Z"}


@router.post("/v1/jobs/{job_id}/feedback", response_model=FeedbackResponse, status_code=201)
def submit_feedback(job_id: str, body: FeedbackRequest,
                    idempotency_key: Annotated[str | None, Header()] = None,
                    user: User = Depends(identity), db: Session = Depends(get_db)):
    key = idem_key(idempotency_key)
    job = owned_job(db, job_id, user.id)
    # Local copies can outlive access grants. Feedback still targets that exact,
    # immutable job output; it does not restore image access or attach new bytes.
    if job.status != "succeeded" or not job.output_asset_id:
        problem("NO_TRANSLATION_RESULT", "此任务没有可反馈的译图", 409)
    if body.output_asset_id and body.output_asset_id != job.output_asset_id:
        problem("RESULT_MISMATCH", "反馈与正在查看的译图不一致", 409)
    request_hash = digest({"job_id": job_id, "output_asset_id": job.output_asset_id,
                           "issues": body.issues, "comment": body.comment})
    locked_user(db, user.id)
    previous = db.scalar(select(Feedback).where(Feedback.owner_id == user.id, Feedback.idempotency_key == key))
    if previous:
        if previous.request_hash != request_hash:
            problem("IDEMPOTENCY_CONFLICT", "此反馈编号已用于其他内容", 409)
        return feedback_json(previous)
    row = Feedback(owner_id=user.id, job_id=job_id, output_asset_id=job.output_asset_id,
                   issues=body.issues, comment=body.comment, idempotency_key=key, request_hash=request_hash)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        previous = db.scalar(select(Feedback).where(Feedback.owner_id == user.id, Feedback.idempotency_key == key))
        if not previous or previous.request_hash != request_hash:
            problem("IDEMPOTENCY_CONFLICT", "反馈提交发生冲突，请核对已提交内容", 409)
        return feedback_json(previous)
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
    delivered = select(Job.completed_at, Job.mode, Job.settlement).where(Job.owner_id == user.id, Job.status == "succeeded", Job.cache_hit.is_(False),
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


class HistoryGroup(BaseModel):
    id: str
    kind: Literal["batch", "job"]
    created_at: str
    mode: str
    target_language: str
    page_count: int
    counts: dict[str, int]
    settled: int
    reserved: int
    reused: int
    job_ids: list[str]
    asset_ids: list[str]


class HistoryPage(BaseModel):
    items: list[HistoryGroup]
    total: int
    next_offset: int | None


@router.get("/v1/translation-history", response_model=HistoryPage)
def translation_history(offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=50),
                        user: User = Depends(identity), db: Session = Depends(get_db)):
    batches = select(Batch.id.label("id"), Batch.created_at.label("created_at"), literal("batch").label("kind")).where(Batch.owner_id == user.id)
    singles = select(Job.id.label("id"), Job.created_at.label("created_at"), literal("job").label("kind")).where(
        Job.owner_id == user.id, Job.batch_id.is_(None), ~exists(select(BatchItem.job_id).where(BatchItem.job_id == Job.id)))
    groups = union_all(batches, singles).subquery()
    total = db.scalar(select(func.count()).select_from(groups))
    selected = db.execute(select(groups).order_by(groups.c.created_at.desc(), groups.c.id.desc()).offset(offset).limit(limit)).all()
    batch_ids = [row.id for row in selected if row.kind == "batch"]
    single_ids = [row.id for row in selected if row.kind == "job"]
    entries_by_group = defaultdict(list)
    if selected:
        references = union_all(
            select(BatchItem.batch_id.label("group_id"), BatchItem.ordinal,
                   BatchItem.job_id, BatchItem.input_asset_id.label("requested_asset_id"))
            .where(BatchItem.batch_id.in_(batch_ids)),
            select(Job.id, Job.ordinal, Job.id, Job.input_asset_id).where(
                Job.owner_id == user.id, Job.id.in_(single_ids)),
        ).subquery()
        source, output, parent = aliased(Asset), aliased(Asset), aliased(Asset)
        timestamp = now()

        def retained(asset):
            return and_(asset.id.is_not(None), asset.owner_id == user.id,
                        asset.deleted_at.is_(None), asset.purged_at.is_(None), asset.expires_at > timestamp)

        # A history summary is a database snapshot, not an object-store health
        # check. Image access/download still verifies actual bytes and ownership.
        expired = and_(Job.output_asset_id.is_not(None), ~and_(
            retained(source), retained(output), or_(output.parent_id.is_(None), retained(parent))))
        rows = db.execute(select(
            references.c.group_id, references.c.requested_asset_id, Job.id, Job.batch_id,
            Job.mode, Job.target_language, Job.status, Job.quality_flags, Job.quota_pages,
            Job.settlement, Job.cache_hit, expired.label("result_expired"),
        ).join(Job, Job.id == references.c.job_id)
            .outerjoin(source, source.id == Job.input_asset_id)
            .outerjoin(output, output.id == Job.output_asset_id)
            .outerjoin(parent, parent.id == output.parent_id)
            .where(Job.owner_id == user.id)
            .order_by(references.c.group_id, references.c.ordinal, Job.id))
        for row in rows:
            entries_by_group[row.group_id].append(row)
    items = []
    for group_id, created_at, kind in selected:
        entries = entries_by_group[group_id]
        jobs = list({job.id: job for job in entries}.values())
        states = Counter()
        for job in entries:
            state = "expired" if job.result_expired else "partial" if job.status == "succeeded" and "unrecognized_regions" in (job.quality_flags or []) else job.status
            states[state] += 1
        chargeable = [job for job in jobs if kind == "job" or job.batch_id == group_id]
        first = jobs[0] if jobs else None
        items.append({"id": group_id, "kind": kind, "created_at": created_at.isoformat() + "Z",
                      "mode": first.mode if first else "", "target_language": first.target_language if first else "",
                      "page_count": len(entries), "counts": dict(states),
                      "settled": sum(job.quota_pages for job in chargeable if job.settlement == "settled"),
                      "reserved": sum(job.quota_pages for job in chargeable if job.settlement == "reserved"),
                      "reused": sum(1 for job in entries if job.cache_hit or kind == "batch" and job.batch_id != group_id),
                      "job_ids": [job.id for job in entries], "asset_ids": [job.requested_asset_id for job in entries]})
    return {"items": items, "total": total, "next_offset": offset + limit if offset + limit < total else None}
