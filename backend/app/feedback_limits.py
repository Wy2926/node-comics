"""Account-local Redis budgets, independent of translation quotas and queues."""
from hashlib import sha256
from fastapi import HTTPException
from .system_settings import get_request_limits
from .redis_state import bucket


def feedback_budget(db, owner_id, *, member='', limits=None):
    cfg = limits or get_request_limits(db)
    return bucket('feedback', owner_id, cfg.feedback_requests_per_minute,
        cfg.feedback_request_burst, member=member, daily=cfg.feedback_receipts_per_day)


def reserve_feedback_receipt(db, owner_id, idempotency_key, *, limits=None):
    # Redis deduplicates concurrent attempts; SQL keeps the durable unique receipt.
    member = sha256(idempotency_key.encode()).hexdigest()
    budget = feedback_budget(db, owner_id, member=member, limits=limits)
    if budget['allowed']:
        return
    retry = budget['retry_after_seconds']
    code, message = ('FEEDBACK_DAILY_LIMIT', '今日新反馈已达上限，已提交反馈仍可查询或重试') if budget['reason'] == 'daily' else (
        'FEEDBACK_RATE_LIMITED', '反馈提交过于频繁，请稍后重试')
    raise HTTPException(429, detail={'code': code, 'message': message, 'retry_after_seconds': retry},
        headers={'Retry-After': str(retry)})
