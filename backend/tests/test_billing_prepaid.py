"""Prepaid membership through isolated Stripe/Creem payment fixtures, never live APIs."""
import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select

from conftest import login
from test_billing_purchases import purchase, buy, notify, paid, reverse, historical_checkout


@pytest.fixture
def prepaid(purchase, request):
    from app.billing_models import BillingPlanRevision, BillingPrice
    from app.db import session_factory
    state = purchase
    state['interval'] = getattr(request, 'param', 'quarter')
    with session_factory()() as db:
        revision = db.get(BillingPlanRevision, 'plus-v1')
        revision.monthly_classic_pages = 300
        revision.trial_days, revision.trial_classic_pages = 0, 0
        revision.hourly_image_limit = 1200
        price = db.get(BillingPrice, 'purchase-price')
        price.plan_id, price.plan_revision_id = 'plus', revision.id
        price.interval, price.billing_type = state['interval'], 'onetime'
        db.commit()
    return state


def membership_records():
    from app.billing_models import BillingOrder, BillingTerm
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    with session_factory()() as db:
        return (
            list(db.scalars(select(BillingOrder).order_by(BillingOrder.created_at))),
            list(db.scalars(select(BillingTerm).order_by(BillingTerm.starts_at))),
            list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.source == 'subscription')
                .order_by(QuotaPeriod.starts_at))),
        )


def entitlement_at(state, at, owner_id=None):
    from app.db import session_factory
    from app.entitlements import entitlements_json
    from app.models import User
    with session_factory()() as db:
        return entitlements_json(db, db.get(User, owner_id or state['owner']), at)


def existing_recurring_subscription(db, state):
    from app.billing_models import BillingCheckout, BillingPriceBinding, BillingSubscription
    db.add(BillingPriceBinding(id='existing-binding', price_id='plus-month-v1', provider=state['provider'],
        environment='test', product_id='prod_existing',
        provider_price_id='price_existing' if state['provider'] == 'stripe' else None, status='active'))
    db.flush()
    row = BillingCheckout(id='existing-recurring', owner_id=state['owner'], provider=state['provider'],
        environment='test', price_id='plus-month-v1', binding_id='existing-binding', trial=False,
        return_url='https://comics.example/account/', status='completed', expires_at=state['at'])
    db.add(row)
    db.flush()
    db.add(BillingSubscription(id=state['provider'] + ':test:sub_existing', owner_id=state['owner'],
        checkout_id=row.id, provider=state['provider'], environment='test', customer_id='cust_pagebuyer',
        price_id=row.price_id, binding_id=row.binding_id, status='active'))


@pytest.fixture
def membership_payment_choices(prepaid, monkeypatch):
    """Both membership payment types plus an unrelated fixed-page purchase."""
    from app import creem_client, stripe_client
    from app.billing_models import BillingPrice, BillingPriceBinding
    from app.db import session_factory
    state = prepaid
    remote_prices, remote_products = {}, {}
    specs = [
        ('plus-month-v1', 'plus', 'plus-v1', 'month', 'recurring', 'prod_recurring', 'price_recurring'),
        ('separate-pack', 'pages100', 'pages100-v1', 'once', 'onetime', 'prod_extrapack', 'price_extrapack'),
    ]
    with session_factory()() as db:
        for price_id, plan, revision, interval, billing_type, product_id, provider_price_id in specs:
            price = db.get(BillingPrice, price_id)
            if price is None:
                price = BillingPrice(id=price_id, plan_id=plan, plan_revision_id=revision,
                    environment='test', currency='usd', interval=interval, billing_type=billing_type)
                db.add(price)
            price.status, price.unit_amount = 'active', 399
            db.flush()
            db.add(BillingPriceBinding(id=price_id + '-binding', price_id=price_id, provider=state['provider'],
                environment='test', product_id=product_id,
                provider_price_id=provider_price_id if state['provider'] == 'stripe' else None, status='active'))
            remote_prices[provider_price_id] = {**state['price'], 'id': provider_price_id, 'product': product_id,
                'type': 'recurring' if billing_type == 'recurring' else 'one_time',
                'recurring': {'interval': 'month', 'interval_count': 1, 'usage_type': 'licensed'}
                    if billing_type == 'recurring' else None}
            remote_products['/products/' + product_id] = {**state['product'], 'id': product_id,
                'billing_type': billing_type, 'billing_period': 'every-month' if billing_type == 'recurring' else 'once'}
        db.commit()
    original_stripe, original_creem = stripe_client.call, creem_client.call

    def stripe_call(resource, action, *args, **kwargs):
        if resource == 'prices' and args[0] in remote_prices:
            return copy.deepcopy(remote_prices[args[0]])
        return original_stripe(resource, action, *args, **kwargs)

    def creem_call(method, path, *, params=None, body=None):
        if method == 'GET' and path in remote_products:
            return copy.deepcopy(remote_products[path])
        return original_creem(method, path, params=params, body=body)

    monkeypatch.setattr(stripe_client, 'call', stripe_call)
    monkeypatch.setattr(creem_client, 'call', creem_call)
    return state


