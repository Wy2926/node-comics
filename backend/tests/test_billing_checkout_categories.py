"""Independent quota orders retain exact intent/payment identity without a purchase lock."""
import copy
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta, timezone

import pytest
from sqlalchemy import func, select
from conftest import login
from test_billing_purchases import purchase, paid, notify, records, reverse


@pytest.fixture
def category_buyer(purchase, monkeypatch):
    from app import creem_client, stripe_client
    from app.billing_models import BillingPlan, BillingPlanRevision, BillingPrice, BillingPriceBinding
    from app.db import session_factory
    state = purchase
    with session_factory()() as db:
        for name, pages, interval, amount, product in [('lite', 0, 'month', 599, 'prod_lite'),
                ('pages500', 500, 'once', 1999, 'prod_big')]:
            db.add(BillingPlan(id=name, name=name))
            db.flush()
            db.add(BillingPlanRevision(id=name + '-v1', plan_id=name, version=1, name=name,
                monthly_classic_pages=0, hourly_image_limit=1200, trial_days=0, trial_classic_pages=0,
                quota_pages=pages, service_plan_id='lite' if pages else None))
            db.flush()
            price_id = 'large-price' if pages else 'lite-month'
            db.add(BillingPrice(id=price_id, plan_id=name, plan_revision_id=name + '-v1',
                environment='test', currency='usd', unit_amount=amount, interval=interval, status='active'))
            db.flush()
            db.add(BillingPriceBinding(id=price_id + '-binding', price_id=price_id, provider=state['provider'],
                environment='test', product_id=product, status='active',
                provider_price_id='price_' + name if state['provider'] == 'stripe' else None))
        db.commit()
    original_creem, original_stripe = creem_client.call, stripe_client.call

    def creem_call(method, path, **kwargs):
        if method == 'GET' and path in ('/products/prod_lite', '/products/prod_big'):
            quota = path.endswith('prod_big')
            return {'id': 'prod_big' if quota else 'prod_lite', 'mode': 'test', 'status': 'active',
                'price': 1999 if quota else 599, 'currency': 'USD', 'billing_type': 'onetime' if quota else 'recurring',
                'billing_period': 'once' if quota else 'every-month'}
        if method == 'GET' and path == '/subscriptions':
            assert kwargs['params'] == {'subscription_id': 'sub_lite'}
            return copy.deepcopy(state['lite_subscription'])
        if method == 'GET' and path == '/transactions/search':
            customer = kwargs['params']['customer_id']
            return {'items': copy.deepcopy([value for value in state['transactions'].values()
                if value['customer'] == customer]), 'pagination': {'total_pages': 1}}
        return original_creem(method, path, **kwargs)

    def stripe_call(resource, action, *args, **kwargs):
        if resource == 'prices' and args in (('price_lite',), ('price_pages500',)):
            quota = args == ('price_pages500',)
            return {'id': args[0], 'livemode': False, 'active': True, 'type': 'one_time' if quota else 'recurring',
                'product': 'prod_big' if quota else 'prod_lite', 'currency': 'usd', 'unit_amount': 1999 if quota else 599,
                'recurring': None if quota else {'interval': 'month', 'interval_count': 1, 'usage_type': 'licensed'}}
        return original_stripe(resource, action, *args, **kwargs)

    monkeypatch.setattr(creem_client, 'call', creem_call)
    monkeypatch.setattr(stripe_client, 'call', stripe_call)
    return state


def checkout(state, kind='quota', key='quota-intent', price_id=None):
    return state['client'].post('/v1/billing/checkouts', headers={**state['auth'],
        **({'Idempotency-Key': key} if kind == 'quota' else {})},
        json={'provider': state['provider'], 'price_id': price_id or ('purchase-price' if kind == 'quota' else 'lite-month')})


def status(state):
    return state['client'].get('/v1/billing/status', headers=state['auth']).json()


def rows(state):
    from app.billing_models import BillingCheckout
    from app.db import session_factory
    with session_factory()() as db:
        return list(db.scalars(select(BillingCheckout).where(BillingCheckout.owner_id == state['owner'])
            .order_by(BillingCheckout.created_at, BillingCheckout.id)))


