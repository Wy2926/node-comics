"""Fail-closed visitor admission; execution and artifacts use the existing pipeline."""
from datetime import timedelta, timezone
from hashlib import sha256
import hmac
from ipaddress import ip_address, ip_network
import secrets
from urllib.parse import urlsplit
from uuid import UUID
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import Field
from sqlalchemy import func, select, delete, update, literal_column
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from . import translation_api as translations, redis_state
from .config import settings
from .db import get_db
from .errors import problem
from .guest_models import GuestSession, GuestDailyUsage, GuestDailyBudget
from .models import User, Job, Ledger, Asset, now, uid
from .request_models import RequestBody
from .scheduler import ACTIVE
from .system_settings import get_request_limits
from .translation_requests import TranslationRequest

router = APIRouter(prefix='/v1/guest', tags=['Anonymous image translation'])


def enabled():
    cfg = settings()
    return bool(cfg.guest_enabled and cfg.turnstile_site_key and cfg.turnstile_secret_key.get_secret_value()
                and len(cfg.guest_hash_secret.get_secret_value()) >= 32)


def require_enabled():
    if not enabled():
        problem('GUEST_UNAVAILABLE', '匿名体验暂未开放，请登录后翻译', 503)


def same_origin(request):
    # The custom header prevents simple cross-origin reads; writes additionally
    # require Origin. Never accept a user-provided owner ID or forwarded IP here.
    if request.headers.get('x-guest-request') != '1' or request.headers.get('sec-fetch-site') == 'cross-site':
        problem('GUEST_ORIGIN_REQUIRED', '请从官网使用匿名体验', 403)
    origin = request.headers.get('origin')
    if (origin and origin != settings().guest_origin) or (request.method not in ('GET', 'HEAD') and origin != settings().guest_origin):
        problem('GUEST_ORIGIN_REQUIRED', '请从官网使用匿名体验', 403)


def network_key(request):
    try:
        address = ip_address(request.client.host)
        if address.version == 6 and address.ipv4_mapped:
            address = address.ipv4_mapped
        network = str(ip_network(f'{address}/{64 if address.version == 6 else 32}', strict=False))
    except (ValueError, AttributeError):
        problem('GUEST_NETWORK_UNAVAILABLE', '无法验证网络，请登录后使用', 503)
    return hmac.new(settings().guest_hash_secret.get_secret_value().encode(), network.encode(), 'sha256').hexdigest()


def throttle(request, scope, rate=30, burst=5):
    result = redis_state.bucket('guest-' + scope, network_key(request), rate, burst, member=uid())
    if not result['allowed']:
        raise HTTPException(429, detail={'code': 'REQUEST_RATE_LIMITED', 'message': '请求过于频繁，请稍后再试'},
                            headers={'Retry-After': str(result['retry_after_seconds'])})


def verify(token, action):
    require_enabled()
    if not token or len(token) > 2048:
        problem('VERIFICATION_REQUIRED', '请完成人机验证', 403)
    try:
        with httpx.Client(timeout=10, follow_redirects=False) as client:
            response = client.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', data={
                'secret': settings().turnstile_secret_key.get_secret_value(), 'response': token})
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError):
        problem('VERIFICATION_UNAVAILABLE', '验证服务暂时不可用，请重试或登录', 503)
    if not isinstance(data, dict) or data.get('success') is not True or data.get('action') != action or data.get('hostname') != urlsplit(settings().guest_origin).hostname:
        problem('VERIFICATION_FAILED', '验证已失效，请重新验证', 403)


def cookie_name():
    return '__Host-nc-guest' if settings().app_env == 'production' else 'nc-guest'


def find_session(request, db):
    token = request.cookies.get(cookie_name(), '')
    if not 32 <= len(token) <= 128:
        return None
    return db.scalar(select(GuestSession).where(GuestSession.token_hash == sha256(token.encode()).hexdigest(),
        GuestSession.revoked_at.is_(None), GuestSession.expires_at > now()))


def guest_identity(request: Request, db: Session = Depends(get_db)):
    same_origin(request)
    throttle(request, 'read', 120, 30)
    session = find_session(request, db)
    user = db.get(User, session.user_id) if session else None
    if not user or user.kind != 'guest':
        problem('GUEST_SESSION_EXPIRED', '匿名会话已失效，不能恢复此前任务', 401)
    request.state.guest_expires_at = session.expires_at.replace(tzinfo=timezone.utc).timestamp()
    return user