def buy_membership_type(state, billing_type, key):
    return state['client'].post('/v1/billing/checkouts', headers={**state['auth'], 'Idempotency-Key': key},
        json={'provider': state['provider'], 'price_id': 'purchase-price' if billing_type == 'onetime' else 'plus-month-v1'})


@pytest.mark.parametrize('start,end', [
    (None, datetime(2026, 4, 1)), (datetime(2026, 1, 1), None),
    (datetime(2026, 1, 1), datetime(2026, 1, 1)), (datetime(2026, 4, 1), datetime(2026, 1, 1)),
])
def test_membership_term_invalid_period_uses_provider_neutral_error(start, end):
    from app.billing_grants import grant_term
    from app.billing_providers import BillingError
    with pytest.raises(BillingError, match='^BILLING_PERIOD_MISSING$'):
        grant_term(None, None, None, None, 'paid', start, end)


@pytest.mark.parametrize('sub,order_id', [(None, None), (object(), 'order')])
def test_membership_term_still_requires_exactly_one_payment_source(sub, order_id):
    from app.billing_grants import grant_term
    from app.billing_providers import BillingError
    with pytest.raises(BillingError, match='^BILLING_TERM_SOURCE_INVALID$'):
        grant_term(None, None, sub, None, 'paid', datetime(2026, 1, 1), datetime(2026, 4, 1),
            billing_order_id=order_id)


def test_membership_term_replay_still_rejects_changed_period(prepaid):
    from app.billing_grants import grant_term
    from app.billing_models import BillingPrice, BillingTerm
    from app.billing_providers import BillingError
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.models import User
    assert buy(prepaid).status_code == 200
    paid(prepaid)
    with session_factory()() as db:
        term = db.scalar(select(BillingTerm))
        user, price = db.get(User, prepaid['owner']), db.get(BillingPrice, term.price_id)
        assert grant_term(db, user, None, price, 'paid', term.starts_at, term.ends_at,
            billing_order_id=term.billing_order_id) is term
        with pytest.raises(BillingError, match='^BILLING_TERM_CONFLICT$'):
            grant_term(db, user, None, price, 'paid', term.starts_at, term.ends_at + timedelta(seconds=1),
                billing_order_id=term.billing_order_id)
        assert db.scalar(select(func.count()).select_from(BillingTerm)) == 1
        assert db.scalar(select(func.count()).select_from(QuotaPeriod).where(QuotaPeriod.source == 'subscription')) == 3


