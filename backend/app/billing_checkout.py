"""Durable cross-channel purchase intents; never duplicate an uncertain payment."""
from datetime import timedelta, timezone
from urllib.parse import urljoin
from sqlalchemy import select
from . import stripe_client as stripe, creem_client as creem
from .billing_providers import BillingError, require, provider_enabled, provider_environment, provider_config_json, resource_key, remote_id, stripe_quote
from .billing_models import BillingAccount, BillingCustomer, BillingCheckout, BillingSubscription, BillingPrice, BillingPlanRevision, BillingPriceBinding
from .billing_access import active_terms, access_dates
from .billing_catalog import offers, price_json
from .billing_orders import checkout_order, transition
from .config import settings
from .db import session_factory
from .entitlements import locked_user, iso
from .models import now, uid

PENDING = ['creating', 'open', 'unknown']
LIVE_SUBSCRIPTIONS = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'scheduled_cancel']


def pending_checkout_condition():
    # A paid/completed handoff is still unresolved until reconciliation binds its
    # subscription. Keep it exclusive across channels while remote reads run.
    return BillingCheckout.status.in_(PENDING) | ((BillingCheckout.status == 'completed') & ~select(
        BillingSubscription.id).where(BillingSubscription.checkout_id == BillingCheckout.id).exists())


def customer_for(db, owner_id, provider):
    return db.scalar(select(BillingCustomer).where(BillingCustomer.owner_id == owner_id,
        BillingCustomer.provider == provider, BillingCustomer.environment == provider_environment(provider)))


def billing_status(db, user):
    account = db.get(BillingAccount, user.id)
    sub = db.scalar(select(BillingSubscription).where(BillingSubscription.owner_id == user.id)
        .join(BillingCheckout, BillingSubscription.checkout_id == BillingCheckout.id)
        .order_by(BillingCheckout.created_at.desc()).limit(1))
    pending = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == user.id,
        pending_checkout_condition()).limit(1))
    providers = [provider_config_json(p) for p in ('stripe', 'creem') if provider_enabled(p)]
    quote = price_json(db, db.get(BillingPrice, pending.price_id)) if pending else None
    if quote is not None:
        revision = db.get(BillingPlanRevision, db.get(BillingPrice, pending.price_id).plan_revision_id)
        quote['channels'] = [{'provider': pending.provider, 'binding_id': pending.binding_id,
            'trial_days': revision.trial_days, 'trial_redraw_pages': revision.trial_redraw_pages}]
    return {'enabled': bool(providers), 'providers': providers,
        'provider': pending.provider if pending else sub.provider if sub else None,
        'environment': providers[0]['environment'] if providers else 'test',
        'offers': offers(db), 'checkout_price': quote, 'checkout_provider': pending.provider if pending else None,
        'trial_eligible': not account or account.trial_used_at is None,
        'checkout_pending': bool(pending), 'checkout_error': pending.error_code if pending else None,
        'subscription': None if not sub else {'provider': sub.provider, 'status': sub.status,
            'price': price_json(db, db.get(BillingPrice, sub.price_id)), 'next_billed_at': iso(sub.next_billed_at),
            'cancel_at': iso(sub.cancel_at), 'trial_ends_at': iso(sub.trial_ends_at), 'paid_ends_at': iso(sub.paid_ends_at)},
        'entitlement_expires_at': iso(access_dates(db, user.id)[1])}


def bind_session(checkout_id, session):
    with session_factory()() as db:
        row = db.get(BillingCheckout, checkout_id)
        require(row is not None, 'BILLING_ACCOUNT_UNBOUND')
        locked_user(db, row.owner_id)
        db.refresh(row)
        if row.provider == 'stripe':
            stripe.environment(session)
            require(session.get('mode') == 'subscription' and stripe.intent_id(session) == row.id
                and session.get('client_reference_id') == row.id)
            status = {'open': 'open', 'expired': 'expired', 'complete': 'completed'}.get(session.get('status'), 'unknown')
            customer = session.get('customer')
        else:
            creem.environment(session)
            binding = db.get(BillingPriceBinding, row.binding_id)
            product_id = binding.trial_product_id if row.trial else binding.product_id
            require(creem.intent_id(session) == row.id and session.get('request_id') in (None, row.id)
                and creem.object_id(session.get('product')) == product_id)
            require(session.get('units', 1) == 1)
            status = {'pending': 'open', 'completed': 'completed', 'expired': 'expired'}.get(session.get('status'), 'unknown')
            customer = creem.object_id(session.get('customer'))
        require(row.environment == provider_environment(row.provider) and row.session_id in (None, session['id'])
            and (not row.customer_id or row.customer_id == customer))
        if row.provider == 'creem':
            # GET omits the URL. For a lost POST, reconstruct only after the
            # product, checkout metadata, environment and owner were validated.
            row.checkout_url = (creem.hosted_url(session['checkout_url']) if session.get('checkout_url')
                else row.checkout_url or creem.checkout_url(product_id, session['id']))
            session = {**session, 'checkout_url': row.checkout_url}
        row.session_id = session['id']
        if row.status != 'completed':
            row.status = status
        row.last_checked_at, row.error_code = now(), None
        order = checkout_order(db, row)
        if order.status in ('creating', 'pending', 'unknown', 'failed'):
            transition(db, order, {'open': 'pending', 'completed': 'processing'}.get(row.status, row.status), 'checkout_sync')
        db.commit()
    return session


