"""Authenticated multi-channel checkout and signature-verified durable webhooks."""
import hashlib
import hmac
import json
import re
from typing import Literal
import stripe as sdk
from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from . import stripe_client as stripe, creem_client as creem
from .auth import identity
from .billing_checkout import billing_status, start_checkout, sync_owner, customer_for
from .billing_models import BillingEvent
from .billing_providers import BillingError, require, provider_enabled, provider_environment, resource_key
from .billing_sync import process_event
from .billing_grants import timestamp
from .request_models import RequestBody
from pydantic import Field
from .billing_catalog import offers, products_json
from .config import settings
from .db import get_db
from .entitlements import entitlements_json
from .errors import problem
from .models import User

router = APIRouter(tags=['billing'])


class CheckoutRequest(RequestBody):
    price_id: str = Field(min_length=1, max_length=36)
    provider: Literal['stripe', 'creem']


class PortalRequest(RequestBody):
    provider: Literal['stripe', 'creem']


STRIPE_EVENTS = {'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed', 'customer.subscription.created', 'customer.subscription.updated',
    'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed',
    'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible',
    'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed', 'refund.updated', 'refund.created'}
CREEM_EVENTS = {'checkout.completed', 'subscription.active', 'subscription.paid', 'subscription.canceled',
    'subscription.expired', 'subscription.trialing', 'subscription.paused', 'subscription.update',
    'subscription.past_due', 'subscription.unpaid', 'subscription.scheduled_cancel', 'refund.created', 'dispute.created'}


def billing_error(exc):
    messages = {'BILLING_SUBSCRIPTION_EXISTS': '已有订阅，请管理当前订阅',
        'BILLING_CHECKOUT_UNCERTAIN': '正在核实原结账结果，请稍后刷新',
        'CREEM_CHECKOUT_UNCERTAIN': '原结账请求结果待核实，为避免重复订阅暂不创建新结账，请联系支持',
        'BILLING_CHECKOUT_COMPLETED': '结账已完成，请刷新会员权益',
        'BILLING_CHECKOUT_PRICE_CONFLICT': '已有待核实结账，请继续原价格与支付渠道',
        'BILLING_PLAN_UNAVAILABLE': '此价格尚未发布或已停售，请刷新套餐列表',
        'BILLING_CHANNEL_UNAVAILABLE': '此支付渠道暂不可用，请刷新套餐列表',
        'BILLING_CHECKOUT_EXPIRED': '结账链接已过期，请重新打开', 'BILLING_DISABLED': '订阅暂未开放'}
    problem(exc.code, messages.get(exc.code, '支付服务暂时不可用，请稍后重试'), 503 if exc.uncertain else 409)


@router.get('/v1/billing/status')
def status(user: User = Depends(identity), db: Session = Depends(get_db)):
    return billing_status(db, user)


@router.get('/v1/billing/catalog')
def public_catalog(db: Session = Depends(get_db)):
    enabled = any(provider_enabled(p) for p in ('stripe', 'creem'))
    return {'enabled': enabled, 'offers': offers(db) if enabled else [], 'products': products_json(db, public=True) if enabled else []}


@router.post('/v1/billing/checkouts')
def checkout(body: CheckoutRequest, user: User = Depends(identity)):
    try:
        return start_checkout(user.id, body.price_id, body.provider)
    except BillingError as exc:
        billing_error(exc)


@router.post('/v1/billing/sync')
def sync(user: User = Depends(identity), db: Session = Depends(get_db)):
    try:
        sync_owner(user.id)
    except BillingError as exc:
        billing_error(exc)
    db.expire_all()
    return {'billing': billing_status(db, user), 'entitlements': entitlements_json(db, user)}


@router.post('/v1/billing/portal')
def portal(body: PortalRequest, user: User = Depends(identity), db: Session = Depends(get_db)):
    account = customer_for(db, user.id, body.provider)
    if not account:
        problem('SUBSCRIPTION_NOT_FOUND', '没有可管理的订阅', 404)
    try:
        require(provider_enabled(body.provider), 'BILLING_DISABLED')
        if body.provider == 'creem':
            result = creem.call('POST', '/customers/billing', body={'customer_id': account.customer_id})
            return {'url': creem.hosted_url(result['customer_portal_link'], portal=True), 'provider': 'creem'}
        result = stripe.call('billing_portal.sessions', 'create', params={
            'customer': account.customer_id, 'return_url': settings().stripe_return_url,
            **({'configuration': settings().stripe_portal_configuration_id} if settings().stripe_portal_configuration_id else {})})
        return {'url': stripe.hosted_url(result['url'], portal=True), 'provider': 'stripe'}
    except BillingError as exc:
        billing_error(exc)