def due(state):
    from app.billing_models import BillingCheckout
    from app.db import session_factory
    with session_factory()() as db:
        for row in db.scalars(select(BillingCheckout).where(BillingCheckout.owner_id == state['owner'])):
            row.last_checked_at = state['at'] - timedelta(minutes=10)
        db.commit()


def canonical(state, customer, owner=None):
    from app.billing_models import BillingCustomer
    from app.db import session_factory
    with session_factory()() as db:
        db.add(BillingCustomer(owner_id=owner or state['owner'], provider=state['provider'],
            environment='test', customer_id=customer))
        db.commit()


def change_payment_customer(state, session, customer):
    session['customer'] = customer
    if state['provider'] == 'stripe':
        payment = state['payments'][session['payment_intent']]
        payment['customer'] = customer
        state['charges'][payment['latest_charge']]['customer'] = customer
    else:
        session['order']['customer'] = customer
        state['transactions'][session['order']['transaction']]['customer'] = customer


def prepare_lite_payment(state, session, customer='cust_subscription'):
    session.update(status='completed', customer=customer, subscription='sub_lite')
    start, end = state['at'], state['at'] + timedelta(days=30)
    state['lite_subscription'] = {'id': 'sub_lite', 'mode': 'test', 'status': 'active',
        'customer': customer, 'product': 'prod_lite', 'metadata': session['metadata'],
        'current_period_start_date': start.isoformat() + 'Z', 'current_period_end_date': end.isoformat() + 'Z',
        'next_transaction_date': end.isoformat() + 'Z', 'items': [{'product_id': 'prod_lite', 'units': 1}]}
    state['transactions']['tran_lite'] = {'id': 'tran_lite', 'mode': 'test', 'type': 'invoice', 'status': 'paid',
        'customer': customer, 'subscription': 'sub_lite', 'currency': 'USD', 'amount': 599, 'amount_paid': 599,
        'period_start': int(start.replace(tzinfo=timezone.utc).timestamp() * 1000),
        'period_end': int(end.replace(tzinfo=timezone.utc).timestamp() * 1000)}


def test_subscription_pending_does_not_lock_same_or_other_quota_prices(category_buyer):
    state = category_buyer
    assert checkout(state, 'subscription').status_code == 200
    snapshot = status(state)
    pending = snapshot['subscription_checkout']
    assert set(pending) == {'id', 'provider', 'price', 'idempotency_key', 'error'}
    assert pending['idempotency_key'] is None and pending['price']['interval'] == 'month'
    assert not {'pending_checkouts', 'checkout_pending', 'checkout_price', 'quota_checkout_price',
        'checkout_provider', 'checkout_id', 'checkout_idempotency_key', 'checkout_error'} & snapshot.keys()
    for key, price in [('small-one', 'purchase-price'), ('small-two', 'purchase-price'), ('big', 'large-price')]:
        first = checkout(state, key=key, price_id=price)
        assert first.status_code == 200
        assert checkout(state, key=key, price_id=price).json() == first.json()
    assert status(state)['subscription_checkout'] == pending
    assert status(state)['provider'] is None
    assert checkout(state, key='small-one', price_id='large-price').json()['error']['code'] == 'BILLING_CHECKOUT_PRICE_CONFLICT'
    assert checkout(state, 'subscription').json()['checkout_id'] == pending['id']
    assert len(rows(state)) == len(state['sessions']) == len(state['posts']) == 4


def test_distinct_key_concurrency_keeps_independent_checkouts(category_buyer):
    from app.billing_checkout import start_checkout
    state = category_buyer
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda index: start_checkout(state['owner'],
            'large-price' if index % 2 else 'purchase-price', state['provider'], 'key-' + str(index)), range(6)))
    assert len({result['checkout_id'] for result in results}) == len(rows(state)) == len(state['sessions']) == 6
    assert all(row.customer_id is None for row in rows(state))


