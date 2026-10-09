"""Durable cross-channel purchase intents; never duplicate an uncertain payment."""
from datetime import timedelta, timezone
from urllib.parse import urljoin
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from . import stripe_client as stripe, creem_client as creem
from .billing_providers import BillingError, require, provider_enabled, provider_environment, provider_config_json, resource_key, remote_id, stripe_quote
from .billing_models import BillingAccount, BillingCustomer, BillingCheckout, BillingSubscription, BillingPrice, BillingPlanRevision, BillingPriceBinding, BillingOrder
from .entitlement_models import QuotaPeriod
from .billing_access import active_terms, access_dates
from .billing_catalog import offers, price_json, default_provider
from .billing_orders import checkout_order, transition
from .config import settings
from .db import session_factory
from .entitlements import locked_user, iso, gift_json
from .models import now, uid
from .billing_renewal import LIVE as LIVE_SUBSCRIPTIONS

PENDING = ['creating', 'open', 'unknown']


def pending_checkout_condition():
    # Provider completion is not fulfillment: keep this intent pending until
    # its subscription or purchased bucket exists (or its payment was revoked).
    subscription = select(BillingSubscription.id).where(
        BillingSubscription.checkout_id == BillingCheckout.id).exists()
    purchase = select(BillingOrder.id).join(BillingPrice, BillingPrice.id == BillingOrder.price_id).where(
        BillingOrder.checkout_id == BillingCheckout.id, BillingPrice.interval == 'once',
        (BillingOrder.status.in_(['refunded', 'disputed'])) | (
            BillingOrder.status.in_(['paid', 'partially_refunded']) & select(QuotaPeriod.id).where(
                QuotaPeriod.billing_order_id == BillingOrder.id).exists())).exists()
    return BillingCheckout.status.in_(PENDING) | ((BillingCheckout.status == 'completed') & ~subscription & ~purchase)


def customer_for(db, owner_id, provider):
    return db.scalar(select(BillingCustomer).where(BillingCustomer.owner_id == owner_id,
        BillingCustomer.provider == provider, BillingCustomer.environment == provider_environment(provider)))


def current_subscription(db, owner_id, provider=None):
    query = select(BillingSubscription).join(BillingCheckout, BillingSubscription.checkout_id == BillingCheckout.id).where(
        BillingSubscription.owner_id == owner_id)
    if provider is not None:
        query = query.where(BillingSubscription.provider == provider)
    return db.scalar(query.order_by(BillingCheckout.created_at.desc()).limit(1))


def subscription_checkout(db, owner_id):
    return db.execute(select(BillingCheckout, BillingPrice).join(
        BillingPrice, BillingPrice.id == BillingCheckout.price_id).where(
            BillingCheckout.owner_id == owner_id, BillingPrice.interval != 'once', pending_checkout_condition())
        .order_by(BillingCheckout.created_at, BillingCheckout.id).limit(1)).first()


def billing_status(db, user):
    from .billing_renewal import renewal_json
    account = db.get(BillingAccount, user.id)
    sub = current_subscription(db, user.id)
    pending = None
    selected = subscription_checkout(db, user.id)
    if selected:
        row, price = selected
        quote = price_json(db, price)
        revision = db.get(BillingPlanRevision, price.plan_revision_id)
        quote['channels'] = [{'provider': row.provider, 'binding_id': row.binding_id,
            'trial_days': revision.trial_days, 'trial_classic_pages': revision.trial_classic_pages}]
        pending = {'id': row.id, 'provider': row.provider, 'price': quote,
            'idempotency_key': row.idempotency_key, 'error': row.error_code}
    providers = [provider_config_json(p) for p in ('stripe', 'creem') if provider_enabled(p)]
    return {'enabled': bool(providers), 'providers': providers,
        'provider': sub.provider if sub else None,
        'environment': providers[0]['environment'] if providers else 'test',
        'offers': offers(db), 'quota_offers': offers(db, interval='once'),
        'subscription_checkout': pending,
        'trial_eligible': not account or account.trial_used_at is None,
        'gift': gift_json(user),
        'subscription': None if not sub else {'provider': sub.provider, 'status': sub.status, **renewal_json(sub),
            'price': price_json(db, db.get(BillingPrice, sub.price_id)), 'next_billed_at': iso(sub.next_billed_at),
            'cancel_at': iso(sub.cancel_at), 'trial_ends_at': iso(sub.trial_ends_at), 'paid_ends_at': iso(sub.paid_ends_at)},
        'entitlement_expires_at': iso(access_dates(db, user.id)[1])}


