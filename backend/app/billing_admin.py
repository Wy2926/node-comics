"""Administrative order search and its durable status transition timeline."""
from datetime import datetime, timezone
from typing import Literal
from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from .auth import admin
from .billing_catalog import price_json
from .billing_models import BillingCheckout, BillingEvent, BillingOrder, BillingOrderTransition, BillingPrice, BillingPlanRevision, BillingSubscription
from .db import get_db
from .errors import problem
from .models import User
from .request_models import RequestBody

router = APIRouter(prefix='/v1/admin/billing', dependencies=[Depends(admin)])
ORDER_FIELDS = ('id', 'owner_id', 'provider', 'environment', 'checkout_id', 'subscription_id',
    'price_id', 'binding_id', 'external_id', 'kind', 'status', 'currency', 'subtotal', 'total',
    'created_at', 'updated_at', 'paid_at', 'error_code')
EVENT_FIELDS = ('id', 'event_type', 'status', 'attempts', 'error_code', 'occurred_at',
    'received_at', 'processed_at', 'next_attempt_at')
EVENT_LIMIT = 100


class ReconcileRequest(RequestBody):
    session_id: str | None = Field(default=None, min_length=1, max_length=255, pattern=r'^[A-Za-z][A-Za-z0-9_]+$')


def order_json(order, owner, price, revision):
    return {**{key: getattr(order, key) for key in ORDER_FIELDS},
        'owner_name': owner.name, 'product_name': revision.name, 'interval': price.interval}


def order_query():
    return select(BillingOrder, User, BillingPrice, BillingPlanRevision).join(
        User, User.id == BillingOrder.owner_id).join(BillingPrice, BillingPrice.id == BillingOrder.price_id).join(
        BillingPlanRevision, BillingPlanRevision.id == BillingPrice.plan_revision_id)


def utc_naive(value):
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value and value.tzinfo else value


def order_events(db, order, checkout):
    resources = {value for value in (order.checkout_id, order.subscription_id, order.external_id,
        checkout.session_id if checkout else None) if value}
    resources |= {value.split(':', 2)[-1] for value in resources}
    referenced = select(BillingOrderTransition.event_id).where(
        BillingOrderTransition.order_id == order.id, BillingOrderTransition.event_id.is_not(None))
    matches = [BillingEvent.resource_id.in_(resources), BillingEvent.id.in_(referenced)]
    matches.extend(BillingEvent.payload[field].as_string().in_(resources)
        for field in ('checkout_id', 'subscription_id'))
    # Refund/dispute notifications can identify the payment in a sanitized
    # reference rather than in resource_id (which identifies the refund itself).
    if order.external_id:
        matches.extend(BillingEvent.payload[field].as_string() == order.external_id
            for field in ('transaction_id', 'invoice_id'))
    query = select(BillingEvent).where(BillingEvent.provider == order.provider,
        BillingEvent.environment == order.environment, or_(*matches))
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    events = db.scalars(query.order_by(BillingEvent.received_at.desc(), BillingEvent.id.desc()).limit(EVENT_LIMIT))
    return [{field: getattr(event, field) for field in EVENT_FIELDS} for event in events], total


@router.get('/orders')
def orders(provider: Literal['stripe', 'creem'] | None = None, status: str | None = Query(default=None, max_length=32),
        environment: Literal['test', 'live'] | None = None, owner_id: str | None = Query(default=None, max_length=36),
        q: str | None = Query(default=None, max_length=255), created_from: datetime | None = None,
        created_to: datetime | None = None, page: int = Query(default=1, ge=1),
        page_size: int = Query(default=30, ge=1, le=100), db: Session = Depends(get_db)):
    query = order_query()
    for column, value in ((BillingOrder.provider, provider), (BillingOrder.status, status),
            (BillingOrder.environment, environment), (BillingOrder.owner_id, owner_id)):
        if value is not None:
            query = query.where(column == value)
    start, end = utc_naive(created_from), utc_naive(created_to)
    if start and end and start > end:
        problem('DATE_RANGE_INVALID', '开始时间不能晚于结束时间', 422)
    if start:
        query = query.where(BillingOrder.created_at >= start)
    if end:
        query = query.where(BillingOrder.created_at <= end)
    if q and q.strip():
        # Treat typed percent/underscore characters as literal search text.
        escaped = q.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        query = query.where(or_(*[column.ilike(f'%{escaped}%', escape='\\') for column in (
            BillingOrder.id, BillingOrder.external_id, BillingOrder.checkout_id,
            BillingOrder.subscription_id, User.name, BillingOrder.owner_id)]))
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.execute(query.order_by(BillingOrder.created_at.desc(), BillingOrder.id.desc())
        .offset((page - 1) * page_size).limit(page_size))
    return {'items': [order_json(*row) for row in rows], 'total': total, 'page': page, 'page_size': page_size}