@pytest.mark.parametrize('order', ['forward', 'reverse', 'concurrent'])
def test_customerless_purchases_settle_with_distinct_customers(category_buyer, order):
    from app.billing_models import BillingCustomer
    from app.billing_sync import sync_session
    from app.db import session_factory
    state = category_buyer
    sessions = []
    for index in range(2):
        assert checkout(state, key='purchase-' + str(index)).status_code == 200
        session = paid(state, sync=False)
        change_payment_customer(state, session, 'cust_order' + str(index))
        sessions.append(session)
    if order == 'concurrent':
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda session: sync_session(session['id'], provider=state['provider']), sessions * 3))
    else:
        for session in (sessions if order == 'forward' else list(reversed(sessions))) * 2:
            kind = 'checkout.completed' if state['provider'] == 'creem' else 'checkout.session.completed'
            assert notify(state, kind, session, 'evt_' + session['id'].replace('_', '')).status_code == 200
    orders, buckets, ledger = records()
    assert len(orders) == len(buckets) == len(ledger) == 2
    assert all(order.status == 'paid' for order in orders)
    assert {row.customer_id for row in rows(state)} == {'cust_order0', 'cust_order1'}
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingCustomer)) == 0
    for index in range(2):
        assert checkout(state, key='purchase-' + str(index)).json()['fulfilled'] is True
    assert len(state['posts']) == 2


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
def test_quota_before_customerless_subscription_does_not_claim_canonical(category_buyer):
    from app.billing_models import BillingCustomer, BillingTerm
    from app.billing_sync import sync_session
    from app.db import session_factory
    state = category_buyer
    assert checkout(state, 'subscription').status_code == 200
    subscription = next(iter(state['sessions'].values()))
    assert checkout(state).status_code == 200
    quota = paid(state, sync=False)
    change_payment_customer(state, quota, 'cust_quota')
    sync_session(quota['id'], provider='creem')
    with session_factory()() as db:
        assert db.scalar(select(BillingCustomer)) is None
    prepare_lite_payment(state, subscription)
    for _ in range(2):
        sync_session(subscription['id'], provider='creem')
        sync_session(quota['id'], provider='creem')
    with session_factory()() as db:
        assert db.scalar(select(BillingCustomer)).customer_id == 'cust_subscription'
        assert db.scalar(select(func.count()).select_from(BillingTerm)) == 1
    assert len(records()[1]) == len(records()[2]) == 1
    assert status(state)['subscription_checkout'] is None and status(state)['provider'] == 'creem'
    assert checkout(state, key='after-subscription').status_code == 200
    assert rows(state)[-1].customer_id == 'cust_subscription'


def test_frozen_customer_cannot_change_with_consistent_payment_chain(category_buyer):
    from app.billing_providers import BillingError
    from app.billing_sync import sync_session
    state = category_buyer
    canonical(state, 'cust_frozen')
    assert checkout(state).status_code == 200
    session = paid(state, sync=False)
    change_payment_customer(state, session, 'cust_other')
    with pytest.raises(BillingError):
        sync_session(session['id'], provider=state['provider'])
    assert rows(state)[0].customer_id == 'cust_frozen'
    assert not records()[1] and not records()[2]


def test_first_customer_claim_rejects_another_accounts_canonical(category_buyer):
    from app.billing_providers import BillingError
    from app.billing_sync import sync_session
    state = category_buyer
    other_auth = login(state['client'], 'other-canonical-owner')
    other = state['client'].get('/v1/me', headers=other_auth).json()['user']['id']
    canonical(state, 'cust_other', owner=other)
    assert checkout(state).status_code == 200
    session = paid(state, sync=False)
    change_payment_customer(state, session, 'cust_other')
    with pytest.raises(BillingError, match='BILLING_CUSTOMER_MISMATCH'):
        sync_session(session['id'], provider=state['provider'])
    assert rows(state)[0].customer_id is None and not records()[1]