def creem_session_identity(db, row, session):
    """Validate immutable correlation; a locator alone is not a bound checkout."""
    creem.environment(session)
    require(row.environment == provider_environment('creem'))
    binding = db.get(BillingPriceBinding, row.binding_id)
    product_id = binding.trial_product_id if row.trial else binding.product_id
    require(isinstance(session.get('metadata'), dict) and creem.intent_id(session) == row.id
        and session.get('request_id') in (None, row.id)
        and creem.object_id(session.get('product')) == product_id and session.get('units', 1) == 1)
    require(row.session_id in (None, session.get('id')))
    # Reuse canonical ID validation; the database unique constraint additionally
    # prevents this locator from belonging to another intent in the same channel.
    return creem.checkout_url(product_id, session.get('id'))


def bind_session(checkout_id, session):
    with session_factory()() as db:
        row = db.get(BillingCheckout, checkout_id)
        require(row is not None, 'BILLING_ACCOUNT_UNBOUND')
        locked_user(db, row.owner_id)
        db.refresh(row)
        if row.provider == 'stripe':
            stripe.environment(session)
            price = db.get(BillingPrice, row.price_id)
            require(session.get('mode') == ('payment' if price.interval == 'once' else 'subscription') and stripe.intent_id(session) == row.id
                and session.get('client_reference_id') == row.id)
            status = {'open': 'open', 'expired': 'expired', 'complete': 'completed'}.get(session.get('status'), 'unknown')
            customer = session.get('customer')
        else:
            canonical_url = creem_session_identity(db, row, session)
            status = {'pending': 'open', 'completed': 'completed', 'expired': 'expired'}.get(session.get('status'), 'unknown')
            customer = creem.object_id(session.get('customer'))
            require(session.get('customer') is None or isinstance(customer, str) and bool(customer))
            require(session.get('status') != 'completed' or customer is not None)
        # Unpaid Creem sessions may omit the customer, even when its ID was sent.
        # Only verified pending/expired sessions qualify; fulfillment must confirm it.
        unassigned_creem_customer = (row.provider == 'creem' and session.get('status') in ('pending', 'expired')
            and session.get('customer') is None)
        require(row.environment == provider_environment(row.provider) and row.session_id in (None, session['id'])
            and (not row.customer_id or row.customer_id == customer or unassigned_creem_customer))
        if row.provider == 'creem':
            # GET omits the URL. For a lost POST, reconstruct only after the
            # product, checkout metadata, environment and owner were validated.
            row.checkout_url = (creem.hosted_url(session['checkout_url']) if session.get('checkout_url')
                else row.checkout_url or canonical_url)
            session = {**session, 'checkout_url': row.checkout_url}
        row.session_id = session['id']
        if row.status != 'completed':
            row.status = status
        row.last_checked_at, row.error_code = now(), None
        if row.provider == 'creem':
            try:
                # This is the same row update otherwise autoflushed by checkout_order.
                db.flush()
            except IntegrityError:
                raise BillingError('BILLING_BINDING_MISMATCH') from None
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
    created_session = None
    try:
        if row.provider == 'creem':
            # A previous dispatch is durable even when its response was lost.
            # Do not let a new preflight failure downgrade that unknown payment.
            require(row.last_checked_at is None, 'CREEM_CHECKOUT_UNCERTAIN')
            product_id = binding.trial_product_id if row.trial else binding.product_id
            creem.approved_product(creem.call('GET', '/products/' + product_id), product_id, price,
                revision.trial_days if row.trial else 0)
            # Replaying request_id can return a different checkout resource.
            # Persist dispatch before POST; recover by known ID, never by replaying it.
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
            created_session = session
        else:
            params = {'mode': 'payment' if price.interval == 'once' else 'subscription', 'client_reference_id': row.id, 'metadata': metadata,
                'line_items': [{'price': binding.provider_price_id, 'quantity': 1}], 'payment_method_types': ['card'],
                'currency': price.currency, 'adaptive_pricing': {'enabled': False},
                'success_url': urljoin(row.return_url, '/payment/success/'), 'cancel_url': row.return_url,
                'expires_at': int(row.expires_at.replace(tzinfo=timezone.utc).timestamp())}
            if price.interval == 'once':
                params['payment_intent_data'] = {'metadata': metadata, 'capture_method': 'automatic'}
                if not row.customer_id:
                    params['customer_creation'] = 'always'
            else:
                params.update(payment_method_collection='always', subscription_data={
                    'metadata': metadata, **({'trial_period_days': revision.trial_days} if row.trial else {})})
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
                with session_factory()() as db:
                    locked_user(db, row.owner_id)
                    current = db.get(BillingCheckout, row.id)
                    # A competing preflight can have ended this untouched intent.
                    # Never dispatch it after another caller was allowed to restart.
                    require(current.status not in ('failed', 'expired'),
                        'BILLING_PURCHASE_RETRY_ALLOWED' if price.interval == 'once' else 'BILLING_CHECKOUT_EXPIRED')
                    if current.session_id is None:
                        current.status, current.last_checked_at = 'unknown', now()
                    db.commit()
                sent = True
                session = stripe.call('checkout.sessions', 'create', params=params, options={'idempotency_key': 'checkout:' + row.id})
        return bind_session(row.id, session)
    except BillingError as exc:
        with session_factory()() as db:
            locked_user(db, row.owner_id)
            current = db.get(BillingCheckout, row.id)
            if current.status in PENDING and current.session_id is None:
                if created_session is not None:
                    try:
                        creem_session_identity(db, current, created_session)
                        with db.begin_nested():
                            # Only retain the GET locator. Customer/URL validation
                            # still failed; keep the dispatch unknown and unfulfilled.
                            current.session_id = created_session['id']
                            db.flush()
                    except (BillingError, IntegrityError):
                        # Invalid or already-owned receipts cannot mask the first error.
                        pass
                already_dispatched = (not sent and current.status == 'unknown'
                    and current.last_checked_at is not None)
                uncertain = (created_session is not None or already_dispatched
                    or exc.code in ('BILLING_CHECKOUT_UNCERTAIN', 'CREEM_CHECKOUT_UNCERTAIN')
                    or (sent and (row.provider == 'stripe' or exc.uncertain or exc.code != 'CREEM_UNAVAILABLE')))
                # A local dispatch guard observes nothing new at the provider.
                # Retain the actual failure that made the original result unknown.
                error = (current.error_code if already_dispatched and exc.code == 'CREEM_CHECKOUT_UNCERTAIN'
                    and current.error_code else exc.code)
                current.status, current.error_code, current.last_checked_at = ('unknown' if uncertain else 'failed'), error, now()
                order = checkout_order(db, current)
                order.error_code = error
                transition(db, order, 'unknown' if uncertain else 'failed', 'checkout_error', detail={'error_code': error})
            db.commit()
        raise


