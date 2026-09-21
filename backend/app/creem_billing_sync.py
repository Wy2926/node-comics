"""Creem subscriptions are account-bound; only settled transactions create paid terms."""
from datetime import datetime, timedelta
from sqlalchemy import select
from . import creem_client as creem
from .billing_providers import require, resource_key, remote_id
from .billing_models import BillingAccount, BillingCheckout, BillingCustomer, BillingSubscription, BillingPrice, BillingPriceBinding, BillingPlanRevision, BillingInvoice, BillingTerm, BillingEvent
from .billing_checkout import bind_session, customer_for
from .billing_grants import grant_term
from .billing_orders import checkout_order, payment_order, transition, revoke_invoice, record_subscription_state
from .config import settings
from .db import session_factory
from .entitlements import locked_user
from .models import now


def transactions(customer_id):
    page = 1
    while True:
        result = creem.call('GET', '/transactions/search', params={'customer_id': customer_id, 'page_number': page, 'page_size': 100})
        rows, pagination = result.get('items'), result.get('pagination') or {}
        require(isinstance(rows, list) and type(pagination.get('total_pages')) is int, 'CREEM_INVALID_PAGINATION')
        yield from rows
        if page >= pagination['total_pages']:
            return
        require(rows and page < 10000, 'CREEM_INVALID_PAGINATION')
        page += 1


def transaction_details(sub, price, value):
    creem.environment(value)
    require(creem.object_id(value.get('subscription')) == remote_id(sub.id))
    require(creem.object_id(value.get('customer')) == sub.customer_id, 'CREEM_CUSTOMER_MISMATCH')
    require(str(value.get('currency', '')).lower() == price.currency and type(value.get('amount')) is int, 'CREEM_TRANSACTION_INVALID')
    total = value.get('amount_paid')
    if total is None:
        total = value['amount']
    require(type(total) is int and total >= 0, 'CREEM_TRANSACTION_INVALID')
    state = {'paid': 'paid', 'pending': 'pending', 'declined': 'failed', 'uncollectible': 'failed',
        'canceled': 'canceled', 'void': 'canceled', 'refunded': 'refunded', 'partialRefund': 'partially_refunded', 'partially_refunded': 'partially_refunded',
        'chargedBack': 'disputed', 'chargeback': 'disputed'}.get(value.get('status'), 'unknown')
    return total, state


def recover_trial(db, user, sub, row, price, revision, account, values, current_start, current_end, already_known):
    """A late first sync may see only the new paid period on the subscription."""
    if not row.trial or sub.trial_starts_at is not None or not current_start or revision.trial_days <= 0:
        return
    candidates = set()
    for value in values:
        total, state = transaction_details(sub, price, value)
        if state != 'paid' or total != 0 or value['amount'] not in (0, price.unit_amount):
            continue
        start, end = creem.timestamp(value.get('period_start')), creem.timestamp(value.get('period_end'))
        if not (start and end and row.created_at - timedelta(minutes=5) <= start < end
                and timedelta(0) < end-start <= timedelta(days=revision.trial_days, minutes=1)):
            continue
        historical = end <= min(current_start, now())
        canceled_trial = sub.status in ('canceled', 'expired') and (start, end) == (current_start, current_end)
        if historical or canceled_trial:
            candidates.add((start, end, historical))
    require(len(candidates) <= 1, 'CREEM_TRIAL_PERIOD_INVALID')
    if not candidates:
        return
    other_trial = db.scalar(select(BillingSubscription.id).where(BillingSubscription.owner_id == user.id,
        BillingSubscription.id != sub.id, BillingSubscription.trial_starts_at.is_not(None)).limit(1))
    require(other_trial is None and (account.trial_used_at is None or already_known), 'BILLING_TRIAL_ALREADY_USED')
    start, end, historical = next(iter(candidates))
    if historical:
        grant_term(db, user, sub, price, 'trial', start, end)
    # A trial canceled before our first observation is recorded, never activated.
    sub.trial_starts_at, sub.trial_ends_at = start, end