def recover_checkout(checkout_id):
    with session_factory()() as db:
        row = db.get(BillingCheckout, checkout_id)
        price = db.get(BillingPrice, row.price_id)
        binding = db.get(BillingPriceBinding, row.binding_id)
        revision = db.get(BillingPlanRevision, price.plan_revision_id)
    require(provider_enabled(row.provider), 'BILLING_DISABLED')
    if row.session_id:
        session = (stripe.call('checkout.sessions', 'retrieve', row.session_id) if row.provider == 'stripe'
            else creem.call('GET', '/checkouts', params={'checkout_id': row.session_id}))
        return bind_session(row.id, session)
    metadata = {'app': 'node_comics', 'checkout_intent_id': row.id}
    sent = False
    try:
        if row.provider == 'creem':
            # A previous dispatch is durable even when its response was lost.
            # Do not let a new preflight failure downgrade that unknown payment.
            require(row.last_checked_at is None, 'CREEM_CHECKOUT_UNCERTAIN')
            product_id = binding.trial_product_id if row.trial else binding.product_id
            creem.approved_product(creem.call('GET', '/products/' + product_id), product_id, price,
                revision.trial_days if row.trial else 0)
            # request_id is correlation, NOT a documented idempotency guarantee.
            # Persist the dispatch before POST; unknown attempts require a webhook or operator reconciliation.
            with session_factory()() as db:
                locked_user(db, row.owner_id)
                current = db.get(BillingCheckout, row.id)
                require(current.last_checked_at is None, 'CREEM_CHECKOUT_UNCERTAIN')
                current.last_checked_at = now()
                current.status = 'unknown'
                db.commit()
            params = {'product_id': product_id, 'request_id': row.id, 'units': 1, 'metadata': metadata,
                'success_url': urljoin(row.return_url, '/payment/success/')}
            if row.customer_id:
                params['customer'] = {'id': row.customer_id}
            sent = True
            session = creem.call('POST', '/checkouts', body=params)
        else:
            params = {'mode': 'subscription', 'client_reference_id': row.id, 'metadata': metadata,
                'line_items': [{'price': binding.provider_price_id, 'quantity': 1}], 'payment_method_types': ['card'],
                'currency': price.currency, 'adaptive_pricing': {'enabled': False}, 'payment_method_collection': 'always',
                'success_url': urljoin(row.return_url, '/payment/success/'), 'cancel_url': row.return_url,
                'expires_at': int(row.expires_at.replace(tzinfo=timezone.utc).timestamp()),
                'subscription_data': {'metadata': metadata, **({'trial_period_days': revision.trial_days} if row.trial else {})}}
            if row.customer_id:
                params['customer'] = row.customer_id
            if row.created_at < now() - timedelta(hours=23) or row.expires_at < now() + timedelta(minutes=31):
                matches = [s for page in stripe.pages('checkout.sessions', created={'gte': int(
                    (row.created_at - timedelta(minutes=5)).replace(tzinfo=timezone.utc).timestamp())})
                    for s in page if stripe.intent_id(s) == row.id]
                require(len(matches) == 1, 'BILLING_CHECKOUT_UNCERTAIN')
                session = matches[0]
            else:
                remote = stripe.call('prices', 'retrieve', binding.provider_price_id)
                stripe.approved_price(remote, stripe_quote(binding, price))
                require(remote.get('active'), 'BILLING_PLAN_UNAVAILABLE')
                session = stripe.call('checkout.sessions', 'create', params=params, options={'idempotency_key': 'checkout:' + row.id})
        return bind_session(row.id, session)
    except BillingError as exc:
        with session_factory()() as db:
            locked_user(db, row.owner_id)
            current = db.get(BillingCheckout, row.id)
            if current.status in PENDING and current.session_id is None:
                already_dispatched = (not sent and current.provider == 'creem' and current.status == 'unknown'
                    and current.last_checked_at is not None)
                uncertain = (already_dispatched or row.provider == 'stripe' or exc.code == 'CREEM_CHECKOUT_UNCERTAIN'
                    or (sent and (exc.uncertain or exc.code != 'CREEM_UNAVAILABLE')))
                current.status, current.error_code, current.last_checked_at = ('unknown' if uncertain else 'failed'), exc.code, now()
                order = checkout_order(db, current)
                order.error_code = exc.code
                transition(db, order, 'unknown' if uncertain else 'failed', 'checkout_error', detail={'error_code': exc.code})
            db.commit()
        raise


