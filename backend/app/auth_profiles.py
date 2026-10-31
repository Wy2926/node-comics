"""A per-user profile cache doubles as a coalescing, durable sync queue."""
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import logging
import time

from fastapi import APIRouter, Depends, Request
from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, or_, select, update
from sqlalchemy.orm import Mapped, mapped_column
from starlette.concurrency import run_in_threadpool

from .auth import admin
from .admin_audit import record_audit
from .config import settings
from .db import Base, session_factory
from .entitlements import iso
from .errors import problem
from . import logto_profiles
from .models import User, now, uid


class AuthProfile(Base):
    __tablename__ = 'user_auth_profiles'
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    email: Mapped[str | None] = mapped_column(String(320))
    username: Mapped[str | None] = mapped_column(String(128))
    name: Mapped[str | None] = mapped_column(String(256))
    phone: Mapped[str | None] = mapped_column(String(64))
    suspended: Mapped[bool | None] = mapped_column(Boolean)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False, server_default='0')
    auth_created_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_sign_in_at: Mapped[datetime | None] = mapped_column(DateTime)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime)
    attempted_at: Mapped[datetime | None] = mapped_column(DateTime)
    event_at: Mapped[datetime | None] = mapped_column(DateTime)
    generation: Mapped[int] = mapped_column(Integer, default=0, server_default='0')
    next_sync_at: Mapped[datetime | None] = mapped_column(DateTime, default=now)
    claim: Mapped[str | None] = mapped_column(String(36))
    error_code: Mapped[str | None] = mapped_column(String(32))
    __table_args__ = (Index('ix_auth_profiles_due', 'next_sync_at', 'owner_id'),)


ERRORS = {'credentials': 'Auth 查询凭据无效', 'permissions': 'Auth 查询权限不足',
          'rate_limited': 'Auth 查询限流，稍后自动重试', 'unavailable': '暂时无法连接 Auth',
          'invalid_response': 'Auth 返回资料无效'}
EVENTS = {'User.Created', 'User.Data.Updated', 'User.SuspensionStatus.Updated', 'User.Deleted', 'PostSignIn', 'PostRegister'}


def auth_id(user):
    prefix = settings().oidc_issuer + '|'
    if not settings().oidc_issuer or user.kind != 'registered' or not (user.subject or '').startswith(prefix):
        return None
    value = user.subject[len(prefix):]
    return value if value and value not in {'.', '..'} else None


def ensure_profile(db, owner_id):
    if db.get_bind().dialect.name == 'postgresql':
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    db.execute(insert(AuthProfile).values(owner_id=owner_id, next_sync_at=now())
               .on_conflict_do_nothing(index_elements=['owner_id']))


def profile_json(user, profile):
    return {'configured': logto_profiles.enabled(), 'supported': bool(auth_id(user)), 'auth_user_id': auth_id(user),
        **{key: getattr(profile, key, None) for key in ('email', 'username', 'name', 'phone', 'suspended', 'deleted')},
        **{key: iso(getattr(profile, key, None)) for key in
            ('auth_created_at', 'last_sign_in_at', 'synced_at', 'attempted_at')},
        'pending': bool(profile and profile.next_sync_at), 'error': ERRORS.get(profile.error_code) if profile else None}


def sync_profile(owner_id, actor_id=None):
    at, claim = now(), uid()
    with session_factory()() as db:
        user = db.get(User, owner_id)
        if not user:
            problem('NOT_FOUND', '用户不存在', 404)
        remote_id = auth_id(user)
        if not remote_id:
            problem('AUTH_PROFILE_UNSUPPORTED', '此用户未关联当前 Auth', 409)
        if not logto_profiles.enabled():
            problem('AUTH_PROFILE_UNCONFIGURED', '尚未配置后端 Auth 查询凭据', 503)
        ensure_profile(db, owner_id)
        ready = or_(AuthProfile.claim.is_(None), AuthProfile.next_sync_at <= at)
        if actor_id:
            ready &= or_(AuthProfile.attempted_at.is_(None), AuthProfile.attempted_at <= at - timedelta(seconds=10))
        else:
            ready &= AuthProfile.next_sync_at <= at
        claimed = db.execute(update(AuthProfile).where(AuthProfile.owner_id == owner_id, ready)
            .values(claim=claim, attempted_at=at, next_sync_at=at + timedelta(seconds=60)))
        generation = db.get(AuthProfile, owner_id).generation
        db.commit()
        if not claimed.rowcount:
            if actor_id:
                problem('AUTH_PROFILE_BUSY', '正在同步或刚刚刷新过，请稍后重试', 409)
            return
    values, error = {}, None
    try:
        values = {**logto_profiles.client().fetch(remote_id), 'deleted': False}
    except logto_profiles.ProfileError as failure:
        if str(failure) == 'not_found':
            values = {'deleted': True}
        else:
            error = str(failure)
    with session_factory()() as db:
        profile = db.scalar(select(AuthProfile).where(AuthProfile.owner_id == owner_id).with_for_update())
        if profile.claim != claim:
            return profile_json(db.get(User, owner_id), profile)
        for key, value in values.items():
            if key == 'last_sign_in_at' and profile.last_sign_in_at:
                value = max(profile.last_sign_in_at, value) if value else profile.last_sign_in_at
            setattr(profile, key, value)
        profile.claim, profile.error_code = None, error
        profile.next_sync_at = now() + timedelta(seconds=60) if error else (now() if profile.generation != generation else None)
        if not error:
            profile.synced_at = now()
        if actor_id:
            record_audit(db, actor_id, 'user.auth_profile.refresh', 'user', owner_id,
                         details={'status': 'failed' if error else 'synced', 'error_code': error})
        db.commit()
        return profile_json(db.get(User, owner_id), profile)


