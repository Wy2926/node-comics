"""One recoverable checkout per account. Never retry an uncertain Paddle POST."""
from datetime import timedelta
import hashlib
import secrets
from sqlalchemy import select
from . import paddle_client as paddle
from .billing_models import BillingAccount, BillingCheckout, BillingSubscription
from .billing_sync import approved_item, intent_id, require, sync_transaction, sync_subscription
from .config import settings
from .db import session_factory
from .entitlements import locked_user, iso
from .models import now, uid


def billing_status(db, user):
    cfg = settings()
    account = db.get(BillingAccount, user.id)
    subscription = db.scalar(select(BillingSubscription).where(BillingSubscription.owner_id == user.id)
        .order_by(BillingSubscription.provider_updated_at.desc()).limit(1))
    pending = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == user.id,
        BillingCheckout.status.in_(['creating', 'open', 'unknown'])).order_by(BillingCheckout.created_at.desc()).limit(1))
    return {'enabled': cfg.paddle_enabled, 'environment': cfg.paddle_environment,
        'trial_eligible': not account or account.trial_used_at is None,
        'checkout_pending': bool(pending), 'checkout_error': pending.error_code if pending else None,
        'subscription': None if not subscription else {'status': subscription.status,
            'next_billed_at': iso(subscription.next_billed_at), 'cancel_at': iso(subscription.cancel_at),
            'trial_ends_at': iso(subscription.trial_ends_at), 'paid_ends_at': iso(subscription.paid_ends_at)},
        'entitlement_expires_at': iso(user.billing_plus_expires_at)}


def recover_checkout(checkout_id):
    with session_factory()() as db:
        checkout = db.get(BillingCheckout, checkout_id)
        if checkout.transaction_id:
            return
        # Give an in-flight creating request time to finish before reconciliation.
        if checkout.status == 'creating' and checkout.created_at > now() - timedelta(seconds=30):
            raise paddle.PaddleError('PADDLE_CHECKOUT_PENDING')
    transactions = paddle.request('GET', '/transactions?per_page=200&order_by=id[DESC]')
    matches = [t for t in transactions if intent_id(t) == checkout_id]
    require(len(matches) == 1, 'PADDLE_CHECKOUT_UNCERTAIN')
    transaction = matches[0]
    with session_factory()() as db:
        owner = db.get(BillingCheckout, checkout_id).owner_id
        locked_user(db, owner)
        checkout = db.get(BillingCheckout, checkout_id)
        approved_item(transaction, checkout.price_id)
        checkout.transaction_id, checkout.status, checkout.error_code = transaction['id'], 'open', None
        db.commit()


def start_checkout(owner_id):
    cfg = settings()
    require(cfg.paddle_enabled, 'BILLING_DISABLED')
    with session_factory()() as db:
        user = locked_user(db, owner_id)
        existing_sub = db.scalar(select(BillingSubscription).where(BillingSubscription.owner_id == owner_id,
            BillingSubscription.status.in_(['active', 'trialing', 'past_due', 'paused'])).limit(1))
        require(existing_sub is None and not (user.billing_plus_expires_at and user.billing_plus_expires_at > now()),
                'PADDLE_SUBSCRIPTION_EXISTS')
        account = db.get(BillingAccount, owner_id)
        if account is None:
            account = BillingAccount(owner_id=owner_id, environment=cfg.paddle_environment)
            db.add(account)
        require(account.environment == cfg.paddle_environment, 'PADDLE_ENVIRONMENT_MISMATCH')
        checkout = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == owner_id,
            BillingCheckout.status.in_(['creating', 'open', 'unknown'])).order_by(BillingCheckout.created_at.desc()).limit(1))
        create = checkout is None
        if create:
            trial = account.trial_used_at is None
            checkout = BillingCheckout(id=uid(), owner_id=owner_id, environment=cfg.paddle_environment,
                price_id=cfg.paddle_trial_price_id if trial else cfg.paddle_standard_price_id, trial=trial, status='creating')
            db.add(checkout)
        checkout_id, price_id, customer_id = checkout.id, checkout.price_id, account.customer_id
        db.commit()
    if create:
        transaction = None
        try:
            price = paddle.request('GET', '/prices/' + price_id)
            approved_item({'items': [{'price': price, 'quantity': 1}], 'currency_code': 'USD'}, price_id)
            trial_period = price.get('trial_period')
            require((trial and trial_period and trial_period.get('interval') == 'day' and trial_period.get('frequency') == 7
                and trial_period.get('requires_payment_method') is True and trial_period.get('unit_price') is None)
                or (not trial and trial_period is None), 'PADDLE_PLAN_MISMATCH')
            body = {'items': [{'price_id': price_id, 'quantity': 1}], 'currency_code': 'USD',
                'collection_mode': 'automatic', 'checkout': {'url': cfg.paddle_checkout_url},
                'custom_data': {'app': 'node_comics', 'checkout_intent_id': checkout_id}}
            if customer_id:
                body['customer_id'] = customer_id
            transaction = paddle.request('POST', '/transactions', body)
            approved_item(transaction, price_id)
        except paddle.PaddleError as exc:
            with session_factory()() as db:
                locked_user(db, owner_id)
                row = db.get(BillingCheckout, checkout_id)
                # A successful POST followed by a validation failure still made a
                # remote transaction. Preserve it for review; never create another.
                uncertain = exc.uncertain or transaction is not None
                row.status, row.error_code = ('unknown' if uncertain else 'failed'), exc.code
                db.commit()
            raise
        with session_factory()() as db:
            locked_user(db, owner_id)
            checkout = db.get(BillingCheckout, checkout_id)
            checkout.transaction_id, checkout.status = transaction['id'], 'open'
            db.commit()
    else:
        recover_checkout(checkout_id)
    token = secrets.token_urlsafe(32)
    with session_factory()() as db:
        locked_user(db, owner_id)
        checkout = db.get(BillingCheckout, checkout_id)
        checkout.token_hash = hashlib.sha256(token.encode()).hexdigest()
        checkout.token_expires_at = now() + timedelta(hours=2)
        db.commit()
        return {'checkout_url': cfg.paddle_checkout_url + '#' + token,
                'trial': checkout.trial, 'environment': cfg.paddle_environment}


def sync_owner(owner_id):
    require(settings().paddle_enabled, 'BILLING_DISABLED')
    with session_factory()() as db:
        locked_user(db, owner_id)
        rows = list(db.scalars(select(BillingCheckout).where(BillingCheckout.owner_id == owner_id,
            BillingCheckout.status.in_(['creating', 'unknown', 'open', 'completed']))
            .order_by(BillingCheckout.created_at.desc()).limit(1)))
        if not rows:
            return
        row = rows[0]
        if row.last_checked_at and row.last_checked_at > now() - timedelta(seconds=10):
            return
        row.last_checked_at = now()
        checkout_id, transaction_id = row.id, row.transaction_id
        sub = db.scalar(select(BillingSubscription).where(BillingSubscription.checkout_id == row.id))
        subscription_id = sub.id if sub else None
        db.commit()
    if subscription_id:
        sync_subscription(subscription_id)
    else:
        if not transaction_id:
            recover_checkout(checkout_id)
            with session_factory()() as db:
                transaction_id = db.get(BillingCheckout, checkout_id).transaction_id
        sync_transaction(transaction_id)
