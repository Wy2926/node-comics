"""Administrative order search and its durable status transition timeline."""
from datetime import datetime, timezone, timedelta
from typing import Literal
from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session
from .auth import admin
from .billing_catalog import price_json
from .billing_models import BillingAccount, BillingCustomer, BillingInvoice, BillingTerm, BillingRefund, BillingDispute, BillingCheckout, BillingEvent, BillingOrder, BillingOrderTransition, BillingPrice, BillingPlanRevision, BillingSubscription
from .db import get_db
from .errors import problem
from .models import User, now
from .admin_audit import record_audit, find_audit_operation
from .entitlement_models import QuotaPeriod
from .billing_reversals import reversal_json
from .request_models import RequestBody

router = APIRouter(prefix='/v1/admin/billing', dependencies=[Depends(admin)])
ORDER_FIELDS = ('id', 'owner_id', 'provider', 'environment', 'checkout_id', 'subscription_id',
    'price_id', 'binding_id', 'external_id', 'kind', 'status', 'currency', 'subtotal', 'total',
    'created_at', 'updated_at', 'paid_at', 'error_code', 'refunded_total')
EVENT_FIELDS = ('id', 'event_type', 'status', 'attempts', 'error_code', 'occurred_at',
    'received_at', 'processed_at', 'next_attempt_at', 'last_retry_at')
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
    refunds = list(db.scalars(select(BillingRefund).where(BillingRefund.order_id == order.id)
        .order_by(BillingRefund.occurred_at, BillingRefund.id)))
    disputes = list(db.scalars(select(BillingDispute).where(BillingDispute.order_id == order.id)
        .order_by(BillingDispute.occurred_at, BillingDispute.id)))
    successful = [item for item in refunds if item.status == 'succeeded']
    known_total = sum(item.amount for item in successful if item.amount is not None and item.currency == order.currency)
    complete = (all(item.amount is not None and item.currency == order.currency and item.status != 'unknown' for item in refunds)
        and order.refunded_total is not None and order.refunded_total == known_total)
    return {'order': order_json(order, owner, price, revision), 'price': price_json(db, price),
        'checkout': {key: getattr(checkout, key) for key in ('id', 'status', 'session_id', 'trial',
            'created_at', 'expires_at', 'error_code')} if checkout else None,
        'subscription': {key: getattr(subscription, key) for key in ('id', 'status', 'next_billed_at',
            'cancel_at', 'trial_starts_at', 'trial_ends_at', 'paid_starts_at', 'paid_ends_at')} if subscription else None,
        'events': events, 'events_total': event_count, 'events_limit': EVENT_LIMIT,
        'refunds': [reversal_json(item) for item in refunds], 'disputes': [reversal_json(item) for item in disputes],
        'refund_summary': {'reported_total': order.refunded_total, 'recorded_succeeded_total': known_total,
            'currency': order.currency, 'details_complete': complete},
        'transitions': [{key: getattr(item, key) for key in ('id', 'source', 'event_id', 'from_status',
            'to_status', 'detail', 'created_at')} for item in transitions]}


@router.post('/orders/{order_id}/reconcile')
def reconcile_order(order_id: str, body: ReconcileRequest, db: Session = Depends(get_db), actor: User = Depends(admin)):
    from . import stripe_client as stripe, creem_client as creem
    from .billing_checkout import bind_session
    from .billing_providers import BillingError, require, provider_environment
    from .billing_sync import sync_session, sync_subscription
    order = db.get(BillingOrder, order_id)
    if order is None:
        problem('NOT_FOUND', '订单不存在', 404)
    before = {'status': order.status}
    actor_id = actor.id
    try:
        require(order.environment == provider_environment(order.provider), 'BILLING_ENVIRONMENT_MISMATCH')
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
            # A historical order must never drift to the owner's latest checkout.
            if order.subscription_id:
                subscription = db.get(BillingSubscription, order.subscription_id)
                require(subscription is not None and subscription.owner_id == order.owner_id
                    and subscription.provider == order.provider and subscription.environment == order.environment
                    and subscription.binding_id == order.binding_id, 'BILLING_ACCOUNT_UNBOUND')
                sync_subscription(subscription.id, order.external_id, provider=order.provider)
            else:
                checkout = db.get(BillingCheckout, order.checkout_id) if order.checkout_id else None
                require(checkout is not None and checkout.owner_id == order.owner_id
                    and checkout.provider == order.provider and checkout.environment == order.environment
                    and checkout.binding_id == order.binding_id, 'BILLING_ACCOUNT_UNBOUND')
                require(checkout.session_id, 'BILLING_CHECKOUT_UNBOUND')
                sync_session(checkout.session_id, provider=order.provider)
        db.refresh(order)
        if order.provider == 'stripe' and order.external_id:
            from .stripe_refunds import sync_invoice_reversals
            sync_invoice_reversals(order.external_id)
    except BillingError as exc:
        db.rollback()
        record_audit(db, actor_id, 'billing.order.reconcile_failed', 'billing_order', order_id,
            before=before, details={'error_code': exc.code})
        db.commit()
        problem(exc.code, '无法核实订单：请确认支付平台结账编号属于此订单，或稍后重试',
            503 if exc.uncertain else 409)
    db.expire_all()
    status = db.get(BillingOrder, order_id).status
    record_audit(db, actor_id, 'billing.order.reconcile', 'billing_order', order_id,
        before=before, after={'status': status}, details={'session_id': body.session_id})
    db.commit()
    return {'order_id': order_id, 'status': status}