def test_later_canonical_customer_cannot_block_bound_purchase_refund(category_buyer):
    state = category_buyer
    assert checkout(state).status_code == 200
    session = paid(state)
    other_auth = login(state['client'], 'later-canonical-owner')
    other = state['client'].get('/v1/me', headers=other_auth).json()['user']['id']
    canonical(state, 'cust_pagebuyer', owner=other)
    assert reverse(state, session, 'refund').status_code == 200
    assert records()[0][0].status == 'refunded' and records()[1][0].revoked_at is not None
    assert rows(state)[0].customer_id == 'cust_pagebuyer'


def test_many_pending_status_is_fixed_and_remote_free(category_buyer):
    state = category_buyer
    baseline = status(state)
    for index in range(12):
        assert checkout(state, key='pending-' + str(index)).status_code == 200
    state['requests'].clear()
    current = status(state)
    assert current == baseline and len(json.dumps(current)) == len(json.dumps(baseline))
    assert not state['requests'] and current['subscription_checkout'] is None
    assert len(rows(state)) == 12


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
def test_unknown_intent_blocks_only_its_own_post_replay(category_buyer):
    state = category_buyer
    state['lost'] = True
    assert checkout(state, key='lost-one').status_code == 503
    assert checkout(state, key='another-one').status_code == 200
    assert checkout(state, 'subscription').status_code == 200
    count = len(state['posts'])
    for _ in range(2):
        response = checkout(state, key='lost-one')
        assert response.status_code == 409 and response.json()['error']['code'] == 'CREEM_CHECKOUT_UNCERTAIN'
    assert len(state['posts']) == count == 3


def test_expired_purchase_does_not_close_other_intents(category_buyer):
    state = category_buyer
    assert checkout(state, 'subscription').status_code == 200
    pending = status(state)['subscription_checkout']
    assert checkout(state, key='kept-quota').status_code == 200
    kept = rows(state)[-1].id
    assert checkout(state, key='expired-quota').status_code == 200
    list(state['sessions'].values())[-1]['status'] = 'expired'
    assert checkout(state, key='expired-quota').json()['error']['code'] == 'BILLING_PURCHASE_RETRY_ALLOWED'
    assert checkout(state, key='kept-quota').json()['checkout_id'] == kept
    assert status(state)['subscription_checkout'] == pending
    assert checkout(state, key='new-quota').status_code == 200


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('failure', ['unknown', 'get_error'])
def test_failed_pending_rotation_does_not_starve_subscription_or_later_quota(category_buyer, monkeypatch, failure):
    from app import creem_client
    from app.billing_checkout import sync_owner
    from app.billing_providers import BillingError
    state = category_buyer
    assert checkout(state, 'subscription').status_code == 200
    subscription = next(iter(state['sessions'].values()))
    prepare_lite_payment(state, subscription)
    failed = set()
    for index in range(4):
        state['lost'] = failure == 'unknown'
        assert checkout(state, key='failed-' + str(index)).status_code == (503 if failure == 'unknown' else 200)
        failed.add(list(state['sessions'])[-1])
    assert checkout(state, key='later-paid').status_code == 200
    paid(state, sync=False)
    original = creem_client.call

    def call(method, path, **kwargs):
        if failure == 'get_error' and path == '/checkouts' and (kwargs.get('params') or {}).get('checkout_id') in failed:
            raise BillingError('CREEM_UNAVAILABLE', uncertain=True)
        return original(method, path, **kwargs)

    monkeypatch.setattr(creem_client, 'call', call)
    due(state)
    for index in range(3):
        try:
            sync_owner(state['owner'])
        except BillingError as exc:
            assert exc.code in ('CREEM_CHECKOUT_UNCERTAIN', 'CREEM_UNAVAILABLE')
        assert status(state)['subscription_checkout'] is None
        assert len(records()[1]) == (1 if index == 2 else 0)
    assert len(state['posts']) == 6


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
def test_unfulfilled_completed_purchase_stays_inside_two_quota_limit(category_buyer):
    from app.billing_checkout import sync_owner
    from app.billing_models import BillingCheckout, BillingPlanRevision
    from app.db import session_factory
    state = category_buyer
    for index in range(3):
        assert checkout(state, key='unpaid-' + str(index)).status_code == 200
    latest = paid(state, sync=False)
    with session_factory()() as db:
        db.get(BillingPlanRevision, 'pages100-v1').quota_validity_days = 30
        row = db.scalar(select(BillingCheckout).where(BillingCheckout.session_id == latest['id']))
        row.status = 'completed'
        db.commit()
    due(state)
    state['requests'].clear()
    sync_owner(state['owner'])
    checked = {item[2]['checkout_id'] for item in state['requests'] if item[:2] == ('GET', '/checkouts')}
    assert len(checked) == 2 and latest['id'] not in checked
    assert not records()[1]