def apply_transaction(db, user, sub, value, event_id=None):
    price = db.get(BillingPrice, sub.price_id)
    total, state = transaction_details(sub, price, value)
    start = end = None
    if state in ('paid', 'partially_refunded'):
        start, end = creem.timestamp(value.get('period_start')), creem.timestamp(value.get('period_end'))
        require(start and end and start < end, 'CREEM_PERIOD_MISSING')
        row = db.get(BillingCheckout, sub.checkout_id)
        # Creem keeps the normal base amount on a zero-paid trial invoice.
        if (row.trial and state == 'paid' and total == 0 and value['amount'] in (0, price.unit_amount)
                and start == sub.trial_starts_at and end == sub.trial_ends_at):
            state = 'trialing'
    order = payment_order(db, sub, value['id'], total, state, 'transaction_sync', event_id=event_id, subtotal=value['amount'])
    reported = value.get('refunded_amount')
    require(reported is None or type(reported) is int and reported >= 0, 'CREEM_TRANSACTION_INVALID')
    if reported is not None:
        order.refunded_total = max(order.refunded_total or 0, reported)
    event = db.get(BillingEvent, event_id) if event_id else None
    if event and event.event_type in ('refund.created', 'dispute.created'):
        require(event.provider == order.provider and event.environment == order.environment
            and event.payload.get('transaction_id') == order.external_id, 'BILLING_REVERSAL_CONFLICT')
        from .billing_reversals import record_reversal
        snapshot = event.payload.get('reversal') or {}
        record_reversal(db, order, event.event_type.split('.')[0], event.resource_id,
            amount=snapshot.get('amount'), currency=snapshot.get('currency'), status=snapshot.get('status') or 'unknown',
            occurred_at=event.occurred_at, observed_at=event.occurred_at, event_id=event.id)
    key = resource_key('creem', value['id'])
    receipt = db.get(BillingInvoice, key)
    # A reversal can be observed before its paid receipt. The order retains
    # that verified state even if a later API snapshot still reports paid.
    if order.status in ('refunded', 'disputed'):
        if receipt:
            revoke_invoice(db, key)
        return
    if receipt:
        require(receipt.subscription_id == sub.id)
        return
    if state == 'trialing':
        db.add(BillingInvoice(id=key, subscription_id=sub.id, currency=price.currency, total=0))
        db.flush()
        trial = db.scalar(select(BillingTerm).where(BillingTerm.subscription_id == sub.id, BillingTerm.kind == 'trial'))
        if trial and trial.invoice_id is None:
            trial.invoice_id = key
        return
    if state not in ('paid', 'partially_refunded'):
        return
    low, high = (27, 32) if price.interval == 'month' else (364, 367)
    require(timedelta(days=low) <= end-start <= timedelta(days=high), 'CREEM_TRANSACTION_PERIOD_INVALID')
    # Creem transaction amount is the base price; tax is carried separately.
    require(value['amount'] == price.unit_amount, 'CREEM_TRANSACTION_AMOUNT_MISMATCH')
    db.add(BillingInvoice(id=key, subscription_id=sub.id, currency=price.currency, total=total))
    db.flush()
    grant_term(db, user, sub, price, 'paid', start, end, key)
    if sub.paid_ends_at is None or end > sub.paid_ends_at:
        sub.paid_starts_at, sub.paid_ends_at = start, end
    trial = db.scalar(select(BillingTerm).where(BillingTerm.subscription_id == sub.id, BillingTerm.kind == 'trial'))
    if trial and trial.starts_at <= start < trial.ends_at:
        from .entitlement_models import QuotaPeriod
        trial.ends_at = max(trial.starts_at + timedelta(microseconds=1), start)
        for bucket in db.scalars(select(QuotaPeriod).where(QuotaPeriod.billing_term_id == trial.id)):
            bucket.ends_at = trial.ends_at


