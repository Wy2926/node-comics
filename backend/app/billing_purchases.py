"""One-off page purchases. Payment receipts, quota and audit commit together."""
from datetime import timedelta
from sqlalchemy import literal_column, select
from . import stripe_client as stripe, creem_client as creem
from .billing_models import BillingCheckout, BillingCustomer, BillingEvent, BillingOrder, BillingPlanRevision, BillingPrice, BillingPriceBinding
from .billing_orders import checkout_order, transition
from .billing_providers import require, provider_environment, stripe_quote
from .billing_grants import timestamp
from .db import session_factory
from .entitlement_models import QuotaPeriod
from .entitlements import locked_user
from .models import Ledger, now
from .providers import digest

REVERSED = ('refunded', 'disputed')


def revoke_purchase(db, order):
    # Preserve the original amount, reservations and dates for in-flight settlement.
    for bucket in db.scalars(select(QuotaPeriod).where(QuotaPeriod.billing_order_id == order.id)):
        bucket.revoked_at = bucket.revoked_at or now()


def purchase_order(db, row, external_id, total, state, paid_at, event_id=None):
    order = checkout_order(db, row)
    require(order.external_id in (None, external_id), 'BILLING_PURCHASE_CONFLICT')
    other = db.scalar(select(BillingOrder.id).where(BillingOrder.provider == row.provider,
        BillingOrder.environment == row.environment, BillingOrder.external_id == external_id,
        BillingOrder.id != order.id))
    require(other is None, 'BILLING_PURCHASE_CONFLICT')
    order.external_id, order.total = external_id, total
    if paid_at:
        require(row.created_at - timedelta(minutes=5) <= paid_at <= now() + timedelta(minutes=5),
            'BILLING_PAYMENT_TIME_INVALID')
        require(order.paid_at in (None, paid_at), 'BILLING_PAYMENT_TIME_CONFLICT')
        order.paid_at = paid_at
    if order.status not in REVERSED and not (order.status == 'partially_refunded' and state == 'paid'):
        transition(db, order, state, 'purchase_sync', event_id,
            {'payment_time_verified': paid_at is not None})
        # Creem does not expose a settlement timestamp on its transaction API.
        # Never label our observation time as the time the customer paid.
        if paid_at is None:
            order.paid_at = None
    return order


def grant_purchase(db, row, order, paid_at):
    price = db.get(BillingPrice, row.price_id)
    revision = db.get(BillingPlanRevision, price.plan_revision_id)
    require(price.interval == 'once' and not row.trial and revision.quota_pages > 0
        and revision.service_plan_id and not revision.trial_days and not revision.trial_classic_pages
        and revision.monthly_classic_pages == 0, 'BILLING_PURCHASE_INVALID')
    key = 'purchase:' + order.id + ':classic'
    bucket = db.get(QuotaPeriod, digest([row.owner_id, key]))
    if order.status in REVERSED:
        revoke_purchase(db, order)
        return
    if bucket:
        require(bucket.billing_order_id == order.id and bucket.owner_id == row.owner_id,
            'BILLING_PURCHASE_CONFLICT')
        return
    require(order.status in ('paid', 'partially_refunded'), 'BILLING_PURCHASE_UNPAID')
    require(paid_at is not None or revision.quota_validity_days is None, 'BILLING_PAYMENT_TIME_PENDING')
    start = paid_at or now()
    bucket = QuotaPeriod(id=digest([row.owner_id, key]), owner_id=row.owner_id, billing_order_id=order.id,
        kind='classic_purchase', mode='classic', source='purchase', source_key=key,
        starts_at=start, ends_at=start + timedelta(days=revision.quota_validity_days) if revision.quota_validity_days else None,
        granted=revision.quota_pages, used=0, reserved=0, grants_access=False, note=revision.name)
    db.add(bucket)
    db.flush()
    db.add(Ledger(owner_id=row.owner_id, period_id=bucket.id, quota_kind=bucket.kind,
        transaction_key=key, kind='purchase', amount=revision.quota_pages, note=revision.name))