@pytest.mark.parametrize('prepaid', ['quarter', 'year'], indirect=True)
@pytest.mark.parametrize('year,february_days', [(2023, 28), (2024, 29)])
def test_prepaid_uses_same_membership_and_calendar_month_buckets(prepaid, year, february_days):
    from app.billing_access import first_subscription
    from app.billing_models import BillingAccount, BillingCheckout, BillingInvoice, BillingPrice, BillingSubscription
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.models import Ledger
    state = prepaid
    assert buy(state).status_code == 200
    state['at'] = datetime(year, 1, 31, 12, 34, 56)
    with session_factory()() as db:
        db.scalar(select(BillingCheckout)).created_at = state['at'] - timedelta(minutes=1)
        db.commit()
    paid(state)
    orders, terms, buckets = membership_records()
    count = 3 if state['interval'] == 'quarter' else 12
    end = datetime(year, 4, 30, 12, 34, 56) if count == 3 else datetime(year + 1, 1, 31, 12, 34, 56)
    assert len(orders) == len(terms) == 1 and len(buckets) == count
    term = terms[0]
    assert term.kind == 'paid' and term.subscription_id is None and term.invoice_id is None
    assert term.billing_order_id == orders[0].id and term.price_id == 'purchase-price'
    assert term.starts_at == orders[0].paid_at == state['at'] and term.ends_at == end
    assert buckets[0].starts_at == state['at']
    assert buckets[0].ends_at == buckets[1].starts_at == datetime(year, 2, february_days, 12, 34, 56)
    assert buckets[1].ends_at == buckets[2].starts_at == datetime(year, 3, 31, 12, 34, 56)
    assert buckets[-1].ends_at == end
    assert all(bucket.granted == 300 and bucket.billing_term_id == term.id for bucket in buckets)
    assert all(bucket.source == 'subscription' and bucket.billing_order_id is None for bucket in buckets)
    assert all(left.ends_at == right.starts_at for left, right in zip(buckets, buckets[1:]))
    with session_factory()() as db:
        price = db.get(BillingPrice, term.price_id)
        recurring = db.get(BillingPrice, 'plus-month-v1')
        assert (price.plan_id, price.plan_revision_id) == (recurring.plan_id, recurring.plan_revision_id)
        assert db.get(BillingAccount, state['owner']).trial_used_at is None
        assert db.scalar(select(func.count()).select_from(BillingSubscription)) == 0
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 0
        assert db.scalar(select(func.count()).select_from(QuotaPeriod).where(QuotaPeriod.source == 'purchase')) == 0
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'purchase')) == 0
        assert first_subscription(db, state['owner'], state['at'])[0].id == buckets[0].id
        assert first_subscription(db, state['owner'], buckets[1].starts_at)[0].id == buckets[1].id
        assert first_subscription(db, state['owner'], end) is None
    for bucket in buckets:
        rights = entitlement_at(state, bucket.starts_at)
        assert rights['plan'] == rights['service_plan'] == 'plus'
        assert rights['plan_name'] == 'PLUS'
        assert rights['subscription_quota']['available'] == 300
        assert rights['subscription_quota']['resets_at'] == bucket.ends_at.isoformat() + 'Z'
        assert rights['purchase_quota']['available'] == 0
        assert rights['hourly_image_rate_limit']['limit'] == 1200
    assert entitlement_at(state, state['at'] - timedelta(seconds=1))['plan'] == 'free'
    assert entitlement_at(state, end)['plan'] == 'free'


def test_prepaid_stable_intent_and_status_do_not_create_subscription(prepaid):
    from app.billing_models import BillingAccount, BillingCheckout, BillingSubscription
    from app.billing_sync import sync_session
    from app.db import session_factory
    state = prepaid
    missing_key = state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'provider': state['provider'], 'price_id': 'purchase-price'})
    assert missing_key.status_code == 409
    assert missing_key.json()['error']['code'] == 'BILLING_IDEMPOTENCY_KEY_REQUIRED'
    first = buy(state)
    assert first.status_code == 200, first.text
    assert first.json() == buy(state).json()
    assert first.json()['trial'] is False and len(state['posts']) == 1
    assert not membership_records()[1]
    status = state['client'].get('/v1/billing/status', headers=state['auth']).json()
    assert status['subscription_checkout'] is None and status['prepaid_membership'] is None
    assert status['pending_checkout']['id'] == first.json()['checkout_id']
    assert status['pending_checkout']['price']['billing_type'] == 'onetime'
    session = paid(state)
    sync_session(session['id'], provider=state['provider'])
    replay = buy(state)
    assert replay.status_code == 200 and replay.json()['fulfilled'] is True
    assert replay.json()['checkout_url'] is None and len(state['posts']) == 1
    orders, terms, buckets = membership_records()
    assert len(orders) == len(terms) == 1 and len(buckets) == 3
    status = state['client'].get('/v1/billing/status', headers=state['auth']).json()
    assert status['subscription'] is None and status['provider'] is None
    assert status['subscription_checkout'] is None
    assert status['pending_checkout'] is None
    assert status['prepaid_membership']['price']['id'] == 'purchase-price'
    assert status['prepaid_membership']['starts_at'] == terms[0].starts_at.isoformat() + 'Z'
    assert status['prepaid_membership']['ends_at'] == terms[0].ends_at.isoformat() + 'Z'
    with session_factory()() as db:
        assert db.get(BillingAccount, state['owner']).trial_used_at is None
        assert not db.scalar(select(BillingCheckout.trial))
        assert db.scalar(select(func.count()).select_from(BillingSubscription)) == 0
    if state['provider'] == 'stripe':
        assert state['posts'][0]['mode'] == 'payment'
        assert 'subscription_data' not in state['posts'][0]