@router.get('/orders/{order_id}')
def order_detail(order_id: str, db: Session = Depends(get_db)):
    row = db.execute(order_query().where(BillingOrder.id == order_id)).first()
    if row is None:
        problem('NOT_FOUND', '订单不存在', 404)
    order, owner, price, revision = row
    checkout = db.get(BillingCheckout, order.checkout_id) if order.checkout_id else None
    subscription = db.get(BillingSubscription, order.subscription_id) if order.subscription_id else None
    transitions = db.scalars(select(BillingOrderTransition).where(BillingOrderTransition.order_id == order.id)
        .order_by(BillingOrderTransition.created_at, BillingOrderTransition.id))
    events, event_count = order_events(db, order, checkout)
    return {'order': order_json(order, owner, price, revision), 'price': price_json(db, price),
        'checkout': {key: getattr(checkout, key) for key in ('id', 'status', 'session_id', 'trial',
            'created_at', 'expires_at', 'error_code')} if checkout else None,
        'subscription': {key: getattr(subscription, key) for key in ('id', 'status', 'next_billed_at',
            'cancel_at', 'trial_starts_at', 'trial_ends_at', 'paid_starts_at', 'paid_ends_at')} if subscription else None,
        'events': events, 'events_total': event_count, 'events_limit': EVENT_LIMIT,
        'transitions': [{key: getattr(item, key) for key in ('id', 'source', 'event_id', 'from_status',
            'to_status', 'detail', 'created_at')} for item in transitions]}


@router.post('/orders/{order_id}/reconcile')
def reconcile_order(order_id: str, body: ReconcileRequest, db: Session = Depends(get_db)):
    from . import stripe_client as stripe, creem_client as creem
    from .billing_checkout import bind_session, sync_owner
    from .billing_providers import BillingError, require
    from .billing_sync import sync_session
    order = db.get(BillingOrder, order_id)
    if order is None:
        problem('NOT_FOUND', '订单不存在', 404)
    try:
        if body.session_id:
            require(order.kind == 'initial' and order.checkout_id, 'BILLING_CHECKOUT_UNBOUND')
            checkout = db.get(BillingCheckout, order.checkout_id)
            require(checkout is not None and checkout.owner_id == order.owner_id
                and checkout.provider == order.provider and checkout.environment == order.environment,
                'BILLING_ACCOUNT_UNBOUND')
            require(checkout.session_id in (None, body.session_id), 'BILLING_CHECKOUT_CONFLICT')
            if order.provider == 'stripe':
                remote = stripe.call('checkout.sessions', 'retrieve', body.session_id)
                stripe.environment(remote)
                require(stripe.intent_id(remote) == checkout.id and remote.get('client_reference_id') == checkout.id,
                    'BILLING_CHECKOUT_CONFLICT')
            else:
                remote = creem.call('GET', '/checkouts', params={'checkout_id': body.session_id})
                creem.environment(remote)
                require(creem.intent_id(remote) == checkout.id and remote.get('request_id') in (None, checkout.id),
                    'BILLING_CHECKOUT_CONFLICT')
            require(remote.get('id') == body.session_id, 'BILLING_CHECKOUT_CONFLICT')
            # Bind this exact order before the provider sync opens another
            # transaction, so its unique session key cannot switch owners.
            bind_session(checkout.id, remote)
            sync_session(body.session_id, provider=order.provider)
        else:
            sync_owner(order.owner_id)
    except BillingError as exc:
        problem(exc.code, '无法核实订单：请确认支付平台结账编号属于此订单，或稍后重试',
            503 if exc.uncertain else 409)
    db.expire_all()
    return {'order_id': order.id, 'status': db.get(BillingOrder, order_id).status}