def start_checkout(owner_id, price_id, provider):
    require(provider_enabled(provider), 'BILLING_DISABLED')
    with session_factory()() as db:
        user = locked_user(db, owner_id)
        active = db.scalar(select(BillingSubscription).where(BillingSubscription.owner_id == owner_id,
            BillingSubscription.status.in_(LIVE_SUBSCRIPTIONS)).limit(1))
        require(active is None and not active_terms(db, user.id), 'BILLING_SUBSCRIPTION_EXISTS')
        account = db.get(BillingAccount, owner_id)
        if account is None:
            account = BillingAccount(owner_id=owner_id)
            db.add(account)
        customer = customer_for(db, owner_id, provider)
        row = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == owner_id,
            pending_checkout_condition()).limit(1))
        if row is None:
            price = db.get(BillingPrice, price_id)
            require(price and price.environment == provider_environment(provider) and price.status == 'active', 'BILLING_PLAN_UNAVAILABLE')
            binding = db.scalar(select(BillingPriceBinding).where(BillingPriceBinding.price_id == price_id,
                BillingPriceBinding.provider == provider, BillingPriceBinding.environment == price.environment,
                BillingPriceBinding.status == 'active'))
            require(binding, 'BILLING_CHANNEL_UNAVAILABLE')
            revision = db.get(BillingPlanRevision, price.plan_revision_id)
            row = BillingCheckout(id=uid(), owner_id=owner_id, provider=provider, binding_id=binding.id,
                environment=price.environment, price_id=price.id, customer_id=customer.customer_id if customer else None,
                return_url=getattr(settings(), provider + '_return_url'), trial=account.trial_used_at is None and revision.trial_days > 0,
                created_at=now(), expires_at=now() + timedelta(hours=23))
            db.add(row)
            db.flush()
            checkout_order(db, row)
        else:
            require(row.price_id == price_id and row.provider == provider, 'BILLING_CHECKOUT_PRICE_CONFLICT')
        checkout_id, trial = row.id, row.trial
        db.commit()
    session = recover_checkout(checkout_id)
    if session['status'] in ('complete', 'completed'):
        from .billing_sync import sync_session
        sync_session(session['id'], provider=provider)
        raise BillingError('BILLING_CHECKOUT_COMPLETED')
    require(session['status'] in ('open', 'pending'), 'BILLING_CHECKOUT_EXPIRED')
    url = stripe.hosted_url(session['url']) if provider == 'stripe' else creem.hosted_url(session['checkout_url'])
    return {'checkout_url': url, 'trial': trial, 'environment': provider_environment(provider), 'provider': provider}


def sync_owner(owner_id):
    from .billing_sync import sync_session, sync_subscription
    with session_factory()() as db:
        locked_user(db, owner_id)
        row = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == owner_id)
            .order_by(BillingCheckout.created_at.desc()).limit(1))
        if not row or (row.last_checked_at and row.last_checked_at > now() - timedelta(seconds=10)):
            return
        sub = db.scalar(select(BillingSubscription).where(BillingSubscription.checkout_id == row.id))
        # Do not overwrite the Creem dispatch sentinel before its first request.
        if row.session_id:
            row.last_checked_at = now()
        db.commit()
    if sub:
        sync_subscription(remote_id(sub.id), provider=sub.provider)
    elif row.status in PENDING + ['completed']:
        session = recover_checkout(row.id)
        sync_session(session['id'], provider=row.provider)