def bind_customer(db, row, customer_id):
    require(isinstance(customer_id, str) and customer_id, 'BILLING_CUSTOMER_MISMATCH')
    require(row.customer_id in (None, customer_id), 'BILLING_CUSTOMER_MISMATCH')
    # Independent one-time checkouts may create different provider customers.
    # Bind this paid chain only; never claim the subscription's canonical customer.
    if row.customer_id is None:
        owner = db.scalar(select(BillingCustomer.owner_id).where(BillingCustomer.provider == row.provider,
            BillingCustomer.environment == row.environment, BillingCustomer.customer_id == customer_id))
        require(owner in (None, row.owner_id), 'BILLING_CUSTOMER_MISMATCH')
    row.customer_id = customer_id


def sync_stripe_purchase(checkout_id):
    with session_factory()() as db:
        row = db.get(BillingCheckout, checkout_id)
        require(row and row.provider == 'stripe', 'BILLING_ACCOUNT_UNBOUND')
        locked_user(db, row.owner_id)
        db.refresh(row)
        price, binding = db.get(BillingPrice, row.price_id), db.get(BillingPriceBinding, row.binding_id)
        require(price.interval == 'once' and row.environment == provider_environment('stripe'))
        session = stripe.call('checkout.sessions', 'retrieve', row.session_id)
        stripe.environment(session)
        require(session.get('id') == row.session_id and session.get('mode') == 'payment'
            and stripe.intent_id(session) == row.id and session.get('client_reference_id') == row.id
            and not session.get('subscription'), 'BILLING_PURCHASE_CONFLICT')
        if session.get('status') != 'complete' or session.get('payment_status') != 'paid':
            return
        bind_customer(db, row, session.get('customer'))
        lines = stripe.call('checkout.sessions.line_items', 'list', row.session_id, params={'limit': 2})
        require(not lines.get('has_more') and len(lines.get('data', [])) == 1, 'STRIPE_PLAN_MISMATCH')
        line = lines['data'][0]
        require(line.get('quantity') == 1, 'STRIPE_PLAN_MISMATCH')
        stripe.approved_price(line.get('price') or {}, stripe_quote(binding, price))
        require(session.get('currency') == price.currency and session.get('amount_subtotal') == price.unit_amount
            and (session.get('total_details') or {}).get('amount_discount', 0) == 0, 'STRIPE_PURCHASE_AMOUNT_MISMATCH')
        payment_id = session.get('payment_intent')
        require(isinstance(payment_id, str), 'STRIPE_PURCHASE_UNPAID')
        payment = stripe.call('payment_intents', 'retrieve', payment_id)
        stripe.environment(payment)
        total = session.get('amount_total')
        require(payment.get('id') == payment_id and stripe.intent_id(payment) == row.id
            and payment.get('status') == 'succeeded' and payment.get('customer') == row.customer_id
            and payment.get('capture_method') == 'automatic'
            and payment.get('currency') == price.currency and type(total) is int and total >= price.unit_amount
            and payment.get('amount') == total and payment.get('amount_received') == total,
            'STRIPE_PURCHASE_UNPAID')
        charge_id = payment.get('latest_charge')
        require(isinstance(charge_id, str), 'STRIPE_PURCHASE_UNPAID')
        charge = stripe.call('charges', 'retrieve', charge_id)
        stripe.environment(charge)
        require(charge.get('id') == charge_id and charge.get('payment_intent') == payment_id
            and charge.get('customer') == row.customer_id and charge.get('currency') == price.currency
            and charge.get('amount') == total and charge.get('amount_captured') == total
            and charge.get('paid') is True and charge.get('captured') is True
            and charge.get('status') == 'succeeded', 'STRIPE_PURCHASE_UNPAID')
        refunded = charge.get('amount_refunded', 0)
        require(type(refunded) is int and 0 <= refunded <= total, 'STRIPE_REFUND_INVALID')
        state = ('disputed' if charge.get('disputed') else 'refunded' if charge.get('refunded') or refunded == total
            else 'partially_refunded' if refunded else 'paid')
        paid_at = timestamp(charge.get('created'))
        require(paid_at is not None, 'BILLING_PAYMENT_TIME_PENDING')
        order = purchase_order(db, row, payment_id, total, state, paid_at)
        order.refunded_total = max(order.refunded_total or 0, refunded)
        from .stripe_refunds import record_charge_reversals, has_formal_dispute
        recorded_total = record_charge_reversals(db, order, charge_id)
        order.refunded_total = max(order.refunded_total, recorded_total)
        if has_formal_dispute(db, order):
            transition(db, order, 'disputed', 'purchase_reversal')
        elif recorded_total and order.status not in REVERSED:
            transition(db, order, 'refunded' if recorded_total >= total else 'partially_refunded', 'purchase_reversal')
        grant_purchase(db, row, order, paid_at)
        row.status, row.error_code, row.last_checked_at = 'completed', None, now()
        db.commit()