@pytest.mark.parametrize('prepaid', ['quarter', 'year'], indirect=True)
@pytest.mark.parametrize('distinct_keys', [False, True], ids=['same-key', 'different-tabs'])
def test_prepaid_concurrent_same_intent_and_notification_replay_grant_once(prepaid, distinct_keys):
    from app.billing_checkout import start_checkout
    from app.billing_models import BillingCheckoutAlias
    from app.billing_providers import BillingError
    from app.billing_sync import sync_session
    from app.db import session_factory
    state = prepaid
    keys = ['concurrent-prepaid-' + str(index if distinct_keys else 0) for index in range(8)]

    def start(key):
        try:
            return start_checkout(state['owner'], 'purchase-price', state['provider'], key)
        except BillingError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(start, keys))
    assert any(isinstance(result, dict) for result in results)
    assert all(isinstance(result, dict) or state['provider'] == 'creem' and result == 'CREEM_CHECKOUT_UNCERTAIN'
        for result in results)
    assert len(state['sessions']) == len(membership_records()[0]) == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingCheckoutAlias)) == (7 if distinct_keys else 0)
    session = paid(state)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: sync_session(session['id'], provider=state['provider']), range(8)))
    orders, terms, buckets = membership_records()
    assert len(orders) == len(terms) == 1 and len(buckets) == (3 if state['interval'] == 'quarter' else 12)
    assert all(bucket.used == bucket.reserved == 0 for bucket in buckets)
    assert all(buy(state, key).json()['fulfilled'] is True for key in keys)
    assert len(state['sessions']) == 1


def test_prepaid_concurrent_independent_payments_serialize_membership_terms(prepaid, monkeypatch):
    from app import billing_api
    from app.billing_sync import sync_session
    state = prepaid
    assert buy(state, 'parallel-prepaid-1').status_code == 200
    first = paid(state, sync=False)
    # Old independently issued links must still grant independently.
    historical_checkout(state, 'parallel-prepaid-2')
    second = paid(state, sync=False)
    # The durable signed receipts exist before either worker starts. This keeps
    # Creem's trusted payment time while exercising concurrent first grants.
    monkeypatch.setattr(billing_api, 'process_event', lambda _: None)
    kind = 'checkout.session.completed' if state['provider'] == 'stripe' else 'checkout.completed'
    for index, session in enumerate((first, second)):
        assert notify(state, kind, session, 'evt_parallelprepaid' + str(index)).status_code == 200
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda session: sync_session(session['id'], provider=state['provider']), [first, second] * 4))
    orders, terms, buckets = membership_records()
    assert len(orders) == len(terms) == 2 and len(buckets) == 6
    assert all(order.status == 'paid' for order in orders)
    assert terms[0].starts_at == state['at'] and terms[0].ends_at == terms[1].starts_at
    assert len({term.billing_order_id for term in terms}) == 2
    assert entitlement_at(state, state['at'])['subscription_quota']['available'] == 300


