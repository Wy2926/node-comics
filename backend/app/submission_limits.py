"""Database admission budgets and compact, permanent idempotency receipts."""
from datetime import datetime, timedelta
from math import ceil
from fastapi import HTTPException
from sqlalchemy import delete, exists, or_, select
from .config import settings
from .db import session_factory
from .job_requests import JobRequest
from .models import Job, now, uid
from .queue_models import Submission, SubmissionAdmission, SubmissionItem


def _locked_admission(db, owner_id, at):
    # INSERT acquires the SQLite write lock; PostgreSQL serializes just this
    # account. The scheduler lock is deliberately never acquired here.
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    cfg = settings()
    db.execute(insert(SubmissionAdmission).values(owner_id=owner_id,
        request_tokens=cfg.submission_request_burst, item_tokens=cfg.submission_item_burst,
        refilled_at=at, day_started_at=at.replace(hour=0, minute=0, second=0, microsecond=0),
        daily_submissions=0, daily_items=0, leases=[]).on_conflict_do_nothing(index_elements=["owner_id"]))
    return db.scalar(select(SubmissionAdmission).where(SubmissionAdmission.owner_id == owner_id).with_for_update())


def acquire_submission(owner_id, key, item_count):
    """Commit budgets separately so rejected/rolled-back work still costs tokens."""
    cfg, at, token = settings(), now(), uid()
    denied = None
    with session_factory()() as db:
        row = _locked_admission(db, owner_id, at)
        elapsed = max(0, (at - row.refilled_at).total_seconds())
        row.request_tokens = min(cfg.submission_request_burst, row.request_tokens + elapsed * cfg.submission_requests_per_minute / 60)
        row.item_tokens = min(cfg.submission_item_burst, row.item_tokens + elapsed * cfg.submission_items_per_minute / 60)
        row.refilled_at = max(at, row.refilled_at)
        day = at.replace(hour=0, minute=0, second=0, microsecond=0)
        if row.day_started_at < day:
            row.day_started_at, row.daily_submissions, row.daily_items = day, 0, 0
        row.leases = [lease for lease in row.leases if lease["until"] > at.isoformat()]
        replay = db.scalar(select(Submission.id).where(Submission.owner_id == owner_id, Submission.idempotency_key == key)) is not None
        large = item_count >= cfg.submission_large_batch_items
        if row.request_tokens < 1 or row.item_tokens < item_count:
            retry = max((1 - row.request_tokens) * 60 / cfg.submission_requests_per_minute,
                        (item_count - row.item_tokens) * 60 / cfg.submission_items_per_minute)
            denied = ("SUBMISSION_RATE_LIMITED", "提交过于频繁，请稍后重试", max(1, ceil(retry)))
        else:
            row.request_tokens -= 1
            row.item_tokens -= item_count
            if len(row.leases) >= cfg.submission_concurrency or (large and sum(lease["large"] for lease in row.leases) >= cfg.submission_large_batch_concurrency):
                retry = min((datetime.fromisoformat(lease["until"]) - at).total_seconds() for lease in row.leases)
                denied = ("SUBMISSION_BUSY", "已有提交正在处理中，请等待其返回后重试", max(1, ceil(retry)))
            elif not replay and (row.daily_submissions >= cfg.submission_receipts_per_day or row.daily_items + item_count > cfg.submission_items_per_day):
                denied = ("SUBMISSION_DAILY_LIMIT", "今日提交请求或清单页数已达上限，已有操作仍可查询或重试", max(1, ceil((day + timedelta(days=1) - at).total_seconds())))
            else:
                if not replay:
                    row.daily_submissions += 1
                    row.daily_items += item_count
                row.leases = [*row.leases, {"id": token, "large": large,
                    "until": (at + timedelta(seconds=cfg.submission_admission_lease_seconds)).isoformat()}]
        db.commit()
    if denied:
        code, message, retry = denied
        raise HTTPException(429, detail={"code": code, "message": message, "retry_after_seconds": retry}, headers={"Retry-After": str(retry)})
    return token


def release_submission(owner_id, token):
    with session_factory()() as db:
        row = _locked_admission(db, owner_id, now())
        row.leases = [lease for lease in row.leases if lease["id"] != token]
        db.commit()


def archive_submission_receipts(db, limit=100):
    """Drop terminal manifest details, retaining keys forever to prevent reexecution."""
    from .scheduler import ACTIVE, lock_scheduler
    lock_scheduler(db)
    cutoff = now() - timedelta(days=settings().submission_receipt_retention_days)
    pending = exists(select(SubmissionItem.submission_id).join(Job, Job.id == SubmissionItem.job_id)
        .where(SubmissionItem.submission_id == Submission.id,
            or_(Job.status.in_(ACTIVE), Job.completed_at.is_(None), Job.completed_at > cutoff)))
    rows = db.scalars(select(Submission).where(Submission.archived_at.is_(None),
        Submission.created_at < cutoff, ~pending).order_by(Submission.created_at, Submission.id).limit(limit)).all()
    if rows:
        db.execute(delete(SubmissionItem).where(SubmissionItem.submission_id.in_([row.id for row in rows])))
        for row in rows:
            # Internal per-item receipts have no public entry point. The durable
            # submission tombstone is the authority for all future replays.
            db.execute(delete(JobRequest).where(JobRequest.owner_id == row.owner_id,
                JobRequest.operation == "submission", JobRequest.idempotency_key.startswith(row.id + ":")))
            row.archived_at = now()
    return len(rows)
