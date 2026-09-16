"""Authenticated account actions plus signed Paddle webhook and checkout handoff."""
import hashlib
import json
from pathlib import Path
import re
from typing import Annotated
from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from . import paddle_client as paddle
from .auth import identity
from .billing_checkout import billing_status, start_checkout, sync_owner
from .billing_models import BillingCheckout, BillingEvent, BillingSubscription
from .billing_sync import process_event, timestamp, sync_subscription
from .config import settings
from .db import get_db
from .entitlements import entitlements_json
from .errors import problem
from .models import User, now
from .request_models import RequestBody

router = APIRouter(tags=['billing'])


def billing_error(exc):
    messages = {'PADDLE_SUBSCRIPTION_EXISTS': '已有订阅或尚未到期的订阅权益，请管理当前订阅',
        'PADDLE_CHECKOUT_PENDING': '结账正在创建，请稍后刷新',
        'PADDLE_CHECKOUT_UNCERTAIN': '正在核实原结账结果，请稍后重试，不会重复创建付款',
        'BILLING_DISABLED': '订阅暂未开放',
        'PADDLE_TRANSACTION_CHECKOUT_NOT_ENABLED': '管理员尚未设置 Paddle 默认付款链接'}
    messages['PADDLE_TRANSACTION_DEFAULT_CHECKOUT_URL_NOT_SET'] = '管理员尚未设置 Paddle 默认付款链接'
    problem(exc.code, messages.get(exc.code, '支付服务暂时不可用，请稍后重试或联系管理员'), 503 if exc.uncertain else 409)


@router.get('/v1/billing/status')
def status(user: User = Depends(identity), db: Session = Depends(get_db)):
    return billing_status(db, user)


@router.post('/v1/billing/checkouts')
def checkout(user: User = Depends(identity)):
    try:
        return start_checkout(user.id)
    except paddle.PaddleError as exc:
        billing_error(exc)


@router.post('/v1/billing/sync')
def sync(user: User = Depends(identity), db: Session = Depends(get_db)):
    try:
        sync_owner(user.id)
    except paddle.PaddleError as exc:
        billing_error(exc)
    db.expire_all()
    return {'billing': billing_status(db, user), 'entitlements': entitlements_json(db, user)}


@router.post('/v1/billing/cancel')
def cancel(user: User = Depends(identity), db: Session = Depends(get_db)):
    sub = db.scalar(select(BillingSubscription).where(BillingSubscription.owner_id == user.id,
        BillingSubscription.status.in_(['active', 'trialing', 'past_due']))
        .order_by(BillingSubscription.provider_updated_at.desc()).limit(1))
    if sub is None:
        problem('SUBSCRIPTION_NOT_FOUND', '没有可取消的订阅', 404)
    try:
        current = paddle.request('GET', '/subscriptions/' + sub.id)
        change = current.get('scheduled_change') or {}
        if current['status'] != 'canceled' and change.get('action') != 'cancel':
            paddle.request('POST', '/subscriptions/' + sub.id + '/cancel', {'effective_from': 'next_billing_period'})
        sync_subscription(sub.id)
    except paddle.PaddleError as exc:
        billing_error(exc)
    db.expire_all()
    return billing_status(db, user)


@router.post('/v1/billing/portal')
def portal(user: User = Depends(identity), db: Session = Depends(get_db)):
    sub = db.scalar(select(BillingSubscription).where(BillingSubscription.owner_id == user.id)
        .order_by(BillingSubscription.provider_updated_at.desc()).limit(1))
    if sub is None:
        problem('SUBSCRIPTION_NOT_FOUND', '没有可管理的订阅', 404)
    try:
        result = paddle.request('POST', '/customers/' + sub.customer_id + '/portal-sessions', {'subscription_ids': [sub.id]})
        return {'url': result['urls']['general']['overview']}
    except paddle.PaddleError as exc:
        billing_error(exc)