def test_prepaid_unlimited_membership_reuses_term_without_empty_monthly_buckets(prepaid):
    from app.billing_models import BillingPlanRevision
    from app.db import session_factory
    state = prepaid
    with session_factory()() as db:
        db.get(BillingPlanRevision, 'plus-v1').monthly_classic_pages = None
        db.commit()
    assert buy(state).status_code == 200
    paid(state)
    orders, terms, buckets = membership_records()
    assert len(orders) == len(terms) == 1 and not buckets
    rights = entitlement_at(state, state['at'])
    assert rights['plan'] == 'plus' and rights['subscription_quota']['unlimited'] is True
    assert rights['subscription_quota']['available'] == 0
    assert buy(state).json()['fulfilled'] is True


def test_prepaid_requires_verified_payment_time(prepaid):
    from app.billing_providers import BillingError
    from app.billing_sync import sync_session
    state = prepaid
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    if state['provider'] == 'stripe':
        charge = state['charges'][state['payments'][session['payment_intent']]['latest_charge']]
        created = charge.pop('created')
        with pytest.raises(BillingError, match='BILLING_PAYMENT_TIME_PENDING'):
            sync_session(session['id'], provider='stripe')
        charge['created'] = created
    else:
        sync_session(session['id'], provider='creem')
        order = membership_records()[0][0]
        assert order.status == 'processing' and order.paid_at is None
    assert not membership_records()[1] and not membership_records()[2]
    kind = 'checkout.session.completed' if state['provider'] == 'stripe' else 'checkout.completed'
    assert notify(state, kind, session).status_code == 200
    assert membership_records()[1][0].starts_at == state['at']


@pytest.mark.parametrize('kind,amount', [('refund', 399), ('refund', 99), ('dispute', 399)])
def test_prepaid_reversal_preserves_usage_and_never_restores(prepaid, kind, amount):
    from app.billing_access import first_subscription
    from app.billing_sync import sync_session
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    state = prepaid
    assert buy(state).status_code == 200
    session = paid(state)
    before = membership_records()[2]
    with session_factory()() as db:
        first = db.get(QuotaPeriod, before[0].id)
        first.used, first.reserved = 12, 3
        db.commit()
    assert reverse(state, session, kind, amount, stale_payment=True).status_code == 200
    orders, terms, buckets = membership_records()
    revoked = kind == 'dispute' or amount == 399
    assert orders[0].status == ('disputed' if kind == 'dispute' else 'refunded' if revoked else 'partially_refunded')
    assert (terms[0].revoked_at is not None) == revoked
    # Subscription buckets retain their audit shape. Existing admission checks
    # their source term, so revocation is shared with recurring memberships.
    assert all(bucket.revoked_at is None for bucket in buckets)
    assert [(bucket.id, bucket.starts_at, bucket.ends_at, bucket.granted) for bucket in buckets] == [
        (bucket.id, bucket.starts_at, bucket.ends_at, bucket.granted) for bucket in before]
    assert (buckets[0].used, buckets[0].reserved) == (12, 3)
    sync_session(session['id'], provider=state['provider'])
    assert membership_records()[1][0].revoked_at == terms[0].revoked_at
    rights = entitlement_at(state, state['at'])
    assert rights['plan'] == ('free' if revoked else 'plus')
    assert rights['subscription_quota']['available'] == (0 if revoked else 285)
    if revoked:
        with session_factory()() as db:
            assert all(first_subscription(db, state['owner'], bucket.starts_at) is None for bucket in buckets)


@pytest.mark.parametrize('kind', ['refund', 'dispute'])
def test_prepaid_reversal_before_payment_notification_never_grants(prepaid, kind):
    state = prepaid
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    assert reverse(state, session, kind, stale_payment=True).status_code == 200
    orders, terms, buckets = membership_records()
    assert orders[0].status == ('refunded' if kind == 'refund' else 'disputed')
    assert not terms and not buckets
    event = 'checkout.session.completed' if state['provider'] == 'stripe' else 'checkout.completed'
    assert notify(state, event, session).status_code == 200
    assert not membership_records()[1] and not membership_records()[2]
    assert buy(state).json()['fulfilled'] is True


