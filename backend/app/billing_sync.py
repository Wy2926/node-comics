"""Signed notifications trigger reads of current Stripe resources, never trust event order."""
from datetime import timedelta
from sqlalchemy import or_, select, update
from . import stripe_client as stripe
from .billing_models import BillingAccount, BillingCheckout, BillingEvent, BillingSubscription, BillingPlanRevision, BillingPrice
from .config import settings
from .db import session_factory
from .billing_grants import timestamp, grant_term, apply_invoice, invoice_subscription
from .entitlements import locked_user
from .models import now



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
        price = db.get(BillingPrice, row.price_id)
        stripe.approved_price(item.get('price') or {}, price)
        revision = db.get(BillingPlanRevision, price.plan_revision_id)
        account = db.get(BillingAccount, row.owner_id)
        stripe.require(account and account.environment == cfg.stripe_environment
            and account.customer_id in (None, subscription['customer']))
        account.customer_id = subscription['customer']
        sub = db.get(BillingSubscription, subscription_id)
        if sub is None:
            sub = BillingSubscription(id=subscription_id, owner_id=user.id, checkout_id=row.id,
                environment=cfg.stripe_environment, customer_id=account.customer_id, price_id=price.id, status=subscription['status'])
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
            stripe.require(timedelta(0) < trial_end-start <= timedelta(days=revision.trial_days, minutes=1), 'STRIPE_TRIAL_PERIOD_INVALID')
            grant_term(db, user, sub, price, 'trial', start, trial_end)
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