def creem_purchase_events(db, transaction_id):
    return select(BillingEvent).where(BillingEvent.provider == 'creem',
        BillingEvent.environment == provider_environment('creem'),
        BillingEvent.payload.op('->>')(literal_column("'transaction_id'")) == transaction_id)


def apply_creem_reversals(db, order):
    from .billing_reversals import record_reversal
    # A signed reversal can precede the checkout callback or a current API read.
    # Exact transaction lookup uses the payment-event correlation index.
    events = db.scalars(creem_purchase_events(db, order.external_id).where(
        BillingEvent.event_type.in_(['refund.created', 'dispute.created'])).order_by(BillingEvent.occurred_at))
    for event in events:
        snapshot = event.payload.get('reversal') or {}
        record_reversal(db, order, event.event_type.split('.')[0], event.resource_id,
            amount=snapshot.get('amount'), currency=snapshot.get('currency'), status=snapshot.get('status') or 'unknown',
            occurred_at=event.occurred_at, observed_at=event.occurred_at, event_id=event.id)
        if event.event_type == 'dispute.created':
            transition(db, order, 'disputed', 'purchase_reversal', event.id)
    db.flush()
    from sqlalchemy import func
    from .billing_models import BillingRefund
    total = db.scalar(select(func.coalesce(func.sum(BillingRefund.amount), 0)).where(
        BillingRefund.order_id == order.id, BillingRefund.status == 'succeeded', BillingRefund.currency == order.currency))
    order.refunded_total = max(order.refunded_total or 0, total)
    if order.status not in REVERSED and total:
        transition(db, order, 'refunded' if total >= order.total else 'partially_refunded', 'purchase_reversal')