def test_prepaid_manual_renewal_extends_without_duplicate_months(prepaid):
    state = prepaid
    assert buy(state).status_code == 200
    first_session = paid(state)
    first = membership_records()[1][0]
    assert buy(state, 'manual-renewal').status_code == 200
    paid(state)
    orders, terms, buckets = membership_records()
    assert len(orders) == len(terms) == 2 and len(buckets) == 6
    assert terms[0].id == first.id and terms[0].starts_at == first.starts_at and terms[0].ends_at == first.ends_at
    assert terms[1].starts_at == first.ends_at
    status = state['client'].get('/v1/billing/status', headers=state['auth']).json()['prepaid_membership']
    assert status['starts_at'] == first.starts_at.isoformat() + 'Z'
    assert status['ends_at'] == first.ends_at.isoformat() + 'Z'
    assert status['paid_through'] == terms[1].ends_at.isoformat() + 'Z'
    assert entitlement_at(state, state['at'])['subscription_quota']['available'] == 300
    assert entitlement_at(state, terms[1].starts_at)['subscription_quota']['available'] == 300
    # Refunding the earlier order does not revoke or move the already-paid renewal.
    assert reverse(state, first_session, 'refund').status_code == 200
    revised = membership_records()[1]
    assert revised[0].revoked_at is not None and revised[1].revoked_at is None
    assert (revised[1].starts_at, revised[1].ends_at) == (terms[1].starts_at, terms[1].ends_at)


def test_prepaid_repurchase_does_not_wait_for_revoked_term(prepaid):
    state = prepaid
    assert buy(state).status_code == 200
    session = paid(state)
    assert reverse(state, session, 'refund').status_code == 200
    assert buy(state, 'after-revocation').status_code == 200
    paid(state)
    terms = membership_records()[1]
    assert len(terms) == 2 and all(term.starts_at == state['at'] for term in terms)
    assert len([term for term in terms if term.revoked_at is None]) == 1


def test_prepaid_owner_scoped_replay_and_status_are_private(prepaid):
    state = prepaid
    assert buy(state).status_code == 200
    paid(state)
    other = login(state['client'], 'another-prepaid-buyer')
    status = state['client'].get('/v1/billing/status', headers=other).json()
    assert status['prepaid_membership'] is None and status['subscription_checkout'] is None
    rights = state['client'].get('/v1/me/entitlements', headers=other).json()
    assert rights['plan'] == 'free' and rights['subscription_quota']['available'] == 0
    response = state['client'].post('/v1/billing/checkouts', headers={**other, 'Idempotency-Key': 'purchase-intent-1'},
        json={'provider': state['provider'], 'price_id': 'purchase-price'})
    assert response.status_code == 200 and response.json().get('fulfilled') is not True
    assert len(state['sessions']) == 2 and len(membership_records()[1]) == 1


def test_prepaid_does_not_unlock_future_month_when_current_month_is_exhausted(prepaid):
    from app.billing_access import first_subscription
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    state = prepaid
    assert buy(state).status_code == 200
    paid(state)
    buckets = membership_records()[2]
    with session_factory()() as db:
        db.get(QuotaPeriod, buckets[0].id).used = 300
        db.commit()
        assert first_subscription(db, state['owner'], state['at']) is None
        assert first_subscription(db, state['owner'], buckets[1].starts_at)[0].id == buckets[1].id
    assert entitlement_at(state, state['at'])['subscription_quota']['available'] == 0
    assert entitlement_at(state, buckets[1].starts_at)['subscription_quota']['available'] == 300