def sync_subscription(subscription_id, transaction_id=None, event_id=None):
    hint = creem.call('GET', '/subscriptions', params={'subscription_id': subscription_id})
    creem.environment(hint)
    with session_factory()() as db:
        known = db.get(BillingSubscription, resource_key('creem', subscription_id))
        checkout_id = known.checkout_id if known else creem.intent_id(hint)
        if not checkout_id:
            return
        row = db.get(BillingCheckout, checkout_id)
        require(row is not None and row.provider == 'creem', 'BILLING_ACCOUNT_UNBOUND')
        user = locked_user(db, row.owner_id)
        db.refresh(row)
        subscription = creem.call('GET', '/subscriptions', params={'subscription_id': subscription_id})
        creem.environment(subscription)
        require(creem.intent_id(subscription) == row.id and row.environment == settings().creem_environment)
        require(row.session_id is not None, 'BILLING_CHECKOUT_PENDING')
        session = creem.call('GET', '/checkouts', params={'checkout_id': row.session_id})
        creem.environment(session)
        customer_id = creem.object_id(subscription.get('customer'))
        binding = db.get(BillingPriceBinding, row.binding_id)
        product_id = binding.trial_product_id if row.trial else binding.product_id
        require(session.get('status') == 'completed' and creem.intent_id(session) == row.id
            and session.get('request_id') in (None, row.id) and creem.object_id(session.get('subscription')) == subscription_id
            and creem.object_id(session.get('customer')) == customer_id
            and creem.object_id(session.get('product')) == product_id and session.get('units', 1) == 1)
        require(creem.object_id(subscription.get('product')) == product_id, 'CREEM_PLAN_MISMATCH')
        items = subscription.get('items')
        require(isinstance(items, list) and len(items) == 1 and items[0].get('product_id') == product_id
            and items[0].get('units') == 1, 'CREEM_PLAN_MISMATCH')
        account = db.get(BillingAccount, user.id)
        require(account is not None)
        customer = customer_for(db, user.id, 'creem')
        if customer is None:
            customer = BillingCustomer(owner_id=user.id, provider='creem', environment=row.environment, customer_id=customer_id)
            db.add(customer)
        require(customer.customer_id == customer_id, 'CREEM_CUSTOMER_MISMATCH')
        price = db.get(BillingPrice, row.price_id)
        revision = db.get(BillingPlanRevision, price.plan_revision_id)
        sub = db.get(BillingSubscription, resource_key('creem', subscription_id), populate_existing=True)
        previous_status = sub.status if sub else None
        if sub is None:
            sub = BillingSubscription(id=resource_key('creem', subscription_id), owner_id=user.id, checkout_id=row.id,
                provider='creem', binding_id=binding.id, environment=row.environment, customer_id=customer_id,
                price_id=price.id, status=subscription['status'])
            db.add(sub)
            db.flush()
        require(sub.owner_id == user.id and sub.customer_id == customer_id)
        sub.status, sub.synced_at = subscription['status'], now()
        start, end = creem.timestamp(subscription.get('current_period_start_date')), creem.timestamp(subscription.get('current_period_end_date'))
        sub.cancel_at = end if sub.status == 'scheduled_cancel' else creem.timestamp(subscription.get('canceled_at'))
        sub.next_billed_at = creem.timestamp(subscription.get('next_transaction_date')) if sub.status in ('active', 'trialing') and not sub.cancel_at else None
        if sub.status == 'trialing' and sub.trial_starts_at is None:
            require(row.trial and account.trial_used_at is None, 'BILLING_TRIAL_ALREADY_USED')
            require(start and end and timedelta(0) < end-start <= timedelta(days=revision.trial_days, minutes=1), 'CREEM_TRIAL_PERIOD_INVALID')
            grant_term(db, user, sub, price, 'trial', start, end)
            sub.trial_starts_at, sub.trial_ends_at = start, end
        order = checkout_order(db, row)
        order.subscription_id = sub.id
        if sub.status == 'trialing' and order.status not in ('paid', 'refunded', 'disputed'):
            transition(db, order, 'trialing', 'subscription_sync', event_id)
        values = []
        if not transaction_id or (row.trial and sub.trial_starts_at is None):
            for value in transactions(customer_id):
                require(isinstance(value, dict), 'CREEM_INVALID_RESPONSE')
                if creem.object_id(value.get('subscription')) == subscription_id:
                    values.append(value)
        if transaction_id:
            value = creem.call('GET', '/transactions', params={'transaction_id': transaction_id})
            require(value.get('id') == transaction_id, 'CREEM_TRANSACTION_INVALID')
            values = [item for item in values if item.get('id') != transaction_id] + [value]
        values.sort(key=lambda value: creem.timestamp(value.get('period_start')) or datetime.min)
        if sub.status != 'trialing':
            recover_trial(db, user, sub, row, price, revision, account, values, start, end, known is not None)
        for value in values:
            apply_transaction(db, user, sub, value, event_id)
        if row.trial:
            account.trial_used_at = account.trial_used_at or now()
        record_subscription_state(db, sub, previous_status)
        row.status, row.error_code, row.last_checked_at = 'completed', None, now()
        db.commit()


def sync_session(session_id):
    session = creem.call('GET', '/checkouts', params={'checkout_id': session_id})
    checkout_id = creem.intent_id(session)
    if not checkout_id:
        return
    bind_session(checkout_id, session)
    if session.get('status') == 'completed' and creem.object_id(session.get('subscription')):
        sync_subscription(creem.object_id(session['subscription']))