class CheckoutSessionRequest(RequestBody):
    token: Annotated[str, Field(min_length=40, max_length=100)]
    refresh: bool = False


@router.get('/v1/billing/checkout-config', include_in_schema=False)
def checkout_config():
    cfg = settings()
    if not cfg.paddle_enabled:
        problem('BILLING_DISABLED', '订阅暂未开放', 503)
    return {'client_token': cfg.paddle_client_token, 'environment': cfg.paddle_environment}


@router.post('/v1/billing/checkout-session', include_in_schema=False)
def checkout_session(body: CheckoutSessionRequest, db: Session = Depends(get_db)):
    row = db.scalar(select(BillingCheckout).where(BillingCheckout.token_hash == hashlib.sha256(body.token.encode()).hexdigest(),
        BillingCheckout.token_expires_at > now()))
    if row is None or not settings().paddle_enabled:
        problem('CHECKOUT_EXPIRED', '结账链接已过期，请从账户页重新打开', 404)
    if body.refresh:
        try:
            sync_owner(row.owner_id)
        except paddle.PaddleError:
            pass  # Status remains pending; the durable callback/reconciliation retries.
        db.expire_all()
    return {'transaction_id': row.transaction_id, 'trial': row.trial, 'status': row.status,
            'client_token': settings().paddle_client_token, 'environment': settings().paddle_environment}


@router.post('/webhooks/paddle', include_in_schema=False)
async def webhook(request: Request, tasks: BackgroundTasks, db: Session = Depends(get_db)):
    cfg = settings()
    if not cfg.paddle_enabled:
        return JSONResponse({'error': 'billing_disabled'}, status_code=503)
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 1024 * 1024:
            return JSONResponse({'error': 'payload_too_large'}, status_code=413)
        body.extend(chunk)
    if not paddle.valid_signature(bytes(body), request.headers.get('Paddle-Signature', ''), cfg.paddle_webhook_secret.get_secret_value()):
        return JSONResponse({'error': 'invalid_signature'}, status_code=401)
    try:
        value = json.loads(body)
        event_id, event_type, resource_id = value['event_id'], value['event_type'], value['data']['id']
        if (not isinstance(event_id, str) or not re.fullmatch(r'(evt|ntfsimevt)_[a-z0-9]{26}', event_id)
                or not isinstance(event_type, str) or not re.fullmatch(r'[a-z_]+\.[a-z_]+', event_type)
                or not isinstance(resource_id, str) or not re.fullmatch(r'[a-z]+_[a-z0-9]{26}', resource_id)):
            raise ValueError()
        occurred = timestamp(value['occurred_at'])
        if occurred is None:
            raise ValueError()
    except (ValueError, KeyError, TypeError, paddle.PaddleError):
        return JSONResponse({'error': 'invalid_event'}, status_code=400)
    if db.get(BillingEvent, event_id):
        return {'received': True, 'duplicate': True}
    # Simulator fixtures never change user entitlements, even in sandbox.
    simulation = event_id.startswith('ntfsimevt_')
    supported = event_type.startswith(('subscription.', 'transaction.'))
    row = BillingEvent(id=event_id, environment=cfg.paddle_environment, event_type=event_type,
        resource_id=resource_id, occurred_at=occurred, status='ignored' if simulation or not supported else 'pending',
        error_code='SIMULATION' if simulation else ('MANUAL_REVIEW_REQUIRED' if not supported else None))
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return {'received': True, 'duplicate': True}
    if row.status == 'pending':
        tasks.add_task(process_event, row.id)
    return {'received': True, 'simulation': simulation}


@router.get('/billing/checkout', include_in_schema=False)
def checkout_page():
    return FileResponse(Path(__file__).parent / 'billing_web' / 'index.html', headers={
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})


@router.get('/billing/checkout.js', include_in_schema=False)
def checkout_script():
    return FileResponse(Path(__file__).parent / 'billing_web' / 'checkout.js')