def fields(row, names):
    return {name: getattr(row, name) for name in names}


def search_text(query, value, columns):
    if value and value.strip():
        escaped = value.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        return query.where(or_(*[column.ilike(f'%{escaped}%', escape='\\') for column in columns]))
    return query


def paged(db, query, page, page_size, serializer):
    total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0
    return {'items': [serializer(row) for row in db.execute(query.offset((page - 1) * page_size).limit(page_size))],
        'total': total, 'page': page, 'page_size': page_size}


def event_json(event):
    return fields(event, (*EVENT_FIELDS, 'provider', 'environment', 'resource_id'))


@router.get('/events')
def events(provider: Literal['stripe', 'creem'] | None = None, environment: Literal['test', 'live'] | None = None,
        status: Literal['pending', 'processing', 'processed'] | None = None, error_only: bool = False,
        event_type: str | None = Query(None, max_length=80), q: str | None = Query(None, max_length=320),
        received_from: datetime | None = None, received_to: datetime | None = None,
        page: int = Query(1, ge=1), page_size: int = Query(30, ge=1, le=100), db: Session = Depends(get_db)):
    query = select(BillingEvent)
    for column, value in ((BillingEvent.provider, provider), (BillingEvent.environment, environment),
            (BillingEvent.status, status), (BillingEvent.event_type, event_type)):
        if value is not None:
            query = query.where(column == value)
    start, end = utc_naive(received_from), utc_naive(received_to)
    if start and end and start > end:
        problem('DATE_RANGE_INVALID', '开始时间不能晚于结束时间', 422)
    if start:
        query = query.where(BillingEvent.received_at >= start)
    if end:
        query = query.where(BillingEvent.received_at <= end)
    if error_only:
        query = query.where(BillingEvent.error_code.is_not(None))
    query = search_text(query, q, (BillingEvent.id, BillingEvent.resource_id, BillingEvent.error_code))
    return paged(db, query.order_by(BillingEvent.received_at.desc(), BillingEvent.id.desc()), page, page_size,
        lambda row: event_json(row[0]))


def safe_event_references(event):
    import re
    return {key: value for key, value in event.payload.items() if key in (
        'checkout_id', 'subscription_id', 'invoice_id', 'transaction_id', 'charge_id', 'refund_id', 'dispute_id')
        and isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,254}', value)}


@router.get('/events/{event_id}')
def event_detail(event_id: str, db: Session = Depends(get_db)):
    event = db.get(BillingEvent, event_id)
    if event is None:
        problem('NOT_FOUND', '支付事件不存在', 404)
    refs = safe_event_references(event)
    resources = {event.resource_id, *refs.values()}
    resources |= {f'{event.provider}:{event.environment}:{value}' for value in list(resources)}
    linked = select(BillingOrderTransition.order_id).where(BillingOrderTransition.event_id == event.id)
    checkouts = select(BillingCheckout.id).where(BillingCheckout.session_id.in_(resources),
        BillingCheckout.provider == event.provider, BillingCheckout.environment == event.environment)
    query = select(BillingOrder).where(BillingOrder.provider == event.provider,
        BillingOrder.environment == event.environment, or_(BillingOrder.id.in_(linked),
            BillingOrder.external_id.in_(resources), BillingOrder.subscription_id.in_(resources),
            BillingOrder.checkout_id.in_(resources), BillingOrder.checkout_id.in_(checkouts)))
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    return {'event': event_json(event), 'references': refs,
        'orders': [fields(item, ('id', 'status', 'external_id', 'owner_id'))
            for item in db.scalars(query.order_by(BillingOrder.created_at.desc()).limit(100))], 'orders_total': total}