async def read_body(request):
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 1024 * 1024:
            return None
        body.extend(chunk)
    return bytes(body)


def store_event(db, tasks, provider, event_id, kind, resource_id, occurred, payload):
    key = resource_key(provider, event_id)
    if not db.get(BillingEvent, key):
        db.add(BillingEvent(id=key, provider=provider, environment=provider_environment(provider), event_type=kind,
            resource_id=resource_id, occurred_at=occurred, payload=payload))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    tasks.add_task(process_event, key)
    return {'received': True}


def event_references(obj):
    """Keep only validated correlation IDs, never customer or raw event fields."""
    metadata = obj.get('metadata')
    metadata = metadata if isinstance(metadata, dict) else {}
    parent = obj.get('parent')
    parent = parent if isinstance(parent, dict) else {}
    details = parent.get('subscription_details')
    details = details if isinstance(details, dict) else {}
    values = {'checkout_id': metadata.get('checkout_intent_id') if metadata.get('app') == 'node_comics' else None,
        'subscription_id': obj.get('subscription') or details.get('subscription'),
        'invoice_id': obj.get('invoice'), 'transaction_id': obj.get('transaction'),
        'charge_id': obj.get('charge') or (obj.get('id') if obj.get('object') == 'charge' else None)}
    references = {}
    for key, value in values.items():
        if isinstance(value, dict):
            value = value.get('id')
        if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,254}', value):
            references[key] = value
    return references


@router.post('/webhooks/stripe', include_in_schema=False)
async def stripe_webhook(request: Request, tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if not provider_enabled('stripe'):
        return JSONResponse({'error': 'billing_disabled'}, status_code=503)
    body = await read_body(request)
    if body is None:
        return JSONResponse({'error': 'payload_too_large'}, status_code=413)
    try:
        value = sdk.Webhook.construct_event(body, request.headers.get('Stripe-Signature', ''),
            settings().stripe_webhook_secret.get_secret_value()).to_dict()
    except (ValueError, TypeError, AttributeError, sdk.SignatureVerificationError):
        return JSONResponse({'error': 'invalid_signature'}, status_code=401)
    try:
        require(isinstance(value, dict))
        stripe.environment(value)
        require(isinstance(value.get('data'), dict) and isinstance(value['data'].get('object'), dict))
        event_id, kind, obj = value['id'], value['type'], value['data']['object']
        resource_id = obj['id']
        require(re.fullmatch(r'evt_[A-Za-z0-9]{1,240}', event_id) and isinstance(kind, str))
        if kind not in STRIPE_EVENTS:
            return {'received': True}
        require(re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{1,254}', resource_id))
        occurred = timestamp(value['created'])
        require(occurred)
        payload = event_references(obj)
    except (KeyError, TypeError, ValueError, BillingError):
        return JSONResponse({'error': 'invalid_event'}, status_code=400)
    return store_event(db, tasks, 'stripe', event_id, kind, resource_id, occurred, payload)


@router.post('/webhooks/creem', include_in_schema=False)
async def creem_webhook(request: Request, tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if not provider_enabled('creem'):
        return JSONResponse({'error': 'billing_disabled'}, status_code=503)
    body = await read_body(request)
    if body is None:
        return JSONResponse({'error': 'payload_too_large'}, status_code=413)
    expected = hmac.new(settings().creem_webhook_secret.get_secret_value().encode(), body, hashlib.sha256).hexdigest()
    signature = request.headers.get('creem-signature', '')
    if not re.fullmatch(r'[a-fA-F0-9]{64}', signature) or not hmac.compare_digest(expected, signature.lower()):
        return JSONResponse({'error': 'invalid_signature'}, status_code=401)
    try:
        value = json.loads(body)
        require(isinstance(value, dict) and isinstance(value.get('object'), dict))
        event_id, kind, obj = value['id'], value['eventType'], value['object']
        require(re.fullmatch(r'evt_[A-Za-z0-9]{1,240}', event_id) and isinstance(kind, str))
        if kind not in CREEM_EVENTS:
            return {'received': True}
        creem.environment(obj)
        resource_id = obj['id']
        require(re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{1,254}', resource_id))
        occurred = creem.timestamp(value['created_at'])
        require(occurred)
        payload = event_references(obj)
    except (KeyError, TypeError, ValueError, BillingError):
        return JSONResponse({'error': 'invalid_event'}, status_code=400)
    return store_event(db, tasks, 'creem', event_id, kind, resource_id, occurred, payload)
