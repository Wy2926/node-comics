"""Authenticated Stripe handoff and durable, signature-verified webhook receipts."""
import re
import stripe as sdk
from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from . import stripe_client as stripe
from .auth import identity
from .billing_checkout import billing_status, start_checkout, sync_owner
from .billing_models import BillingAccount, BillingEvent
from .billing_sync import process_event
from .billing_grants import timestamp
from .request_models import RequestBody
from pydantic import Field
from .billing_catalog import offers
from .config import settings
from .db import get_db
from .entitlements import entitlements_json
from .errors import problem
from .models import User

router = APIRouter(tags=['billing'])


class CheckoutRequest(RequestBody):
    price_id: str = Field(min_length=1, max_length=36)
EVENTS = {'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed', 'customer.subscription.created', 'customer.subscription.updated',
    'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed',
    'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible'}


def billing_error(exc):
    messages = {'STRIPE_SUBSCRIPTION_EXISTS': '已有订阅，请通过 Stripe 管理当前订阅',
        'STRIPE_CHECKOUT_UNCERTAIN': '正在核实原结账结果，请稍后刷新',
        'STRIPE_CHECKOUT_COMPLETED': '结账已完成，请刷新会员权益',
        'STRIPE_CHECKOUT_PRICE_CONFLICT': '已有待核实结账，请继续原报价或等待原会话到期后重新选择',
        'STRIPE_PLAN_UNAVAILABLE': '此报价尚未发布或已停售，请刷新套餐列表',
        'STRIPE_CHECKOUT_EXPIRED': '结账链接已过期，请重新打开', 'BILLING_DISABLED': '订阅暂未开放'}
    problem(exc.code, messages.get(exc.code, '支付服务暂时不可用，请稍后重试'), 503 if exc.uncertain else 409)


@router.get('/v1/billing/status')
def status(user: User = Depends(identity), db: Session = Depends(get_db)):
    return billing_status(db, user)


@router.get('/v1/billing/catalog')
def public_catalog(db: Session = Depends(get_db)):
    enabled = settings().stripe_enabled
    return {'enabled': enabled, 'offers': offers(db) if enabled else []}


@router.post('/v1/billing/checkouts')
def checkout(body: CheckoutRequest, user: User = Depends(identity)):
    try:
        return start_checkout(user.id, body.price_id)
    except stripe.BillingError as exc:
        billing_error(exc)


@router.post('/v1/billing/sync')
def sync(user: User = Depends(identity), db: Session = Depends(get_db)):
    try:
        sync_owner(user.id)
    except stripe.BillingError as exc:
        billing_error(exc)
    db.expire_all()
    return {'billing': billing_status(db, user), 'entitlements': entitlements_json(db, user)}


@router.post('/v1/billing/portal')
def portal(user: User = Depends(identity), db: Session = Depends(get_db)):
    account = db.get(BillingAccount, user.id)
    if not account or not account.customer_id:
        problem('SUBSCRIPTION_NOT_FOUND', '没有可管理的订阅', 404)
    try:
        stripe.require(account.environment == settings().stripe_environment, 'STRIPE_ENVIRONMENT_MISMATCH')
        result = stripe.call('billing_portal.sessions', 'create', params={
            'customer': account.customer_id, 'return_url': settings().stripe_return_url,
            **({'configuration': settings().stripe_portal_configuration_id}
               if settings().stripe_portal_configuration_id else {})})
        return {'url': stripe.hosted_url(result['url'], portal=True)}
    except stripe.BillingError as exc:
        billing_error(exc)


@router.post('/webhooks/stripe', include_in_schema=False)
async def webhook(request: Request, tasks: BackgroundTasks, db: Session = Depends(get_db)):
    cfg = settings()
    if not cfg.stripe_enabled:
        return JSONResponse({'error': 'billing_disabled'}, status_code=503)
    body = bytearray()
    async for chunk in request.stream():
        if len(body)+len(chunk) > 1024*1024:
            return JSONResponse({'error': 'payload_too_large'}, status_code=413)
        body.extend(chunk)
    try:
        value = sdk.Webhook.construct_event(bytes(body), request.headers.get('Stripe-Signature', ''),
            cfg.stripe_webhook_secret.get_secret_value()).to_dict()
    except (ValueError, sdk.SignatureVerificationError):
        return JSONResponse({'error': 'invalid_signature'}, status_code=401)
    try:
        stripe.environment(value)
        event_id, kind, resource_id = value['id'], value['type'], value['data']['object']['id']
        if not re.fullmatch(r'evt_[A-Za-z0-9]{1,240}', event_id) or not isinstance(kind, str):
            raise ValueError()
        if kind not in EVENTS:
            return {'received': True}
        if not re.fullmatch(r'(cs_(test_|live_)?|sub_|in_)[A-Za-z0-9]{1,240}', resource_id):
            raise ValueError()
        occurred = timestamp(value['created'])
        if occurred is None:
            raise ValueError()
    except (KeyError, TypeError, ValueError, stripe.BillingError):
        return JSONResponse({'error': 'invalid_event'}, status_code=400)
    if not db.get(BillingEvent, event_id):
        db.add(BillingEvent(id=event_id, environment=cfg.stripe_environment, event_type=kind,
            resource_id=resource_id, occurred_at=occurred))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    tasks.add_task(process_event, event_id)
    return {'received': True}
