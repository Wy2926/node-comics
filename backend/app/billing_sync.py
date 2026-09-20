"""Signed notifications trigger reads of current Stripe resources, never trust event order."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import or_, select, update
from . import stripe_client as stripe
from .billing_models import BillingAccount, BillingCheckout, BillingEvent, BillingSubscription, BillingInvoice
from .config import settings
from .db import session_factory
from .entitlement_models import QuotaPeriod
from .entitlements import locked_user, MONTHLY
from .models import now
from .providers import digest


def timestamp(value):
    if value is None:
        return None
    stripe.require(type(value) in (int, float) and value > 0, 'STRIPE_INVALID_TIMESTAMP')
    try:
        return datetime.fromtimestamp(value, timezone.utc).replace(tzinfo=None)
    except (ValueError, OverflowError, OSError):
        raise stripe.BillingError('STRIPE_INVALID_TIMESTAMP') from None


def project_access(db, user):
    periods = list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.owner_id == user.id,
        QuotaPeriod.source_key.startswith('stripe:'), QuotaPeriod.ends_at > now())
        .order_by(QuotaPeriod.starts_at, QuotaPeriod.ends_at)))
    if not periods:
        user.billing_plus_started_at = user.billing_plus_expires_at = user.billing_membership_id = None
        return
    start, end, ids = periods[0].starts_at, periods[0].ends_at, [periods[0].id]
    for period in periods[1:]:
        if period.starts_at > end:
            break
        end = max(end, period.ends_at)
        ids.append(period.id)
    user.billing_plus_started_at, user.billing_plus_expires_at = start, end
    user.billing_membership_id = digest(ids)


def grant_period(db, user, key, start, end, pages, note):
    stripe.require(start and end and start < end, 'STRIPE_PERIOD_MISSING')
    period_id = digest([user.id, key])
    if db.get(QuotaPeriod, period_id) is None:
        db.add(QuotaPeriod(id=period_id, owner_id=user.id, kind=MONTHLY, mode='redraw',
            source='membership', source_key=key, starts_at=start, ends_at=end, granted=pages,
            used=0, reserved=0, grants_access=True, note=note))
        db.flush()


def invoice_subscription(invoice):
    return ((invoice.get('parent') or {}).get('subscription_details') or {}).get('subscription')


def apply_invoice(db, user, sub, invoice):
    stripe.environment(invoice)
    stripe.require(invoice_subscription(invoice) == sub.id and invoice.get('customer') == sub.customer_id)
    receipt = db.get(BillingInvoice, invoice['id'])
    if receipt:
        stripe.require(receipt.subscription_id == sub.id)
        return
    if invoice.get('status') != 'paid':
        return
    stripe.require(invoice.get('amount_remaining') == 0 and invoice.get('currency') == 'usd', 'STRIPE_INVOICE_INVALID')
    if invoice.get('billing_reason') not in ('subscription_create', 'subscription_cycle'):
        return  # Adjustments/prorations are not another monthly entitlement.
    lines = invoice.get('lines') or {}
    if lines.get('has_more'):
        rows = [line for page in stripe.pages('invoices.line_items', invoice['id']) for line in page]
    else:
        rows = lines.get('data', [])
    candidates = []
    for line in rows:
        details = ((line.get('parent') or {}).get('subscription_item_details') or {})
        price = ((line.get('pricing') or {}).get('price_details') or {})
        if details.get('subscription') != sub.id or details.get('proration') is not False:
            continue
        if price.get('price') != settings().stripe_price_id:
            continue
        stripe.require(price.get('product') == settings().stripe_product_id and line.get('quantity') == 1,
            'STRIPE_PLAN_MISMATCH')
        period = line.get('period') or {}
        start, end = timestamp(period.get('start')), timestamp(period.get('end'))
        stripe.require(start and end and start < end, 'STRIPE_PERIOD_MISSING')
        if timedelta(days=27) <= end-start <= timedelta(days=32):
            candidates.append((start, end))
    stripe.require(len(candidates) <= 1, 'STRIPE_INVOICE_INVALID')
    if candidates:
        start, end = candidates[0]
        # Fully settled credit/discount invoices still purchase a real monthly term.
        grant_period(db, user, f'stripe:paid:{sub.id}:{start.isoformat()}:{end.isoformat()}',
            start, end, 300, 'PLUS 月账期 · 300 页重绘')
        if sub.paid_ends_at is None or end > sub.paid_ends_at:
            sub.paid_starts_at, sub.paid_ends_at = start, end
        trial = db.scalar(select(QuotaPeriod).where(QuotaPeriod.owner_id == user.id,
            QuotaPeriod.source_key == 'stripe:trial:' + sub.id))
        if trial and start < trial.ends_at:
            trial.ends_at = max(trial.starts_at + timedelta(microseconds=1), start)
    elif not (sub.trial_starts_at and invoice.get('billing_reason') == 'subscription_create'):
        raise stripe.BillingError('STRIPE_INVOICE_PERIOD_INVALID')
    db.add(BillingInvoice(id=invoice['id'], subscription_id=sub.id))
    db.flush()


def sync_subscription(subscription_id, invoice_id=None):
    cfg = settings()
    # This first read only resolves the owner. Read again under the account lock so
    # concurrently arriving old events cannot overwrite newer subscription state.
    hint = stripe.call('subscriptions', 'retrieve', subscription_id)
    with session_factory()() as db:
        known = db.get(BillingSubscription, subscription_id)
        checkout_id = known.checkout_id if known else stripe.intent_id(hint)
        if not checkout_id:
            return  # Another product on the Stripe account, not a failed delivery.
        row = db.get(BillingCheckout, checkout_id) if checkout_id else None
        stripe.require(row is not None, 'STRIPE_ACCOUNT_UNBOUND')
        user = locked_user(db, row.owner_id)
        db.refresh(row)
        subscription = stripe.call('subscriptions', 'retrieve', subscription_id)
        stripe.environment(subscription)
        stripe.require(row.environment == cfg.stripe_environment and stripe.intent_id(subscription) == row.id)
        # A subscription must originate from this authenticated, server-created Checkout.
        stripe.require(row.session_id is not None, 'STRIPE_CHECKOUT_PENDING')
        session = stripe.call('checkout.sessions', 'retrieve', row.session_id)
        stripe.environment(session)
        stripe.require(session.get('status') == 'complete' and session.get('mode') == 'subscription'
            and session.get('subscription') == subscription_id and stripe.intent_id(session) == row.id
            and session.get('client_reference_id') == row.id and session.get('customer') == subscription.get('customer'))
        items = subscription.get('items') or {}
        stripe.require(not items.get('has_more') and len(items.get('data', [])) == 1, 'STRIPE_PLAN_MISMATCH')
        item = items['data'][0]
        stripe.require(item.get('quantity') == 1, 'STRIPE_PLAN_MISMATCH')
        stripe.approved_price(item.get('price') or {}, row.price_id)
        account = db.get(BillingAccount, row.owner_id)
        stripe.require(account and account.environment == cfg.stripe_environment
            and account.customer_id in (None, subscription['customer']))
        account.customer_id = subscription['customer']
        sub = db.get(BillingSubscription, subscription_id)
        if sub is None:
            sub = BillingSubscription(id=subscription_id, owner_id=user.id, checkout_id=row.id,
                environment=cfg.stripe_environment, customer_id=account.customer_id, status=subscription['status'])
            db.add(sub)
            db.flush()
        stripe.require(sub.owner_id == user.id and sub.customer_id == account.customer_id)
        sub.status, sub.synced_at = subscription['status'], now()
        end = timestamp(item.get('current_period_end'))
        sub.cancel_at = timestamp(subscription.get('cancel_at')) or (end if subscription.get('cancel_at_period_end') else None)
        sub.next_billed_at = end if sub.status in ('active', 'trialing') and not sub.cancel_at else None
        # Retain the original trial dates even when the first callback arrives after conversion.
        start, trial_end = timestamp(subscription.get('trial_start')), timestamp(subscription.get('trial_end'))
        if start and trial_end and sub.trial_starts_at is None:
            stripe.require(row.trial and account.trial_used_at is None, 'STRIPE_TRIAL_ALREADY_USED')
            stripe.require(timedelta(0) < trial_end-start <= timedelta(days=7, minutes=1), 'STRIPE_TRIAL_PERIOD_INVALID')
            grant_period(db, user, 'stripe:trial:' + sub.id, start, trial_end, 30, 'PLUS 7 天试用 · 30 页重绘')
            sub.trial_starts_at, sub.trial_ends_at = start, trial_end
        if row.trial:
            account.trial_used_at = account.trial_used_at or now()
        if invoice_id:
            apply_invoice(db, user, sub, stripe.call('invoices', 'retrieve', invoice_id))
        else:
            # Scan paid invoices without a created-at watermark: old unpaid invoices
            # may settle much later. Receipts make all replayed pages idempotent.
            for invoices in stripe.pages('invoices', subscription=sub.id, status='paid'):
                for invoice in invoices:
                    apply_invoice(db, user, sub, invoice)
        row.status, row.error_code, row.last_checked_at = 'completed', None, now()
        project_access(db, user)
        db.commit()


def sync_session(session_id):
    from .billing_checkout import bind_session
    session = stripe.call('checkout.sessions', 'retrieve', session_id)
    checkout_id = stripe.intent_id(session)
    if not checkout_id:
        return
    with session_factory()() as db:
        stripe.require(checkout_id and db.get(BillingCheckout, checkout_id), 'STRIPE_ACCOUNT_UNBOUND')
    bind_session(checkout_id, session)
    if session.get('status') == 'complete' and session.get('subscription'):
        sync_subscription(session['subscription'])


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
        if kind.startswith('checkout.session.'):
            sync_session(resource_id)
        elif kind.startswith('customer.subscription.'):
            sync_subscription(resource_id)
        elif kind.startswith('invoice.'):
            invoice = stripe.call('invoices', 'retrieve', resource_id)
            if invoice_subscription(invoice):
                sync_subscription(invoice_subscription(invoice), resource_id)
    except stripe.BillingError as exc:
        error = exc.code
    except Exception:
        error = 'BILLING_PROCESSING_FAILED'
    with session_factory()() as db:
        event = db.get(BillingEvent, event_id)
        event.error_code, event.status = error, 'pending' if error else 'processed'
        event.processed_at = None if error else now()
        event.next_attempt_at = now()+timedelta(seconds=min(3600, 10*2**min(attempts, 8)))
        db.commit()


def reconcile_once():
    if not settings().stripe_enabled:
        return
    with session_factory()() as db:
        ids = list(db.scalars(select(BillingEvent.id).where(BillingEvent.status.in_(['pending', 'processing']),
            BillingEvent.next_attempt_at <= now()).order_by(BillingEvent.received_at).limit(20)))
    for event_id in ids:
        process_event(event_id)
    from .billing_checkout import sync_owner, PENDING, LIVE_SUBSCRIPTIONS
    threshold = now()-timedelta(minutes=5)
    with session_factory()() as db:
        subscriptions = list(db.scalars(select(BillingSubscription.id).where(
            BillingSubscription.synced_at < threshold,
            or_(BillingSubscription.status.in_(LIVE_SUBSCRIPTIONS), BillingSubscription.paid_ends_at > now(),
                BillingSubscription.trial_ends_at > now())).order_by(BillingSubscription.synced_at).limit(10)))
        owners = list(db.scalars(select(BillingCheckout.owner_id).where(
            or_(BillingCheckout.status.in_(PENDING),
                (BillingCheckout.status == 'completed') & ~select(BillingSubscription.id).where(
                    BillingSubscription.checkout_id == BillingCheckout.id).exists()),
            or_(BillingCheckout.last_checked_at.is_(None), BillingCheckout.last_checked_at < threshold))
            .order_by(BillingCheckout.created_at).limit(10)))
    for sub_id in subscriptions:
        with session_factory()() as db:
            claimed = db.execute(update(BillingSubscription).where(BillingSubscription.id == sub_id,
                BillingSubscription.synced_at < threshold).values(synced_at=now()))
            db.commit()
            if not claimed.rowcount:
                continue
        try:
            sync_subscription(sub_id)
        except stripe.BillingError:
            pass
    for owner_id in owners:
        try:
            sync_owner(owner_id)
        except stripe.BillingError:
            pass


def run(stopping):
    import logging
    while not stopping.is_set():
        try:
            reconcile_once()
        except Exception:
            logging.warning('Billing reconciliation failed; durable work will retry')
        stopping.wait(5)