def fulfilled_checkout(row):
    return {'fulfilled': True, 'checkout_url': None, 'checkout_id': row.id,
        'provider': row.provider, 'environment': row.environment, 'trial': False}


def start_checkout(owner_id, price_id, provider, idempotency_key=None):
    with session_factory()() as db:
        user = locked_user(db, owner_id)
        price = db.get(BillingPrice, price_id)
        require(price is not None, 'BILLING_PLAN_UNAVAILABLE')
        require(idempotency_key is None or 1 <= len(idempotency_key) <= 128 and idempotency_key.isascii(),
            'BILLING_IDEMPOTENCY_KEY_INVALID')
        require(price.interval != 'once' or idempotency_key, 'BILLING_IDEMPOTENCY_KEY_REQUIRED')
        replay = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == owner_id,
            BillingCheckout.idempotency_key == idempotency_key)) if idempotency_key else None
        if replay:
            require(replay.price_id == price_id and replay.provider == provider, 'BILLING_CHECKOUT_PRICE_CONFLICT')
            if not db.scalar(select(BillingCheckout.id).where(BillingCheckout.id == replay.id, pending_checkout_condition())):
                if replay.status == 'completed' and price.interval == 'once':
                    return fulfilled_checkout(replay)
                if price.interval == 'once' and replay.status in ('expired', 'failed'):
                    raise BillingError('BILLING_PURCHASE_RETRY_ALLOWED')
                raise BillingError('BILLING_CHECKOUT_COMPLETED' if replay.status == 'completed' else 'BILLING_CHECKOUT_EXPIRED')
        require(provider_enabled(provider), 'BILLING_DISABLED')
        account = db.get(BillingAccount, owner_id)
        if account is None:
            account = BillingAccount(owner_id=owner_id)
            db.add(account)
        customer = customer_for(db, owner_id, provider)
        selected = subscription_checkout(db, owner_id) if price.interval != 'once' else None
        row = replay if price.interval == 'once' else selected[0] if selected else None
        require(not replay or row and replay.id == row.id, 'BILLING_CHECKOUT_PRICE_CONFLICT')
        if row is None:
            if price.interval != 'once':
                gift = gift_json(user)
                require(not gift or gift['state'] == 'expired', 'BILLING_GIFT_ACTIVE')
                active = db.scalar(select(BillingSubscription).where(BillingSubscription.owner_id == owner_id,
                    BillingSubscription.status.in_(LIVE_SUBSCRIPTIONS)).limit(1))
                require(active is None and not active_terms(db, user.id), 'BILLING_SUBSCRIPTION_EXISTS')
            require(provider == default_provider(db), 'BILLING_CHANNEL_UNAVAILABLE')
            require(price and price.environment == provider_environment(provider) and price.status == 'active', 'BILLING_PLAN_UNAVAILABLE')
            binding = db.scalar(select(BillingPriceBinding).where(BillingPriceBinding.price_id == price_id,
                BillingPriceBinding.provider == provider, BillingPriceBinding.environment == price.environment,
                BillingPriceBinding.status == 'active'))
            require(binding, 'BILLING_CHANNEL_UNAVAILABLE')
            revision = db.get(BillingPlanRevision, price.plan_revision_id)
            if price.interval == 'once':
                require(revision.quota_pages > 0 and revision.service_plan_id and not revision.trial_days
                    and revision.trial_classic_pages == 0 and revision.monthly_classic_pages == 0, 'BILLING_PLAN_UNAVAILABLE')
            row = BillingCheckout(id=uid(), owner_id=owner_id, provider=provider, binding_id=binding.id,
                environment=price.environment, price_id=price.id, customer_id=customer.customer_id if customer else None,
                idempotency_key=idempotency_key, return_url=getattr(settings(), provider + '_return_url'),
                trial=price.interval != 'once' and account.trial_used_at is None and revision.trial_days > 0,
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
        with session_factory()() as db:
            row = db.get(BillingCheckout, checkout_id)
            if db.get(BillingPrice, row.price_id).interval == 'once':
                require(not db.scalar(select(BillingCheckout.id).where(BillingCheckout.id == row.id,
                    pending_checkout_condition())), 'BILLING_PURCHASE_PROCESSING')
                return fulfilled_checkout(row)
        raise BillingError('BILLING_CHECKOUT_COMPLETED')
    require(session['status'] != 'processing', 'BILLING_PURCHASE_PROCESSING')
    if session['status'] == 'expired':
        with session_factory()() as db:
            if db.get(BillingPrice, price_id).interval == 'once':
                raise BillingError('BILLING_PURCHASE_RETRY_ALLOWED')
    require(session['status'] in ('open', 'pending'), 'BILLING_CHECKOUT_EXPIRED')
    url = stripe.hosted_url(session['url']) if provider == 'stripe' else creem.hosted_url(session['checkout_url'])
    return {'checkout_url': url, 'checkout_id': checkout_id, 'trial': trial,
        'environment': provider_environment(provider), 'provider': provider}


def sync_owner(owner_id):
    from .billing_sync import sync_session, sync_subscription
    enabled = [provider for provider in ('stripe', 'creem') if provider_enabled(provider)]
    with session_factory()() as db:
        locked_user(db, owner_id)
        # A newer quota purchase must never hide an existing subscription from reconciliation.
        sub = current_subscription(db, owner_id)
        sub_id = sub.id if sub and sub.synced_at <= now() - timedelta(seconds=10) else None
        sub_provider = sub.provider if sub else None
        if sub_id:
            sub.synced_at = now()
        selected = subscription_checkout(db, owner_id)
        pending = [selected[0]] if selected else []
        threshold = now() - timedelta(seconds=10)
        pending.extend(db.scalars(select(BillingCheckout).join(BillingPrice, BillingPrice.id == BillingCheckout.price_id)
            .where(BillingCheckout.owner_id == owner_id, BillingPrice.interval == 'once', pending_checkout_condition(),
                BillingCheckout.provider.in_(enabled),
                or_(BillingCheckout.last_checked_at.is_(None), BillingCheckout.last_checked_at <= threshold))
            .order_by(func.coalesce(BillingCheckout.last_checked_at, BillingCheckout.created_at),
                BillingCheckout.created_at, BillingCheckout.id).limit(2)))
        purchase = db.scalar(select(BillingCheckout).join(BillingPrice, BillingPrice.id == BillingCheckout.price_id)
            .where(BillingCheckout.owner_id == owner_id, BillingPrice.interval == 'once',
                BillingCheckout.provider.in_(enabled),
                BillingCheckout.status == 'completed', ~pending_checkout_condition())
            .order_by(BillingCheckout.created_at.desc()).limit(1))
        rows = {row.id: row for row in (*pending, purchase) if row and (
            row.last_checked_at is None or row.last_checked_at <= threshold)}
        for row in rows.values():
            # Do not overwrite the Creem dispatch sentinel before its first request.
            if row.session_id or row.last_checked_at is not None:
                row.last_checked_at = now()
        db.commit()
    errors = []
    if sub_id:
        try:
            sync_subscription(remote_id(sub_id), provider=sub_provider)
        except BillingError as exc:
            errors.append(exc)
    for row in rows.values():
        try:
            # Creem sync already reads and binds a known session, then verifies
            # its payment under the owner lock. Recovery would repeat that read.
            session_id = (row.session_id if row.provider == 'creem' and row.session_id
                else recover_checkout(row.id)['id'])
            sync_session(session_id, provider=row.provider)
        except BillingError as exc:
            errors.append(exc)
    if errors:
        raise errors[0]
