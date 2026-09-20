"""One durable intent per account; Stripe idempotency recovers a lost POST response."""
from datetime import timedelta, timezone
from sqlalchemy import select
from . import stripe_client as stripe
from .billing_models import BillingAccount, BillingCheckout, BillingSubscription
from .config import settings
from .db import session_factory
from .entitlements import locked_user, iso
from .models import now, uid

PENDING = ['creating', 'open', 'unknown']
LIVE_SUBSCRIPTIONS = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']


def billing_status(db, user):
    cfg = settings()
    account = db.get(BillingAccount, user.id)
    sub = db.scalar(select(BillingSubscription).where(BillingSubscription.owner_id == user.id)
        .join(BillingCheckout, BillingSubscription.checkout_id == BillingCheckout.id)
        .order_by(BillingCheckout.created_at.desc()).limit(1))
    pending = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == user.id,
        BillingCheckout.status.in_(PENDING)).limit(1))
    return {'enabled': cfg.stripe_enabled, 'provider': 'stripe', 'environment': cfg.stripe_environment,
        'trial_eligible': not account or account.trial_used_at is None,
        'checkout_pending': bool(pending), 'checkout_error': pending.error_code if pending else None,
        'subscription': None if not sub else {'status': sub.status,
            'next_billed_at': iso(sub.next_billed_at), 'cancel_at': iso(sub.cancel_at),
            'trial_ends_at': iso(sub.trial_ends_at), 'paid_ends_at': iso(sub.paid_ends_at)},
        'entitlement_expires_at': iso(user.billing_plus_expires_at)}


def bind_session(checkout_id, session):
    stripe.environment(session)
    stripe.require(session.get('mode') == 'subscription' and stripe.intent_id(session) == checkout_id
        and session.get('client_reference_id') == checkout_id)
    with session_factory()() as db:
        row = db.get(BillingCheckout, checkout_id)
        locked_user(db, row.owner_id)
        db.refresh(row)
        stripe.require(row.environment == settings().stripe_environment
            and row.session_id in (None, session['id'])
            and (not row.customer_id or row.customer_id == session.get('customer')))
        row.session_id = session['id']
        # A delayed create response must never reopen an already completed intent.
        if row.status != 'completed':
            row.status = {'open': 'open', 'expired': 'expired', 'complete': 'completed'}.get(session['status'], 'unknown')
        row.last_checked_at, row.error_code = now(), None
        db.commit()
    return session


def recover_checkout(checkout_id):
    with session_factory()() as db:
        row = db.get(BillingCheckout, checkout_id)
    if row.session_id:
        return bind_session(row.id, stripe.call('checkout.sessions', 'retrieve', row.session_id))
    # Freeze every request field in the durable intent so retries have identical parameters.
    metadata = {'app': 'node_comics', 'checkout_intent_id': row.id}
    params = {'mode': 'subscription', 'client_reference_id': row.id, 'metadata': metadata,
        'line_items': [{'price': row.price_id, 'quantity': 1}], 'payment_method_types': ['card'],
        'payment_method_collection': 'always', 'success_url': row.return_url, 'cancel_url': row.return_url,
        'expires_at': int(row.expires_at.replace(tzinfo=timezone.utc).timestamp()),
        'subscription_data': {'metadata': metadata, **({'trial_period_days': 7} if row.trial else {})}}
    if row.customer_id:
        params['customer'] = row.customer_id
    try:
        if row.created_at < now() - timedelta(hours=23) or row.expires_at < now() + timedelta(minutes=31):
            # Never re-POST after Stripe's guaranteed 24h idempotency retention window.
            matches = [s for page in stripe.pages('checkout.sessions', created={'gte': int(
                (row.created_at - timedelta(minutes=5)).replace(tzinfo=timezone.utc).timestamp())})
                for s in page if stripe.intent_id(s) == row.id]
            stripe.require(len(matches) == 1, 'STRIPE_CHECKOUT_UNCERTAIN')
            session = matches[0]
        else:
            price = stripe.call('prices', 'retrieve', row.price_id)
            stripe.approved_price(price, row.price_id)
            stripe.require(price.get('active'), 'STRIPE_PLAN_UNAVAILABLE')
            session = stripe.call('checkout.sessions', 'create', params=params,
                options={'idempotency_key': 'checkout:' + row.id})
        return bind_session(row.id, session)
    except stripe.BillingError as exc:
        with session_factory()() as db:
            locked_user(db, row.owner_id)
            current = db.get(BillingCheckout, row.id)
            if current.status in PENDING:
                # Persist unknown work for recovery. Never silently start a second purchase.
                current.status, current.error_code, current.last_checked_at = 'unknown', exc.code, now()
            db.commit()
        raise


def start_checkout(owner_id):
    cfg = settings()
    stripe.require(cfg.stripe_enabled, 'BILLING_DISABLED')
    with session_factory()() as db:
        user = locked_user(db, owner_id)
        active = db.scalar(select(BillingSubscription).where(BillingSubscription.owner_id == owner_id,
            BillingSubscription.status.in_(LIVE_SUBSCRIPTIONS)).limit(1))
        stripe.require(active is None and not (user.billing_plus_expires_at and user.billing_plus_expires_at > now()),
            'STRIPE_SUBSCRIPTION_EXISTS')
        account = db.get(BillingAccount, owner_id)
        if account is None:
            account = BillingAccount(owner_id=owner_id, environment=cfg.stripe_environment)
            db.add(account)
        stripe.require(account.environment == cfg.stripe_environment, 'STRIPE_ENVIRONMENT_MISMATCH')
        row = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == owner_id,
            BillingCheckout.status.in_(PENDING)).limit(1))
        if row is None:
            row = BillingCheckout(id=uid(), owner_id=owner_id, environment=cfg.stripe_environment,
                price_id=cfg.stripe_price_id, customer_id=account.customer_id, return_url=cfg.stripe_return_url,
                trial=account.trial_used_at is None, created_at=now(), expires_at=now()+timedelta(hours=23))
            db.add(row)
        checkout_id, trial = row.id, row.trial
        db.commit()
    session = recover_checkout(checkout_id)
    if session['status'] == 'complete':
        from .billing_sync import sync_session
        sync_session(session['id'])
        raise stripe.BillingError('STRIPE_CHECKOUT_COMPLETED')
    stripe.require(session['status'] == 'open', 'STRIPE_CHECKOUT_EXPIRED')
    return {'checkout_url': stripe.hosted_url(session['url']), 'trial': trial, 'environment': cfg.stripe_environment}


def sync_owner(owner_id):
    stripe.require(settings().stripe_enabled, 'BILLING_DISABLED')
    from .billing_sync import sync_session, sync_subscription
    with session_factory()() as db:
        locked_user(db, owner_id)
        row = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == owner_id)
            .order_by(BillingCheckout.created_at.desc()).limit(1))
        if not row or (row.last_checked_at and row.last_checked_at > now()-timedelta(seconds=10)):
            return
        row.last_checked_at = now()
        sub = db.scalar(select(BillingSubscription).where(BillingSubscription.checkout_id == row.id))
        db.commit()
    if sub:
        sync_subscription(sub.id)
    elif row.status in PENDING + ['completed']:
        session = recover_checkout(row.id)
        sync_session(session['id'])