class RetryEventRequest(RequestBody):
    operation_key: str = Field(min_length=8, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    expected_attempts: int = Field(ge=0)
    note: str = Field(min_length=1, max_length=500)


@router.post('/events/{event_id}/retry')
def retry_event(event_id: str, body: RetryEventRequest, actor: User = Depends(admin), db: Session = Depends(get_db)):
    from .billing_providers import provider_enabled, provider_environment
    if not body.note.strip():
        problem('NOTE_REQUIRED', '请填写重试原因', 422)
    # Obtain a writer lock on SQLite and row lock on PostgreSQL before checking the lease.
    if db.get_bind().dialect.name == 'sqlite':
        db.execute(update(BillingEvent).where(BillingEvent.id == event_id).values(status=BillingEvent.status))
    event = db.scalar(select(BillingEvent).where(BillingEvent.id == event_id).with_for_update())
    if event is None:
        problem('NOT_FOUND', '支付事件不存在', 404)
    receipt = find_audit_operation(db, actor.id, 'billing.event.retry', 'billing_event', event.id, body.operation_key)
    if receipt:
        if receipt.details.get('request') != body.model_dump():
            problem('BILLING_OPERATION_CONFLICT', '此操作编号已用于不同的重试请求，请核实原回执', 409)
        return {'event_id': event.id, 'status': event.status, 'queued': event.status == 'pending'}
    if event.last_retry_key == body.operation_key:
        problem('BILLING_OPERATION_CONFLICT', '操作编号已被其他管理员使用', 409)
    if not provider_enabled(event.provider) or event.environment != provider_environment(event.provider):
        problem('BILLING_CHANNEL_UNAVAILABLE', '请先启用事件对应环境的支付渠道', 409)
    if event.attempts != body.expected_attempts:
        problem('BILLING_EVENT_CHANGED', '事件已更新，请刷新后再操作', 409)
    at = now()
    if event.status == 'processed' or event.status == 'processing' and event.next_attempt_at > at:
        problem('BILLING_EVENT_NOT_RETRYABLE', '事件已处理或仍在处理，不能重复入队', 409)
    if event.last_retry_at and event.last_retry_at > at - timedelta(minutes=1):
        problem('BILLING_EVENT_RETRY_COOLDOWN', '一分钟内只能手动重试一次', 409)
    before = event_json(event)
    event.status, event.next_attempt_at = 'pending', at
    event.last_retry_key, event.last_retry_at = body.operation_key, at
    record_audit(db, actor.id, 'billing.event.retry', 'billing_event', event.id, before=before,
        after=event_json(event), details={'request': body.model_dump()}, note=body.note.strip(), operation_key=body.operation_key)
    db.commit()
    return {'event_id': event.id, 'status': event.status, 'queued': True}


SUBSCRIPTION_FIELDS = ('id', 'owner_id', 'provider', 'environment', 'checkout_id', 'customer_id',
    'price_id', 'binding_id', 'status', 'trial_starts_at', 'trial_ends_at', 'paid_starts_at', 'paid_ends_at',
    'next_billed_at', 'cancel_at', 'synced_at')


@router.get('/subscriptions')
def subscriptions(provider: Literal['stripe', 'creem'] | None = None, environment: Literal['test', 'live'] | None = None,
        owner_id: str | None = Query(None, max_length=36), status: str | None = Query(None, max_length=24),
        q: str | None = Query(None, max_length=320), page: int = Query(1, ge=1),
        page_size: int = Query(30, ge=1, le=100), db: Session = Depends(get_db)):
    query = select(BillingSubscription, User.name).join(User, User.id == BillingSubscription.owner_id)
    for column, value in ((BillingSubscription.provider, provider), (BillingSubscription.environment, environment),
            (BillingSubscription.owner_id, owner_id), (BillingSubscription.status, status)):
        if value is not None:
            query = query.where(column == value)
    query = search_text(query, q, (BillingSubscription.id, BillingSubscription.customer_id, BillingSubscription.owner_id, User.name))
    return paged(db, query.order_by(BillingSubscription.synced_at.desc(), BillingSubscription.id.desc()), page,
        page_size, lambda row: {**fields(row[0], SUBSCRIPTION_FIELDS), 'owner_name': row[1]})


def subscription_required(db, subscription_id):
    row = db.get(BillingSubscription, subscription_id)
    if row is None:
        problem('NOT_FOUND', '订阅不存在', 404)
    return row


@router.get('/subscriptions/{subscription_id}')
def subscription_detail(subscription_id: str, db: Session = Depends(get_db)):
    sub = subscription_required(db, subscription_id)
    account = db.get(BillingAccount, sub.owner_id)
    checkout = db.get(BillingCheckout, sub.checkout_id)
    return {'subscription': {**fields(sub, SUBSCRIPTION_FIELDS), 'owner_name': db.get(User, sub.owner_id).name},
        'price': price_json(db, db.get(BillingPrice, sub.price_id)),
        'trial_used_at': account.trial_used_at if account else None,
        'checkout': fields(checkout, ('id', 'session_id', 'trial', 'status', 'created_at', 'last_checked_at', 'error_code'))}


@router.get('/subscriptions/{subscription_id}/invoices')
def subscription_invoices(subscription_id: str, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
        db: Session = Depends(get_db)):
    subscription_required(db, subscription_id)
    query = select(BillingInvoice).where(BillingInvoice.subscription_id == subscription_id)
    return paged(db, query.order_by(BillingInvoice.processed_at.desc(), BillingInvoice.id.desc()), page, page_size,
        lambda row: fields(row[0], ('id', 'subscription_id', 'currency', 'total', 'processed_at')))


@router.get('/subscriptions/{subscription_id}/terms')
def subscription_terms(subscription_id: str, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
        db: Session = Depends(get_db)):
    subscription_required(db, subscription_id)
    query = select(BillingTerm).where(BillingTerm.subscription_id == subscription_id)
    result = paged(db, query.order_by(BillingTerm.starts_at.desc(), BillingTerm.id.desc()), page, page_size,
        lambda row: fields(row[0], ('id', 'owner_id', 'price_id', 'invoice_id', 'kind', 'starts_at', 'ends_at', 'revoked_at')))
    ids = [item['id'] for item in result['items']]
    buckets = list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.billing_term_id.in_(ids)).order_by(QuotaPeriod.starts_at)))
    for item in result['items']:
        item['quota_periods'] = [fields(bucket, ('id', 'billing_term_id', 'mode', 'starts_at', 'ends_at', 'granted', 'used', 'reserved'))
            for bucket in buckets if bucket.billing_term_id == item['id']]
    return result