def receive_event(value):
    try:
        kind = value['event']
        if kind not in EVENTS:
            return
        event_at = datetime.fromisoformat(value['createdAt'].replace('Z', '+00:00'))
        if event_at.tzinfo is None or event_at > datetime.now(timezone.utc) + timedelta(minutes=5):
            raise ValueError()
        event_at = event_at.astimezone(timezone.utc).replace(tzinfo=None)
        data, user, params = value.get('data') or {}, value.get('user') or {}, value.get('params') or {}
        remote_id = data.get('id') or user.get('id') or value.get('userId') or params.get('userId') or params.get('id')
        if not isinstance(remote_id, str) or not remote_id or len(remote_id) > 128:
            raise ValueError()
    except (KeyError, TypeError, ValueError, AttributeError):
        problem('AUTH_WEBHOOK_INVALID', '无效的 Auth 事件', 400)
    with session_factory()() as db:
        owner = db.scalar(select(User.id).where(User.subject == f'{settings().oidc_issuer}|{remote_id}', User.kind == 'registered'))
        if not owner:
            return  # Other NodeLane products are outside this app's user directory.
        ensure_profile(db, owner)
        profile = db.scalar(select(AuthProfile).where(AuthProfile.owner_id == owner).with_for_update())
        # The callback is a signal, not an authoritative snapshot. Duplicate/older signals need no new read.
        if profile.event_at is None or event_at > profile.event_at:
            profile.event_at = event_at
            profile.generation += 1
            if not profile.claim:
                profile.next_sync_at = now()
        db.commit()


def sync_due(stopping=None, *, discover=True):
    if not logto_profiles.enabled():
        return
    with session_factory()() as db:
        # First-use and existing accounts are filled in bounded batches; no periodic full-user refresh.
        missing = list(db.scalars(select(User.id).where(User.kind == 'registered',
            User.subject.startswith(settings().oidc_issuer + '|', autoescape=True),
            ~select(AuthProfile.owner_id).where(AuthProfile.owner_id == User.id).exists()).limit(20))) if discover else []
        for owner in missing:
            ensure_profile(db, owner)
        db.commit()
        due = list(db.scalars(select(AuthProfile.owner_id).where(AuthProfile.next_sync_at <= now())
            .order_by(AuthProfile.next_sync_at).limit(20)))
    for owner in due:
        if stopping and stopping.is_set():
            break
        sync_profile(owner)


def run(stopping):
    discover_at = 0
    while not stopping.is_set():
        try:
            discover = time.monotonic() >= discover_at
            sync_due(stopping, discover=discover)
            if discover:
                discover_at = time.monotonic() + 60
        except Exception:
            logging.warning('Auth profile sync interrupted; durable work will retry')
        stopping.wait(5)


router = APIRouter()


@router.post('/webhooks/logto', include_in_schema=False)
async def webhook(request: Request):
    secret = settings().logto_webhook_secret.get_secret_value()
    if not secret or not logto_profiles.enabled():
        problem('AUTH_PROFILE_UNCONFIGURED', 'Auth 同步未配置', 503)
    body = await request.body()
    signature = request.headers.get('logto-signature-sha-256', '')
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    if len(signature) != 64 or not hmac.compare_digest(signature.lower().encode(), expected.encode()):
        problem('AUTH_WEBHOOK_SIGNATURE', '无效的 Auth 签名', 401)
    try:
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError()
    except ValueError:
        problem('AUTH_WEBHOOK_INVALID', '无效的 Auth 事件', 400)
    await run_in_threadpool(receive_event, value)
    return {'received': True}


@router.post('/v1/admin/users/{user_id}/auth-profile/refresh')
def refresh(user_id: str, actor: User = Depends(admin)):
    return sync_profile(user_id, actor.id)