def day_window(at):
    local = at.replace(tzinfo=timezone.utc).astimezone(ZoneInfo(settings().quota_timezone))
    end = (local.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)).astimezone(timezone.utc)
    return local.date(), end


def session_json(db, session):
    day, end = day_window(now())
    limits = get_request_limits(db)
    used = db.get(GuestDailyUsage, (session.user_id, day)) if session else None
    return {'enabled': enabled(), 'site_key': settings().turnstile_site_key if enabled() else '',
        'user_id': session.user_id if session else None, 'daily_limit': limits.guest_daily_limit,
        'remaining': max(0, limits.guest_daily_limit - (used.accepted_count if used else 0)),
        'resets_at': end.isoformat(), 'result_retention_hours': 24}


@router.get('/session')
def session_status(request: Request, db: Session = Depends(get_db)):
    same_origin(request)
    throttle(request, 'read', 120, 30)
    return session_json(db, find_session(request, db))


class SessionInput(RequestBody):
    token: str = Field(min_length=1, max_length=2048)


@router.post('/session')
def start_session(body: SessionInput, request: Request, response: Response, db: Session = Depends(get_db)):
    same_origin(request)
    require_enabled()
    throttle(request, 'session', 5, 2)
    old = find_session(request, db)
    if old:
        return session_json(db, old)
    db.close()  # Remote verification must not hold a database connection.
    verify(body.token, 'guest_session')
    token = secrets.token_urlsafe(32)
    user = User(id=uid(), kind='guest', subject=None, name='匿名访客', role='user')
    db.add(user)
    db.flush()
    session = GuestSession(user_id=user.id, token_hash=sha256(token.encode()).hexdigest(), expires_at=now() + timedelta(days=30))
    db.add(session)
    db.commit()
    response.set_cookie(cookie_name(), token, httponly=True, secure=settings().app_env == 'production',
                        samesite='strict', max_age=30 * 86400, path='/')
    return session_json(db, session)


def reserve_guest(db, user, job, at):
    # create_job holds the global scheduler lock then owner lock across these
    # SQL counters and task creation: no cross-database daily quota transaction.
    require_enabled()
    network = db.info.get('guest_network')
    if not network or job.mode != 'classic':
        problem('GUEST_FORBIDDEN', '匿名任务缺少有效准入', 403)
    cfg = settings()
    limits = db.info.get('guest_limits') or get_request_limits(db)
    active = select(Job.id).where(Job.status.in_(ACTIVE), Job.id != job.id)
    if db.scalar(active.where(Job.owner_id == user.id).limit(1)):
        raise HTTPException(429, detail={'code': 'GUEST_BUSY', 'message': '请等待当前图片完成'}, headers={'Retry-After': '5'})
    if db.scalar(select(func.count()).select_from(Job).join(User, User.id == Job.owner_id).where(
            User.kind == 'guest', Job.status.in_(ACTIVE), Job.id != job.id)) >= cfg.guest_global_concurrency:
        raise HTTPException(429, detail={'code': 'GUEST_BUSY', 'message': '匿名体验繁忙，请稍后再试'}, headers={'Retry-After': '10'})
    day, end = day_window(at)
    specs = [(GuestDailyUsage, (user.id, day), {'user_id': user.id, 'day': day}, limits.guest_daily_limit, 'GUEST_DAILY_LIMIT'),
             (GuestDailyBudget, (network, day), {'key': network, 'day': day}, limits.guest_network_daily_limit, 'GUEST_NETWORK_LIMIT'),
             (GuestDailyBudget, ('global', day), {'key': 'global', 'day': day}, limits.guest_global_daily_limit, 'GUEST_GLOBAL_LIMIT')]
    for model, key, values, limit, code in specs:
        row = db.get(model, key)
        if not row:
            row = model(**values, accepted_count=0)
            db.add(row)
        if row.accepted_count >= limit:
            problem(code, '今日匿名体验次数已用完，请登录后使用账户额度', 429, resets_at=end.isoformat())
        row.accepted_count += 1
    job.quota_kind, job.quota_pages, job.settlement = 'guest_trial', 0, 'settled'
    job.entitlement = {'plan': 'guest', 'accepted_at': at.isoformat() + 'Z', 'result_retention_hours': 24}
    db.add(Ledger(owner_id=user.id, job_id=job.id, quota_kind='guest_trial', transaction_key=job.id + ':guest-admit',
                  kind='guest_admit', amount=1, note='Anonymous admission, not successful-page billing'))


