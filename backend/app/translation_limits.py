"""Redis image admission and independent HTTP request protection."""
from fastapi import HTTPException
from sqlalchemy import event, text
from sqlalchemy.orm import Session
from .config import settings
from .models import now, uid
from . import redis_state


def server_now(db):
    if db.get_bind().dialect.name == 'postgresql':
        return db.scalar(text("SELECT clock_timestamp() AT TIME ZONE 'UTC'"))
    return now()


def image_limit(db, user, *, policy=None):
    from .entitlements import admission_policy
    from .system_settings import get_request_limits
    guest_operation = user.kind == 'guest' and bool(db.info.get('guest_network'))
    cfg = db.info.get('guest_limits') if guest_operation else None
    if cfg is None:
        cfg = get_request_limits(db)
        if guest_operation:
            db.info['guest_limits'] = cfg  # Shared only until this guest operation exits.
    policy = policy or admission_policy(db, user)
    return cfg.plus_images_per_minute if policy.priority else cfg.free_images_per_minute


def image_budget(db, user, at=None):
    budget = redis_state.window('image', user.id, image_limit(db, user))
    return {key: budget[key] for key in ['window_seconds', 'limit', 'remaining', 'retry_after_seconds']}


def admit_image(db, user, job_id, *, policy=None):
    from .entitlements import admission_policy
    policy = policy or admission_policy(db, user)
    hourly_limit = policy.hourly_image_limit
    if hourly_limit is not None:
        budget = redis_state.window('image-hourly', user.id, hourly_limit, member=job_id, seconds=3600)
        retry = budget['retry_after_seconds']
        if retry:
            raise HTTPException(429, detail={'code': 'IMAGE_RATE_LIMITED', 'message': '本小时新增翻译图片已达上限',
                'scope': 'new_translation', 'window_seconds': 3600, 'retry_after_seconds': retry},
                headers={'Retry-After': str(retry)})
        transaction = db.get_nested_transaction() or db.get_transaction()
        db.info.setdefault('hourly_image_reservations', {}).setdefault(transaction, []).append((user.id, job_id))
    budget = redis_state.window('image', user.id, image_limit(db, user, policy=policy), member=job_id)
    retry = budget['retry_after_seconds']
    if retry:
        raise HTTPException(429, detail={'code': 'IMAGE_RATE_LIMITED', 'message': '本分钟新增翻译图片已达上限',
            'scope': 'new_translation', 'retry_after_seconds': retry}, headers={'Retry-After': str(retry)})


def release_hourly(reservations):
    for owner_id, job_id in reservations:
        try:
            redis_state.release_window('image-hourly', owner_id, job_id)
        except redis_state.AdmissionUnavailable:
            pass  # Fail closed until this bounded reservation expires; preserve the original error.


@event.listens_for(Session, 'after_commit')
def commit_hourly(db):
    pending = db.info.get('hourly_image_reservations')
    if not pending:
        return
    transaction = db.get_nested_transaction()
    if transaction:
        pending.setdefault(transaction.parent, []).extend(pending.pop(transaction, ()))
    else:
        db.info.pop('hourly_image_reservations', None)


@event.listens_for(Session, 'after_rollback')
def rollback_hourly(db):
    pending = db.info.get('hourly_image_reservations', {})
    transaction = db.get_nested_transaction() or db.get_transaction()
    release_hourly(pending.pop(transaction, ()))


@event.listens_for(Session, 'after_transaction_end')
def close_hourly(db, transaction):
    # Session.close() also rolls back; flush-internal transactions have no entries.
    pending = db.info.get('hourly_image_reservations', {})
    release_hourly(pending.pop(transaction, ()))
    if not pending:
        db.info.pop('hourly_image_reservations', None)


def control_budget(owner_id, scope='translation', *, member='', lease_seconds=None):
    cfg = settings()
    return redis_state.bucket('control', owner_id + ':' + scope, cfg.translation_requests_per_minute,
        cfg.translation_request_burst, member=member, concurrency=cfg.translation_request_concurrency,
        lease_seconds=lease_seconds or cfg.translation_request_lease_seconds)


def acquire_control(owner_id, scope='translation', *, lease_seconds=None):
    token = uid()
    budget = control_budget(owner_id, scope, member=token, lease_seconds=lease_seconds)
    if not budget['allowed']:
        retry = budget['retry_after_seconds']
        raise HTTPException(429, detail={'code': 'REQUEST_RATE_LIMITED',
            'message': '请求过于频繁，请稍后重试', 'scope': 'control_request', 'retry_after_seconds': retry},
            headers={'Retry-After': str(retry)})
    return token


def release_control(owner_id, token, scope='translation'):
    try:
        redis_state.command('zrem', redis_state.key('control-leases', owner_id + ':' + scope), token)
    except redis_state.AdmissionUnavailable:
        pass  # Expiring token cannot block the account permanently.