def test_prepaid_pending_link_paid_during_gift_is_queued_after_gift(prepaid):
    from app.db import session_factory
    from app.models import User
    state = prepaid
    assert buy(state).status_code == 200
    gift_end = state['at'] + timedelta(days=15)
    with session_factory()() as db:
        user = db.get(User, state['owner'])
        user.membership_id = 'gift-after-checkout'
        user.plus_started_at, user.plus_expires_at = state['at'] - timedelta(days=1), gift_end
        user.plus_timezone = 'UTC'
        db.commit()
    assert buy(state).status_code == 200 and len(state['posts']) == 1
    paid(state)
    term = membership_records()[1][0]
    assert term.starts_at == gift_end
    assert buy(state).json()['fulfilled'] is True
    status = state['client'].get('/v1/billing/status', headers=state['auth']).json()['prepaid_membership']
    assert status['starts_at'] == gift_end.isoformat() + 'Z'


def test_prepaid_blocks_new_recurring_subscription_until_paid_time_ends(prepaid):
    from app.billing_models import BillingPrice, BillingPriceBinding
    from app.db import session_factory
    state = prepaid
    assert buy(state).status_code == 200
    paid(state)
    with session_factory()() as db:
        db.get(BillingPrice, 'plus-month-v1').status = 'active'
        db.add(BillingPriceBinding(id='recurring-binding', price_id='plus-month-v1', provider=state['provider'],
            environment='test', product_id='prod_recurring',
            provider_price_id='price_recurring' if state['provider'] == 'stripe' else None, status='active'))
        db.commit()
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'provider': state['provider'], 'price_id': 'plus-month-v1'})
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'BILLING_PREPAID_ACTIVE'
    assert len(state['posts']) == 1


@pytest.mark.parametrize('existing', ['gift', 'recurring'])
def test_prepaid_checkout_blocks_existing_membership_but_not_page_packs(prepaid, existing):
    from app.billing_models import BillingPrice
    from app.db import session_factory
    from app.models import User
    state = prepaid
    with session_factory()() as db:
        if existing == 'gift':
            user = db.get(User, state['owner'])
            user.membership_id = 'existing-gift'
            user.plus_started_at = state['at'] - timedelta(days=1)
            user.plus_expires_at = state['at'] + timedelta(days=29)
            user.plus_timezone = 'UTC'
        else:
            existing_recurring_subscription(db, state)
        db.commit()
    response = buy(state)
    assert response.status_code == 409, response.text
    assert response.json()['error']['code'] == ('BILLING_GIFT_ACTIVE' if existing == 'gift' else 'BILLING_SUBSCRIPTION_EXISTS')
    assert not state['posts']
    # The same isolated provider fixture now describes the unrelated fixed-page
    # product, proving that membership exclusion does not become a payment lock.
    with session_factory()() as db:
        price = db.get(BillingPrice, 'purchase-price')
        price.plan_id, price.plan_revision_id, price.interval = 'pages100', 'pages100-v1', 'once'
        db.commit()
    assert buy(state, 'pack-while-member').status_code == 200
    paid(state)
    assert not membership_records()[1]


def test_prepaid_pending_intent_is_blocked_by_late_subscription_but_paid_replay_is_safe(prepaid):
    from app.db import session_factory
    state = prepaid
    original = buy(state)
    assert original.status_code == 200
    # Historical mixed pending links must not be offered again after one starts
    # automatic renewal. A payment that already happened still gets its receipt.
    with session_factory()() as db:
        existing_recurring_subscription(db, state)
        db.commit()
    response = buy(state)
    assert response.status_code == 409 and response.json()['error']['code'] == 'BILLING_SUBSCRIPTION_EXISTS'
    fresh = buy(state, 'new-prepaid-after-subscription')
    assert fresh.status_code == 409 and fresh.json()['error']['code'] == 'BILLING_SUBSCRIPTION_EXISTS'
    assert len(state['posts']) == 1
    paid(state)
    completed = buy(state)
    assert completed.status_code == 200 and completed.json()['fulfilled'] is True
    assert completed.json()['checkout_url'] is None and len(state['posts']) == 1


