"""Reconcile trusted Paddle resources into immutable account quota periods."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import or_, select, update
from . import paddle_client as paddle
from .billing_models import BillingAccount, BillingCheckout, BillingEvent, BillingSubscription
from .config import settings
from .db import session_factory
from .entitlement_models import QuotaPeriod
from .entitlements import locked_user, MONTHLY
from .models import now
from .providers import digest


def timestamp(value):
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).replace(tzinfo=None)
    except (ValueError, TypeError, AttributeError):
        raise paddle.PaddleError('PADDLE_INVALID_TIMESTAMP') from None


def require(condition, code='PADDLE_BINDING_MISMATCH'):
    if not condition:
        raise paddle.PaddleError(code)


def approved_item(resource, price_id=None):
    cfg = settings()
    items = resource.get('items', [])
    require(len(items) == 1, 'PADDLE_PLAN_MISMATCH')
    item = items[0]
    price = item.get('price', {})
    require(item.get('quantity') == 1 and price.get('id') in {cfg.paddle_trial_price_id, cfg.paddle_standard_price_id}
        and (price_id is None or price.get('id') == price_id)
        and price.get('product_id') == cfg.paddle_product_id
        and price.get('unit_price') == {'amount': '999', 'currency_code': 'USD'}
        and price.get('billing_cycle') == {'interval': 'month', 'frequency': 1}, 'PADDLE_PLAN_MISMATCH')
    require(resource.get('currency_code') == 'USD', 'PADDLE_CURRENCY_MISMATCH')
    return item


def intent_id(resource):
    data = resource.get('custom_data') or {}
    return data.get('checkout_intent_id') if isinstance(data, dict) and data.get('app') == 'node_comics' else None


def project_access(db, user):
    """Project continuous, already granted terms for DB-free scheduler checks."""
    periods = list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.owner_id == user.id,
        QuotaPeriod.source_key.startswith('paddle:'), QuotaPeriod.ends_at > now())
        .order_by(QuotaPeriod.starts_at, QuotaPeriod.ends_at)))
    if not periods:
        user.billing_plus_started_at = user.billing_plus_expires_at = user.billing_membership_id = None
        return
    start, end = periods[0].starts_at, periods[0].ends_at
    ids = [periods[0].id]
    for period in periods[1:]:
        if period.starts_at > end:
            break
        end = max(end, period.ends_at)
        ids.append(period.id)
    user.billing_plus_started_at, user.billing_plus_expires_at = start, end
    user.billing_membership_id = digest(ids)


def grant_period(db, user, key, start, end, pages, note):
    require(start is not None and end is not None and start < end, 'PADDLE_PERIOD_MISSING')
    period_id = digest([user.id, key])
    period = db.get(QuotaPeriod, period_id)
    if period is None:
        period = QuotaPeriod(id=period_id, owner_id=user.id, kind=MONTHLY, mode='redraw',
            source='membership', source_key=key, starts_at=start, ends_at=end, granted=pages,
            used=0, reserved=0, grants_access=True, note=note)
        db.add(period)
        db.flush()
    # Repeated events never rewrite used/reserved/granted on an existing period.
    return period


def reconcile_snapshot(subscription, transaction=None):
    cfg = settings()
    sub_id = subscription['id']
    with session_factory()() as db:
        known = db.get(BillingSubscription, sub_id)
        checkout = db.get(BillingCheckout, known.checkout_id if known else intent_id(subscription))
        if checkout is None:
            raise paddle.PaddleError('PADDLE_ACCOUNT_UNBOUND')
        checkout_id, owner_id, original_id = checkout.id, checkout.owner_id, checkout.transaction_id
        require(checkout.environment == cfg.paddle_environment)
        known_id = known.id if known else None
    if not known_id:
        require(original_id is not None, 'PADDLE_CHECKOUT_PENDING')
        original = transaction if transaction and transaction.get('id') == original_id else paddle.request('GET', '/transactions/' + original_id)
        require(original.get('subscription_id') == sub_id and original.get('status') == 'completed'
                and intent_id(original) == checkout_id, 'PADDLE_CHECKOUT_PENDING')
        with session_factory()() as db:
            expected_price = db.get(BillingCheckout, checkout_id).price_id
        approved_item(original, expected_price)
        require(original.get('customer_id') == subscription.get('customer_id'))
    approved_item(subscription)
    if transaction:
        approved_item(transaction)
        require(transaction.get('subscription_id') == sub_id
                and transaction.get('customer_id') == subscription.get('customer_id'))
    with session_factory()() as db:
        user = locked_user(db, owner_id)
        checkout = db.get(BillingCheckout, checkout_id)
        account = db.get(BillingAccount, owner_id)
        require(account and account.environment == cfg.paddle_environment)
        require(account.customer_id is None or account.customer_id == subscription.get('customer_id'))
        account.customer_id = subscription['customer_id']
        sub = db.get(BillingSubscription, sub_id)
        updated = timestamp(subscription['updated_at'])
        if sub is None:
            sub = BillingSubscription(id=sub_id, owner_id=owner_id, checkout_id=checkout_id,
                environment=cfg.paddle_environment, customer_id=account.customer_id,
                status=subscription['status'], provider_updated_at=updated)
            db.add(sub)
            db.flush()
        require(sub.owner_id == owner_id and sub.environment == cfg.paddle_environment)
        if updated >= sub.provider_updated_at:
            sub.status = subscription['status']
            sub.provider_updated_at = updated
            sub.next_billed_at = timestamp(subscription.get('next_billed_at'))
            change = subscription.get('scheduled_change') or {}
            sub.cancel_at = timestamp(change.get('effective_at')) if change.get('action') == 'cancel' else None
        sub.synced_at = now()
        if subscription['status'] == 'trialing' and sub.trial_starts_at is None and sub.paid_ends_at is None:
            require(checkout.trial and account.trial_used_at is None, 'PADDLE_TRIAL_ALREADY_USED')
            dates = subscription['items'][0].get('trial_dates') or subscription.get('current_billing_period') or {}
            start, end = timestamp(dates.get('starts_at')), timestamp(dates.get('ends_at'))
            require(start and end and timedelta(0) < end - start <= timedelta(days=7, minutes=1), 'PADDLE_TRIAL_PERIOD_INVALID')
            grant_period(db, user, 'paddle:trial:' + sub_id, start, end, 30, 'PLUS 7 天试用 · 30 页重绘')
            sub.trial_starts_at, sub.trial_ends_at = start, end
        if checkout.trial:
            account.trial_used_at = account.trial_used_at or now()
        if transaction and transaction.get('status') == 'completed':
            totals = (transaction.get('details') or {}).get('totals') or {}
            dates = transaction.get('billing_period') or {}
            start, end = timestamp(dates.get('starts_at')), timestamp(dates.get('ends_at'))
            # Zero-value trial invoices and prorations do not mint a monthly bucket.
            total = totals.get('grand_total', totals.get('total', '0'))
            if str(total).isdigit() and int(total) > 0 and start and end and timedelta(days=27) <= end-start <= timedelta(days=32):
                key = f'paddle:paid:{sub_id}:{start.isoformat()}:{end.isoformat()}'
                grant_period(db, user, key, start, end, 300, 'PLUS 已付款月账期 · 300 页重绘')
                if sub.paid_ends_at is None or end > sub.paid_ends_at:
                    sub.paid_starts_at, sub.paid_ends_at = start, end
                trial = db.scalar(select(QuotaPeriod).where(QuotaPeriod.owner_id == owner_id,
                    QuotaPeriod.source_key == 'paddle:trial:' + sub_id))
                if trial and start < trial.ends_at:
                    trial.ends_at = max(trial.starts_at + timedelta(microseconds=1), start)
        if sub.trial_starts_at is not None or sub.paid_ends_at is not None:
            checkout.status, checkout.error_code = 'completed', None
        checkout.last_checked_at = now()
        project_access(db, user)
        db.commit()


def sync_transaction(transaction_id):
    transaction = paddle.request('GET', '/transactions/' + transaction_id)
    with session_factory()() as db:
        checkout = db.scalar(select(BillingCheckout).where(BillingCheckout.transaction_id == transaction_id))
        if checkout:
            checkout.last_checked_at = now()
            if transaction.get('status') == 'canceled':
                checkout.status = 'canceled'
            db.commit()
    if transaction.get('subscription_id'):
        subscription = paddle.request('GET', '/subscriptions/' + transaction['subscription_id'])
        reconcile_snapshot(subscription, transaction)


def sync_subscription(subscription_id):
    subscription = paddle.request('GET', '/subscriptions/' + subscription_id)
    reconcile_snapshot(subscription)
    transactions = paddle.request('GET', '/transactions?subscription_id=' + subscription_id + '&status=completed&per_page=50')
    # All returned paid periods are idempotent, including catch-up after lost events.
    for transaction in transactions:
        reconcile_snapshot(subscription, transaction)


def process_event(event_id):
    with session_factory()() as db:
        claimed = db.execute(update(BillingEvent).where(BillingEvent.id == event_id,
            BillingEvent.status.in_(['pending', 'processing']), BillingEvent.next_attempt_at <= now())
            .values(status='processing', attempts=BillingEvent.attempts+1, next_attempt_at=now()+timedelta(minutes=5)))
        if not claimed.rowcount:
            return
        event = db.get(BillingEvent, event_id)
        kind, resource_id, attempts = event.event_type, event.resource_id, event.attempts
        db.commit()
    error = None
    try:
        if kind.startswith('transaction.'):
            sync_transaction(resource_id)
        elif kind.startswith('subscription.'):
            sync_subscription(resource_id)
    except paddle.PaddleError as exc:
        error = exc.code
    except Exception:
        error = 'BILLING_PROCESSING_FAILED'
    with session_factory()() as db:
        event = db.get(BillingEvent, event_id)
        event.error_code = error
        event.status = 'pending' if error else 'processed'
        event.processed_at = None if error else now()
        event.next_attempt_at = now() + timedelta(seconds=min(3600, 10 * 2 ** min(attempts, 8)))
        db.commit()


def reconcile_once():
    if not settings().paddle_enabled:
        return
    with session_factory()() as db:
        ids = list(db.scalars(select(BillingEvent.id).where(BillingEvent.status.in_(['pending', 'processing']),
            BillingEvent.next_attempt_at <= now()).order_by(BillingEvent.received_at).limit(20)))
    for event_id in ids:
        process_event(event_id)
    # Catch up even if a webhook never reached us. Persist leases before network
    # I/O so parallel workers and restarts do not create polling bursts.
    threshold = now() - timedelta(minutes=5)
    with session_factory()() as db:
        subscriptions = list(db.scalars(select(BillingSubscription.id).where(
            BillingSubscription.synced_at < threshold,
            or_(BillingSubscription.status.in_(['active', 'trialing', 'past_due', 'paused']),
                BillingSubscription.paid_ends_at > now(), BillingSubscription.trial_ends_at > now()))
            .order_by(BillingSubscription.synced_at).limit(10)))
        owners = list(db.scalars(select(BillingCheckout.owner_id).where(
            BillingCheckout.status.in_(['open', 'creating', 'unknown']),
            BillingCheckout.created_at > now() - timedelta(days=2),
            or_(BillingCheckout.last_checked_at.is_(None), BillingCheckout.last_checked_at < threshold))
            .order_by(BillingCheckout.created_at).limit(10)))
    for subscription_id in subscriptions:
        with session_factory()() as db:
            claimed = db.execute(update(BillingSubscription).where(BillingSubscription.id == subscription_id,
                BillingSubscription.synced_at < threshold).values(synced_at=now()))
            db.commit()
            if not claimed.rowcount:
                continue
        try:
            sync_subscription(subscription_id)
        except paddle.PaddleError:
            pass
    from .billing_checkout import sync_owner
    for owner_id in owners:
        try:
            sync_owner(owner_id)
        except paddle.PaddleError:
            pass


def run(stopping):
    """Independent maintenance thread: Paddle latency must not stall job recovery."""
    import logging
    while not stopping.is_set():
        try:
            reconcile_once()
        except Exception:
            logging.warning('Billing reconciliation failed; durable work will retry')
        stopping.wait(5)
