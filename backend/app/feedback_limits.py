"""Account-local feedback budgets, independent of translation quotas and queues."""
from datetime import timedelta
from math import ceil
from fastapi import HTTPException
from sqlalchemy import select
from .system_settings import get_request_limits
from .feedback_models import FeedbackAdmission
from .models import now


def lock_feedback_admission(db, owner_id, *, limits=None):
    """Serialize receipt checks and creation in the caller's single transaction."""
    if db.get_bind().dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    at = now()
    cfg = limits or get_request_limits(db)
    db.execute(insert(FeedbackAdmission).values(
        owner_id=owner_id, request_tokens=cfg.feedback_request_burst,
        refilled_at=at, day_started_at=at.replace(hour=0, minute=0, second=0, microsecond=0),
        daily_receipts=0,
    ).on_conflict_do_nothing(index_elements=["owner_id"]))
    row = db.scalar(select(FeedbackAdmission).where(FeedbackAdmission.owner_id == owner_id)
                    .with_for_update().execution_options(populate_existing=True))
    # Account for time spent waiting on this account's other request, if any.
    at = now()
    elapsed = max(0, (at - row.refilled_at).total_seconds())
    row.request_tokens = min(cfg.feedback_request_burst,
                             row.request_tokens + elapsed * cfg.feedback_requests_per_minute / 60)
    row.refilled_at = max(at, row.refilled_at)
    day = at.replace(hour=0, minute=0, second=0, microsecond=0)
    if row.day_started_at < day:
        row.day_started_at, row.daily_receipts = day, 0
    return row


def reserve_feedback_receipt(db, row, *, limits=None):
    """Reserve one new receipt; a replay never calls this function.

    Successful creation commits both the feedback and its budget atomically.
    A denial commits just the bounded account record before returning 429.
    """
    cfg = limits or get_request_limits(db)
    if row.request_tokens < 1:
        retry = max(1, ceil((1 - row.request_tokens) * 60 / cfg.feedback_requests_per_minute))
        code, message = "FEEDBACK_RATE_LIMITED", "反馈提交过于频繁，请稍后重试"
    else:
        row.request_tokens -= 1
        if row.daily_receipts < cfg.feedback_receipts_per_day:
            row.daily_receipts += 1
            return
        retry = max(1, ceil((row.day_started_at + timedelta(days=1) - now()).total_seconds()))
        code, message = "FEEDBACK_DAILY_LIMIT", "今日新反馈已达上限，已提交反馈仍可查询或重试"
    db.commit()
    raise HTTPException(429, detail={"code": code, "message": message, "retry_after_seconds": retry},
                        headers={"Retry-After": str(retry)})