@pytest.mark.parametrize('first_type', ['recurring', 'onetime'])
def test_pending_membership_blocks_other_payment_type_until_verified_closed(membership_payment_choices, first_type):
    from app.billing_sync import sync_session
    state = membership_payment_choices
    other_type = 'onetime' if first_type == 'recurring' else 'recurring'
    first = buy_membership_type(state, first_type, 'first-payment-type')
    assert first.status_code == 200, first.text
    original_session = next(iter(state['sessions'].values()))
    pack = state['client'].post('/v1/billing/checkouts', headers={**state['auth'], 'Idempotency-Key': 'unrelated-pack'},
        json={'provider': state['provider'], 'price_id': 'separate-pack'})
    assert pack.status_code == 200, pack.text
    blocked = buy_membership_type(state, other_type, 'other-payment-type')
    assert blocked.status_code == 409 and blocked.json()['error']['code'] == 'BILLING_CHECKOUT_PENDING'
    assert len(state['posts']) == 2
    assert buy_membership_type(state, first_type, 'first-payment-type').json() == first.json()
    original_session['status'] = 'expired'
    sync_session(original_session['id'], provider=state['provider'])
    # The unrelated pack stays pending, but cannot prevent changing the
    # membership payment type after its old session is verified closed.
    changed = buy_membership_type(state, other_type, 'other-payment-type')
    assert changed.status_code == 200, changed.text
    assert len(state['posts']) == 3 and not membership_records()[1]


def test_concurrent_membership_payment_types_cannot_create_two_payable_intents(membership_payment_choices):
    from app.billing_checkout import start_checkout
    from app.billing_providers import BillingError
    state = membership_payment_choices

    def start(billing_type):
        price_id = 'purchase-price' if billing_type == 'onetime' else 'plus-month-v1'
        try:
            return start_checkout(state['owner'], price_id, state['provider'], 'race-' + billing_type)
        except BillingError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(start, ['onetime', 'recurring']))
    assert len([result for result in results if isinstance(result, dict)]) == 1
    assert [result for result in results if isinstance(result, str)] == ['BILLING_CHECKOUT_PENDING']
    assert len(state['posts']) == len(state['sessions']) == len(membership_records()[0]) == 1


def test_prepaid_gift_follows_paid_term_without_provider_pause(prepaid):
    state = prepaid
    assert buy(state).status_code == 200
    paid(state)
    term = membership_records()[1][0]
    before = len(state['requests'])
    response = state['client'].post('/v1/admin/users/' + state['owner'] + '/membership',
        headers={**login(state['client'], 'admin'), 'Idempotency-Key': 'gift-after-prepaid'},
        json={'days': 30, 'monthly_pages': 300, 'note': 'isolated gift after prepaid'})
    assert response.status_code == 200, response.text
    gift = response.json()['entitlements']['gift']
    assert gift['state'] == 'scheduled'
    assert gift['starts_at'] == term.ends_at.isoformat() + 'Z'
    assert gift['ends_at'] == (term.ends_at + timedelta(days=30)).isoformat() + 'Z'
    assert len(state['requests']) == before


def test_prepaid_payment_and_monthly_grants_commit_atomically(prepaid, monkeypatch):
    from app import billing_purchases
    from app.billing_providers import BillingError
    from app.billing_sync import sync_session
    state = prepaid
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    # Record the trusted timestamp before the injected payment transaction fault.
    if state['provider'] == 'creem':
        from app import billing_api
        original_process = billing_api.process_event
        monkeypatch.setattr(billing_api, 'process_event', lambda _: None)
        assert notify(state, 'checkout.completed', session).status_code == 200
        monkeypatch.setattr(billing_api, 'process_event', original_process)
    original = billing_purchases.grant_purchase

    def interrupted(*args):
        original(*args)
        raise BillingError('ISOLATED_PREPAID_GRANT_INTERRUPTION')

    monkeypatch.setattr(billing_purchases, 'grant_purchase', interrupted)
    with pytest.raises(BillingError, match='ISOLATED_PREPAID_GRANT_INTERRUPTION'):
        sync_session(session['id'], provider=state['provider'])
    orders, terms, buckets = membership_records()
    assert orders[0].external_id is None and not terms and not buckets
    monkeypatch.setattr(billing_purchases, 'grant_purchase', original)
    sync_session(session['id'], provider=state['provider'])
    assert len(membership_records()[1]) == 1 and len(membership_records()[2]) == 3
