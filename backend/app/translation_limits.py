"""Redis image admission and independent HTTP request protection."""
from fastapi import HTTPException
from sqlalchemy import text
from .config import settings
from .models import now, uid
from . import redis_state


def server_now(db):
    if db.get_bind().dialect.name == 'postgresql':
        return db.scalar(text("SELECT clock_timestamp() AT TIME ZONE 'UTC'"))
    return now()


def image_limit(db, user):
    from .entitlements import is_plus
    from .system_settings import get_request_limits
    cfg = get_request_limits(db)
    return cfg.plus_images_per_minute if is_plus(db, user) else cfg.free_images_per_minute


def image_budget(db, user, at=None):
    budget = redis_state.window('image', user.id, image_limit(db, user))
    return {key: budget[key] for key in ['window_seconds', 'limit', 'remaining', 'retry_after_seconds']}


def admit_image(db, user, job_id):
    budget = redis_state.window('image', user.id, image_limit(db, user), member=job_id)
    retry = budget['retry_after_seconds']
    if retry:
        raise HTTPException(429, detail={'code': 'IMAGE_RATE_LIMITED', 'message': '本分钟新增翻译图片已达上限',
            'scope': 'new_translation', 'retry_after_seconds': retry}, headers={'Retry-After': str(retry)})


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
