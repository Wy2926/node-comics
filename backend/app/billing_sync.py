"""Durable verified event inbox and independent payment channel reconciliation."""
from datetime import timedelta
from sqlalchemy import or_, select, update
from .billing_providers import BillingError, provider_enabled, remote_id
from .billing_models import BillingCheckout, BillingEvent, BillingSubscription
from .db import session_factory
from .models import now


def sync_subscription(subscription_id, invoice_id=None, provider='stripe', event_id=None):
    if provider == 'creem':
        from .creem_billing_sync import sync_subscription as sync
        return sync(remote_id(subscription_id), invoice_id, event_id)
    from .stripe_billing_sync import sync_subscription as sync
    return sync(remote_id(subscription_id), invoice_id)


def sync_session(session_id, provider='stripe'):
    if provider == 'creem':
        from .creem_billing_sync import sync_session as sync
    else:
        from .stripe_billing_sync import sync_session as sync
    return sync(session_id)


def process_event(event_id):
    with session_factory()() as db:
        claimed = db.execute(update(BillingEvent).where(BillingEvent.id == event_id,
            BillingEvent.status.in_(['pending', 'processing']), BillingEvent.next_attempt_at <= now())
            .values(status='processing', attempts=BillingEvent.attempts + 1, next_attempt_at=now() + timedelta(minutes=5)))
        if not claimed.rowcount:
            return
        event = db.get(BillingEvent, event_id)
        kind, resource_id, attempts, provider, payload = event.event_type, event.resource_id, event.attempts, event.provider, event.payload
        db.commit()
    error = None
    try:
        if provider == 'stripe':
            from . import stripe_client as stripe
            from .billing_grants import invoice_subscription
            if kind.startswith('checkout.session.'):
                sync_session(resource_id)
            elif kind.startswith('customer.subscription.'):
                sync_subscription(resource_id)
            elif kind.startswith('invoice.'):
                invoice = stripe.call('invoices', 'retrieve', resource_id)
                if invoice_subscription(invoice):
                    sync_subscription(invoice_subscription(invoice), resource_id)
            elif kind.startswith(('charge.', 'refund.')):
                from .stripe_refunds import sync_refund_event
                sync_refund_event(payload, event_id)
        else:
            if kind == 'checkout.completed':
                sync_session(resource_id, provider='creem')
            elif kind.startswith('subscription.'):
                sync_subscription(resource_id, provider='creem', event_id=event_id)
            elif kind in ('refund.created', 'dispute.created'):
                from . import creem_client as creem
                transaction_id = payload.get('transaction_id')
                if transaction_id:
                    transaction = creem.call('GET', '/transactions', params={'transaction_id': transaction_id})
                    subscription_id = creem.object_id(transaction.get('subscription'))
                    if subscription_id:
                        sync_subscription(subscription_id, transaction_id, provider='creem', event_id=event_id)
    except BillingError as exc:
        error = exc.code
    except Exception:
        error = 'BILLING_PROCESSING_FAILED'
    with session_factory()() as db:
        event = db.get(BillingEvent, event_id)
        event.error_code, event.status = error, 'pending' if error else 'processed'
        event.processed_at = None if error else now()
        event.next_attempt_at = now() + timedelta(seconds=min(3600, 10 * 2 ** min(attempts, 8)))
        db.commit()


def reconcile_once():
    enabled = [p for p in ('stripe', 'creem') if provider_enabled(p)]
    if not enabled:
        return
    with session_factory()() as db:
        ids = list(db.scalars(select(BillingEvent.id).where(BillingEvent.provider.in_(enabled),
            BillingEvent.status.in_(['pending', 'processing']), BillingEvent.next_attempt_at <= now())
            .order_by(BillingEvent.received_at).limit(20)))
    for event_id in ids:
        process_event(event_id)
    from .billing_checkout import sync_owner, PENDING, LIVE_SUBSCRIPTIONS
    threshold = now() - timedelta(minutes=5)
    with session_factory()() as db:
        subscriptions = list(db.scalars(select(BillingSubscription).where(BillingSubscription.provider.in_(enabled),
            BillingSubscription.synced_at < threshold,
            or_(BillingSubscription.status.in_(LIVE_SUBSCRIPTIONS), BillingSubscription.paid_ends_at > now(),
                BillingSubscription.trial_ends_at > now())).order_by(BillingSubscription.synced_at).limit(10)))
        owners = list(db.scalars(select(BillingCheckout.owner_id).where(BillingCheckout.provider.in_(enabled),
            or_(BillingCheckout.status.in_(PENDING), (BillingCheckout.status == 'completed') & ~select(BillingSubscription.id)
                .where(BillingSubscription.checkout_id == BillingCheckout.id).exists()),
            or_(BillingCheckout.last_checked_at.is_(None), BillingCheckout.last_checked_at < threshold))
            .order_by(BillingCheckout.created_at).limit(10)))
    for sub in subscriptions:
        with session_factory()() as db:
            claimed = db.execute(update(BillingSubscription).where(BillingSubscription.id == sub.id,
                BillingSubscription.synced_at < threshold).values(synced_at=now()))
            db.commit()
            if not claimed.rowcount:
                continue
        try:
            sync_subscription(sub.id, provider=sub.provider)
        except BillingError:
            pass
    for owner in owners:
        try:
            sync_owner(owner)
        except BillingError:
            pass


def run(stopping):
    import logging
    while not stopping.is_set():
        try:
            reconcile_once()
        except Exception:
            logging.warning('Billing reconciliation failed; durable work will retry')
        stopping.wait(5)