@router.put('/translations/{translation_id}')
def translate(translation_id: UUID, body: translations.TranslationInput, request: Request,
              token: str = Header(default='', alias='X-Turnstile-Token', max_length=2048),
              user: User = Depends(guest_identity), db: Session = Depends(get_db)):
    throttle(request, 'submit', 10, 3)
    old = db.get(TranslationRequest, (user.id, str(translation_id)))
    if not old:
        db.close()
        verify(token, 'guest_translate')
    db.info['guest_network'] = network_key(request)
    try:
        return translations.translate(translation_id, body, request, user, db)
    finally:
        db.info.pop('guest_network', None)
        db.info.pop('guest_limits', None)


@router.get('/translations/events')
async def events(request: Request, ids: str = Query(..., max_length=1183), user: User = Depends(guest_identity), db: Session = Depends(get_db)):
    from .translation_events import translation_events
    owner, keys = user.id, translations.parse_translation_ids(ids)
    await run_in_threadpool(db.close)
    return await translation_events(owner, keys, request, expires_at=request.state.guest_expires_at)


@router.get('/translations/{translation_id}')
async def get_translation(translation_id: UUID, request: Request, user: User = Depends(guest_identity), db: Session = Depends(get_db)):
    return await translations.translation_get(translation_id, request, user, db)


@router.put('/translations/{translation_id}/input')
async def input_translation(translation_id: UUID, request: Request, user: User = Depends(guest_identity), db: Session = Depends(get_db)):
    return await translations.translation_input(translation_id, request, user, db)


@router.get('/translations/{translation_id}/result')
def result_translation(translation_id: UUID, request: Request, user: User = Depends(guest_identity), db: Session = Depends(get_db)):
    return translations.translation_result(translation_id, request, user, db)


@router.post('/translations/{translation_id}/cancel')
def cancel_translation(translation_id: UUID, user: User = Depends(guest_identity), db: Session = Depends(get_db)):
    return translations.translation_cancel(translation_id, user, db)


@router.delete('/translations/{translation_id}')
def delete_translation(translation_id: UUID, user: User = Depends(guest_identity), db: Session = Depends(get_db)):
    return translations.translation_delete(translation_id, user, db)


def expire_guests(db):
    # Called under the scheduler lock by ordinary maintenance. Expiry is also
    # checked synchronously on reads and reuse, independent of cleanup timing.
    cutoff = now() - timedelta(hours=24)
    # A fixed predicate lets PostgreSQL prepared plans use the small expiry index.
    jobs = list(db.scalars(select(Job).where(Job.quota_kind == literal_column("'guest_trial'"),
        Job.completed_at <= cutoff, Job.discard_output.is_(False)).order_by(Job.completed_at).limit(100)))
    for job in jobs:
        job.discard_output = True
        db.execute(update(TranslationRequest).where(TranslationRequest.job_id == job.id,
            TranslationRequest.revoked_at.is_(None)).values(revoked_at=now()))
        if job.output_asset_id:
            output = db.get(Asset, job.output_asset_id)
            if output:
                output.deleted_at = output.deleted_at or now()
    expired = db.execute(select(GuestSession.id, GuestSession.user_id).where(
        GuestSession.expires_at < now()).limit(200)).all()
    if expired:
        db.execute(delete(GuestSession).where(GuestSession.id.in_([row.id for row in expired])))
    # Keep seven days of admission evidence. Cost/UUID records retain ownership.
    day = day_window(now() - timedelta(days=7))[0]
    for model in (GuestDailyUsage, GuestDailyBudget):
        from sqlalchemy import tuple_
        columns = (model.user_id, model.day) if model is GuestDailyUsage else (model.key, model.day)
        old = select(*columns).where(model.day < day).limit(200)
        db.execute(delete(model).where(tuple_(*columns).in_(old)))
    # Users and sessions are created atomically, so expiry supplies the bounded
    # candidates without scanning permanently retained task owners each pass.
    if expired:
        unused = select(User.id).where(User.kind == 'guest', User.id.in_({row.user_id for row in expired}),
            ~select(GuestSession.id).where(GuestSession.user_id == User.id).exists(),
            ~select(Job.id).where(Job.owner_id == User.id).exists(),
            ~select(GuestDailyUsage.user_id).where(GuestDailyUsage.user_id == User.id).exists())
        db.execute(delete(User).where(User.id.in_(unused)))