def sync_creem_purchase(checkout_id):
    with session_factory()() as db:
        row = db.get(BillingCheckout, checkout_id)
        require(row and row.provider == 'creem', 'BILLING_ACCOUNT_UNBOUND')
        locked_user(db, row.owner_id)
        db.refresh(row)
        price, binding = db.get(BillingPrice, row.price_id), db.get(BillingPriceBinding, row.binding_id)
        require(price.interval == 'once' and row.environment == provider_environment('creem'))
        session = creem.call('GET', '/checkouts', params={'checkout_id': row.session_id})
        creem.environment(session)
        require(session.get('id') == row.session_id and creem.intent_id(session) == row.id
            and session.get('request_id') in (None, row.id) and session.get('units', 1) == 1
            and creem.object_id(session.get('product')) == binding.product_id and not session.get('subscription'),
            'BILLING_PURCHASE_CONFLICT')
        if session.get('status') != 'completed':
            return
        bind_customer(db, row, creem.object_id(session.get('customer')))
        remote_order = session.get('order')
        require(isinstance(remote_order, dict), 'CREEM_PURCHASE_UNPAID')
        creem.environment(remote_order)
        require(creem.object_id(remote_order.get('customer')) == row.customer_id
            and creem.object_id(remote_order.get('product')) == binding.product_id
            and str(remote_order.get('currency', '')).lower() == price.currency
            and remote_order.get('amount') == price.unit_amount and not remote_order.get('discount_amount'),
            'CREEM_PURCHASE_MISMATCH')
        transaction_id = creem.object_id(remote_order.get('transaction'))
        require(isinstance(transaction_id, str), 'CREEM_PURCHASE_UNPAID')
        value = creem.call('GET', '/transactions', params={'transaction_id': transaction_id})
        creem.environment(value)
        total = value.get('amount_paid')
        require(value.get('id') == transaction_id and value.get('type') == 'payment' and not value.get('subscription')
            and creem.object_id(value.get('order')) == remote_order.get('id')
            and creem.object_id(value.get('customer')) == row.customer_id
            and str(value.get('currency', '')).lower() == price.currency and value.get('amount') == price.unit_amount
            and type(total) is int and total >= price.unit_amount and not value.get('discount_amount'),
            'CREEM_PURCHASE_MISMATCH')
        state = {'paid': 'paid', 'refunded': 'refunded', 'partialRefund': 'partially_refunded',
            'chargedBack': 'disputed'}.get(value.get('status'))
        require(state is not None, 'CREEM_PURCHASE_UNPAID')
        paid_at = db.scalar(select(BillingEvent.occurred_at).where(BillingEvent.provider == 'creem',
            BillingEvent.environment == row.environment, BillingEvent.resource_id == row.session_id,
            BillingEvent.event_type == 'checkout.completed').order_by(BillingEvent.occurred_at).limit(1))
        revision = db.get(BillingPlanRevision, price.plan_revision_id)
        waiting = paid_at is None and revision.quota_validity_days is not None
        order = purchase_order(db, row, transaction_id, total, 'processing' if waiting and state == 'paid' else state, paid_at)
        refunded = value.get('refunded_amount')
        require(refunded is None or type(refunded) is int and 0 <= refunded <= total, 'CREEM_TRANSACTION_INVALID')
        if refunded is not None:
            order.refunded_total = max(order.refunded_total or 0, refunded)
            if refunded and order.status not in REVERSED:
                transition(db, order, 'refunded' if refunded == total else 'partially_refunded', 'purchase_reversal')
        apply_creem_reversals(db, order)
        if not waiting or order.status in REVERSED:
            grant_purchase(db, row, order, paid_at)
        row.status, row.error_code, row.last_checked_at = 'completed', 'BILLING_PAYMENT_TIME_PENDING' if waiting else None, now()
        db.commit()


def sync_creem_purchase_reversal(transaction_id, event_id=None):
    # Resolve this payment only; never choose the customer's newest checkout.
    with session_factory()() as db:
        order = db.scalar(select(BillingOrder).where(BillingOrder.provider == 'creem',
            BillingOrder.environment == provider_environment('creem'), BillingOrder.external_id == transaction_id))
        if order:
            row = db.get(BillingCheckout, order.checkout_id)
            session_id = row.session_id if row else None
        else:
            event = db.get(BillingEvent, event_id) if event_id else None
            session_id = (event.payload.get('checkout_session_id') if event and event.provider == 'creem'
                and event.environment == provider_environment('creem') and event.payload.get('transaction_id') == transaction_id else None)
            if not session_id:
                session_ids = set(db.scalars(creem_purchase_events(db, transaction_id).with_only_columns(
                    BillingEvent.resource_id).where(BillingEvent.event_type == 'checkout.completed').limit(2)))
                require(len(session_ids) == 1, 'CREEM_REFUND_UNBOUND')
                session_id = session_ids.pop()
    require(session_id, 'CREEM_REFUND_UNBOUND')
    session = creem.call('GET', '/checkouts', params={'checkout_id': session_id})
    creem.environment(session)
    require(isinstance(session.get('order'), dict)
        and creem.object_id(session['order'].get('transaction')) == transaction_id, 'CREEM_REFUND_UNBOUND')
    from .creem_billing_sync import sync_session
    sync_session(session_id)