@router.get('/customers')
def customers(provider: Literal['stripe', 'creem'] | None = None, environment: Literal['test', 'live'] | None = None,
        owner_id: str | None = Query(None, max_length=36), q: str | None = Query(None, max_length=255),
        page: int = Query(1, ge=1), page_size: int = Query(30, ge=1, le=100), db: Session = Depends(get_db)):
    query = select(BillingCustomer, User.name, BillingAccount.trial_used_at).join(User, User.id == BillingCustomer.owner_id
        ).outerjoin(BillingAccount, BillingAccount.owner_id == BillingCustomer.owner_id)
    for column, value in ((BillingCustomer.provider, provider), (BillingCustomer.environment, environment), (BillingCustomer.owner_id, owner_id)):
        if value is not None:
            query = query.where(column == value)
    query = search_text(query, q, (BillingCustomer.customer_id, BillingCustomer.owner_id, User.name))
    return paged(db, query.order_by(BillingCustomer.created_at.desc(), BillingCustomer.id.desc()), page, page_size,
        lambda row: {**fields(row[0], ('id', 'owner_id', 'provider', 'environment', 'customer_id', 'created_at')),
            'owner_name': row[1], 'trial_used_at': row[2]})


@router.get('/accounts/{owner_id}')
def account_detail(owner_id: str, db: Session = Depends(get_db)):
    from .billing_checkout import pending_checkout_condition
    owner = db.get(User, owner_id)
    if owner is None:
        problem('NOT_FOUND', '用户不存在', 404)
    account = db.get(BillingAccount, owner_id)
    reserved = list(db.scalars(select(BillingCheckout).where(BillingCheckout.owner_id == owner_id,
        BillingCheckout.trial.is_(True), pending_checkout_condition()).order_by(BillingCheckout.created_at.desc())))
    return {'owner_id': owner_id, 'owner_name': owner.name, 'trial_used_at': account.trial_used_at if account else None,
        'trial_reserved': [fields(row, ('id', 'provider', 'environment', 'status', 'created_at', 'expires_at')) for row in reserved],
        'trial_available': not (account and account.trial_used_at) and not reserved}