def test_disabled_provider_unsent_intents_do_not_starve_enabled_purchases(category_buyer, monkeypatch):
    from app.billing_checkout import sync_owner
    from app.billing_models import BillingCheckout, BillingPriceBinding
    from app.config import settings
    from app.db import session_factory
    state = category_buyer
    disabled = 'stripe' if state['provider'] == 'creem' else 'creem'
    monkeypatch.setattr(settings(), disabled + '_enabled', False)
    with session_factory()() as db:
        db.add(BillingPriceBinding(id='disabled-binding', price_id='purchase-price', provider=disabled,
            environment='test', product_id='prod_old', status='active',
            provider_price_id='price_old' if disabled == 'stripe' else None))
        db.flush()
        for index in range(2):
            db.add(BillingCheckout(owner_id=state['owner'], idempotency_key='unsent-' + str(index),
                provider=disabled, environment='test', price_id='purchase-price', binding_id='disabled-binding',
                return_url='https://comics.example/account/', trial=False, status='creating',
                created_at=state['at'] - timedelta(hours=1), expires_at=state['at'] + timedelta(hours=1)))
        db.commit()
    assert checkout(state).status_code == 200
    paid(state, sync=False)
    # Only the dispatched checkout is due; the old rows retain their null sentinels.
    with session_factory()() as db:
        active = db.scalar(select(BillingCheckout).where(BillingCheckout.provider == state['provider']))
        active.last_checked_at = state['at'] - timedelta(minutes=10)
        db.commit()
    sync_owner(state['owner'])
    assert len(records()[1]) == len(records()[2]) == 1
    assert all(row.last_checked_at is None and row.session_id is None and row.status == 'creating'
        for row in rows(state) if row.provider == disabled)
    assert len(state['posts']) == 1


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
def test_maintenance_bounded_batch_eventually_reaches_other_owner(category_buyer, monkeypatch):
    from app import billing_checkout, billing_renewal
    from app.billing_sync import reconcile_once
    state = category_buyer
    for index in range(13):
        state['lost'] = True
        assert checkout(state, key='busy-' + str(index)).status_code == 503
    due(state)
    other_auth = login(state['client'], 'later-buyer')
    other_owner = state['client'].get('/v1/me', headers=other_auth).json()['user']['id']
    other = {**state, 'auth': other_auth, 'owner': other_owner}
    state['lost'] = True
    assert checkout(other, key='other-owner').status_code == 503
    due(other)
    original, observed = billing_checkout.sync_owner, []

    def sync(owner):
        observed.append(owner)
        return original(owner)

    monkeypatch.setattr(billing_checkout, 'sync_owner', sync)
    monkeypatch.setattr(billing_renewal, 'reconcile_renewals', lambda enabled: None)
    for _ in range(5):
        reconcile_once()
        if other_owner in observed:
            break
    assert other_owner in observed and len(state['posts']) == 14


@pytest.mark.parametrize('kind', ['subscription', 'quota'])
def test_only_subscription_pending_blocks_gift(category_buyer, kind):
    state = category_buyer
    assert checkout(state, kind).status_code == 200
    response = state['client'].post('/v1/admin/users/' + state['owner'] + '/membership',
        headers={**login(state['client'], 'admin'), 'Idempotency-Key': 'category-gift'},
        json={'days': 30, 'note': 'isolated intent fixture'})
    assert response.status_code == (409 if kind == 'subscription' else 200)
    if kind == 'subscription':
        assert response.json()['error']['code'] == 'BILLING_CHECKOUT_PENDING'
