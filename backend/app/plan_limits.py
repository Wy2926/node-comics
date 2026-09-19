"""Exact rolling image admission and independent HTTP request protection."""
from datetime import timedelta
from math import ceil
from fastapi import HTTPException
from sqlalchemy import delete, select, text, update
from .config import settings
from .db import session_factory
from .models import now, uid
from .plan_models import ControlAdmission, ImageAdmission, ReadingSession, TranslationPolicy


def server_now(db):
    if db.get_bind().dialect.name == 'postgresql':
        return db.scalar(text("SELECT clock_timestamp() AT TIME ZONE 'UTC'"))
    return now()


def image_limit(db, user):
    from .entitlements import is_plus
    from .system_settings import get_request_limits
    cfg = get_request_limits(db)
    return cfg.plus_images_per_minute if is_plus(user) else cfg.free_images_per_minute


def image_budget(db, user, at=None):
    at = at or server_now(db)
    limit = image_limit(db, user)
    events = list(db.scalars(select(ImageAdmission.admitted_at).where(
        ImageAdmission.owner_id == user.id, ImageAdmission.admitted_at > at - timedelta(seconds=60),
        ImageAdmission.admitted_at <= at)
        .order_by(ImageAdmission.admitted_at)))
    delay = max(1, ceil((events[len(events) - limit] + timedelta(seconds=60) - at).total_seconds())) if len(events) >= limit else 0
    return {'window_seconds': 60, 'limit': limit, 'remaining': max(0, limit - len(events)), 'retry_after_seconds': delay}


def admit_image(db, user, job_id):
    at = server_now(db)
    budget = image_budget(db, user, at)
    if not budget['remaining']:
        raise HTTPException(429, detail={'code': 'IMAGE_RATE_LIMITED', 'message': '本分钟新增翻译图片已达上限',
            'scope': 'new_translation', 'retry_after_seconds': budget['retry_after_seconds']},
            headers={'Retry-After': str(budget['retry_after_seconds'])})
    db.add(ImageAdmission(owner_id=user.id, job_id=job_id, admitted_at=at))
    db.flush()


def policy_snapshot(db, user, *, released=False):
    from .entitlements import entitlements_json
    from .providers import digest
    from .scheduler import lock_scheduler
    from .notifications import publish
    lock_scheduler(db)
    rights = entitlements_json(db, user)
    def stable(value):
        if isinstance(value, dict):
            return {key: stable(item) for key, item in value.items() if key not in {'used', 'reserved', 'available'}}
        if isinstance(value, list):
            return [stable(item) for item in value]
        return value
    identity = stable({key: rights[key] for key in ('plan', 'plus_started_at', 'plus_expires_at', 'modes')})
    fingerprint = digest({'rights': identity, 'images': image_limit(db, user)})
    row = db.get(TranslationPolicy, user.id)
    if row is None:
        row = TranslationPolicy(owner_id=user.id, revision=1, fingerprint=fingerprint)
        db.add(row)
    elif row.fingerprint != fingerprint or released:
        row.fingerprint, row.revision = fingerprint, row.revision + 1
        publish(db, 'user:' + user.id)
    db.flush()
    return str(row.revision)


def acquire_control(owner_id, scope='plan'):
    cfg, at, token = settings(), now(), uid()
    with session_factory()() as db:
        if db.get_bind().dialect.name == 'postgresql':
            from sqlalchemy.dialects.postgresql import insert
        else:
            from sqlalchemy.dialects.sqlite import insert
        db.execute(insert(ControlAdmission).values(owner_id=owner_id, scope=scope,
            tokens=cfg.plan_request_burst, refilled_at=at, leases=[]).on_conflict_do_nothing())
        row = db.scalar(select(ControlAdmission).where(ControlAdmission.owner_id == owner_id,
            ControlAdmission.scope == scope).with_for_update())
        row.tokens = min(cfg.plan_request_burst, row.tokens + max(0, (at - row.refilled_at).total_seconds()) * cfg.plan_requests_per_minute / 60)
        row.refilled_at = max(at, row.refilled_at)
        row.leases = [entry for entry in row.leases if entry['until'] > at.isoformat()]
        busy = len(row.leases) >= cfg.plan_request_concurrency
        denied = busy or row.tokens < 1
        retry = 1 if busy else max(1, ceil((1 - row.tokens) * 60 / cfg.plan_requests_per_minute))
        if not denied:
            row.tokens -= 1
            row.leases = [*row.leases, {'id': token, 'until': (at + timedelta(seconds=cfg.plan_request_lease_seconds)).isoformat()}]
        db.commit()
    if denied:
        raise HTTPException(429, detail={'code': 'CONTROL_BUSY' if busy else 'CONTROL_RATE_LIMITED',
            'message': '请求过于频繁，请稍后重试', 'scope': 'control_request', 'retry_after_seconds': retry},
            headers={'Retry-After': str(retry)})
    return token


def release_control(owner_id, token, scope='plan'):
    with session_factory()() as db:
        db.execute(update(ControlAdmission).where(ControlAdmission.owner_id == owner_id,
            ControlAdmission.scope == scope).values(tokens=ControlAdmission.tokens))
        row = db.scalar(select(ControlAdmission).where(ControlAdmission.owner_id == owner_id,
            ControlAdmission.scope == scope).with_for_update())
        if row:
            row.leases = [entry for entry in row.leases if entry['id'] != token]
            db.commit()


def clean_admissions(db):
    db.execute(delete(ImageAdmission).where(ImageAdmission.admitted_at <= now() - timedelta(minutes=2)))
    # Keep a compact fencing tombstone, but never retain historical image windows.
    db.execute(update(ReadingSession).where(ReadingSession.expires_at <= now()).values(window=[]))
