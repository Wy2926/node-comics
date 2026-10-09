"""Isolated payment API fixtures: no real purchases, credentials or external calls."""
import copy
import hashlib
import hmac
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta, timezone
import pytest
from sqlalchemy import func, select
from conftest import login


@pytest.fixture(params=['stripe', 'creem'])
def purchase(request, monkeypatch):
    provider = request.param
    for key, value in {provider.upper() + '_ENABLED': 'true', provider.upper() + '_ENVIRONMENT': 'test',
            provider.upper() + '_RETURN_URL': 'https://comics.example/account/',
            'STRIPE_SECRET_KEY': 'sk_test_fixture', 'CREEM_API_KEY': 'creem_test_fixture',
            'STRIPE_WEBHOOK_SECRET': 'whsec_fixture', 'CREEM_WEBHOOK_SECRET': 'creem_fixture_webhook'}.items():
        monkeypatch.setenv(key, value)
    client = request.getfixturevalue('client')
    from app.billing_models import BillingPlan, BillingPlanRevision, BillingPrice, BillingPriceBinding, BillingSettings
    from app.db import session_factory
    from app.models import now
    with session_factory()() as db:
        db.add(BillingPlan(id='pages100', name='100 pages'))
        db.flush()
        db.add(BillingPlanRevision(id='pages100-v1', plan_id='pages100', version=1, name='100 pages',
            service_plan_id='lite', quota_pages=100, quota_validity_days=None, monthly_redraw_pages=0,
            trial_days=0, trial_redraw_pages=0, hourly_image_limit=1200))
        db.flush()
        db.add(BillingPrice(id='purchase-price', plan_id='pages100', plan_revision_id='pages100-v1',
            environment='test', currency='usd', unit_amount=399, interval='once', status='active'))
        db.flush()
        db.add(BillingPriceBinding(id='purchase-binding', price_id='purchase-price', provider=provider,
            environment='test', product_id='prod_pack', provider_price_id='price_pack' if provider == 'stripe' else None,
            status='active'))
        db.get(BillingSettings, 1).default_provider = provider
        db.commit()
    state = {'provider': provider, 'client': client, 'sessions': {}, 'payments': {}, 'charges': {},
        'transactions': {}, 'refunds': {}, 'disputes': {}, 'posts': [], 'requests': [], 'at': now().replace(microsecond=0),
        'lost': False}
    state['price'] = {'id': 'price_pack', 'livemode': False, 'active': True, 'type': 'one_time',
        'product': 'prod_pack', 'currency': 'usd', 'unit_amount': 399, 'recurring': None}
    state['product'] = {'id': 'prod_pack', 'mode': 'test', 'status': 'active', 'price': 399,
        'currency': 'USD', 'billing_type': 'onetime', 'billing_period': 'once'}

    def stripe_call(resource, action, *args, **kwargs):
        state['requests'].append((resource, action, args, copy.deepcopy(kwargs)))
        if resource == 'prices':
            value = state['price']
        elif resource == 'checkout.sessions' and action == 'create':
            params = kwargs['params']
            state['posts'].append(copy.deepcopy(params))
            key = kwargs['options']['idempotency_key']
            previous = next((s for s in state['sessions'].values() if s.get('key') == key), None)
            if previous:
                value = previous
            else:
                session_id = 'cs_test_pack' + str(len(state['sessions']) + 1)
                value = {'id': session_id, 'key': key, 'livemode': False, 'mode': params['mode'],
                    'status': 'open', 'payment_status': 'unpaid', 'customer': params.get('customer'),
                    'client_reference_id': params['client_reference_id'], 'metadata': params['metadata'],
                    'url': 'https://checkout.stripe.com/c/pay/' + session_id}
                state['sessions'][session_id] = value
            if state['lost']:
                state['lost'] = False
                from app.billing_providers import BillingError
                raise BillingError(uncertain=True)
        elif resource == 'checkout.sessions' and action == 'retrieve':
            value = state['sessions'][args[0]]
        elif resource == 'checkout.sessions.line_items' and action == 'list':
            value = {'data': [{'quantity': state.get('quantity', 1), 'price': state['price']}], 'has_more': False}
        elif resource == 'checkout.sessions' and action == 'list':
            params = kwargs.get('params', {})
            value = {'data': [s for s in state['sessions'].values() if not params.get('payment_intent')
                or s.get('payment_intent') == params['payment_intent']], 'has_more': False}
        elif resource == 'payment_intents':
            value = state['payments'][args[0]]
        elif resource == 'charges':
            value = state['charges'][args[0]]
        elif resource == 'invoice_payments':
            value = {'data': [], 'has_more': False}
        elif resource in ('refunds', 'disputes'):
            value = {'data': [r for r in state[resource].values() if r['charge'] == kwargs['params']['charge']], 'has_more': False}
        else:
            raise AssertionError((resource, action, args, kwargs))
        return copy.deepcopy(value)

    def creem_call(method, path, *, params=None, body=None):
        state['requests'].append((method, path, copy.deepcopy(params), copy.deepcopy(body)))
        if method == 'GET' and path == '/products/prod_pack':
            value = state['product']
        elif method == 'POST' and path == '/checkouts':
            state['posts'].append(copy.deepcopy(body))
            session_id = 'ch_pack' + str(len(state['sessions']) + 1)
            value = {'id': session_id, 'mode': 'test', 'status': 'pending', 'product': body['product_id'],
                'customer': (body.get('customer') or {}).get('id'), 'metadata': body['metadata'], 'request_id': body['request_id'],
                'checkout_url': 'https://creem.io/test/checkout/prod_pack/' + session_id}
            state['sessions'][session_id] = value
            if state['lost']:
                state['lost'] = False
                from app.billing_providers import BillingError
                raise BillingError('CREEM_UNAVAILABLE', uncertain=True)
        elif method == 'GET' and path == '/checkouts':
            value = {k: v for k, v in state['sessions'][params['checkout_id']].items() if k != 'checkout_url'}
        elif method == 'GET' and path == '/transactions':
            value = state['transactions'][params['transaction_id']]
        else:
            raise AssertionError((method, path, params, body))
        return copy.deepcopy(value)

    from app import stripe_client, creem_client
    state['stripe_call'] = stripe_call
    state['real_stripe_call'] = stripe_client.call
    monkeypatch.setattr(stripe_client, 'call', stripe_call)
    monkeypatch.setattr(creem_client, 'call', creem_call)
    state['auth'] = login(client, 'page-buyer')
    state['owner'] = client.get('/v1/me', headers=state['auth']).json()['user']['id']
    return state


def buy(state, key='purchase-intent-1'):
    return state['client'].post('/v1/billing/checkouts', headers={**state['auth'], 'Idempotency-Key': key},
        json={'provider': state['provider'], 'price_id': 'purchase-price'})


def notify(state, kind, obj, event_id='evt_purchase1'):
    created = int(state['at'].replace(tzinfo=timezone.utc).timestamp())
    if state['provider'] == 'stripe':
        body = json.dumps({'id': event_id, 'type': kind, 'livemode': False, 'created': created, 'data': {'object': obj}}).encode()
        sent = int(time.time())
        signature = hmac.new(b'whsec_fixture', str(sent).encode() + b'.' + body, hashlib.sha256).hexdigest()
        headers = {'Stripe-Signature': f't={sent},v1={signature}'}
    else:
        body = json.dumps({'id': event_id, 'eventType': kind, 'created_at': created * 1000, 'object': obj}).encode()
        signature = hmac.new(b'creem_fixture_webhook', body, hashlib.sha256).hexdigest()
        headers = {'creem-signature': signature}
    return state['client'].post('/webhooks/' + state['provider'], content=body,
        headers={**headers, 'Content-Type': 'application/json'})


def paid(state, *, sync=True, event=True):
    session = list(state['sessions'].values())[-1]
    index = len(state['sessions'])
    session['customer'] = 'cust_pagebuyer'
    at = int(state['at'].replace(tzinfo=timezone.utc).timestamp())
    if state['provider'] == 'stripe':
        session.update(status='complete', payment_status='paid', payment_intent='pi_pack' + str(index),
            amount_subtotal=399, amount_total=399, currency='usd', total_details={'amount_discount': 0})
        payment = {'id': session['payment_intent'], 'livemode': False, 'metadata': session['metadata'],
            'status': 'succeeded', 'capture_method': 'automatic', 'customer': session['customer'], 'currency': 'usd',
            'amount': 399, 'amount_received': 399, 'latest_charge': 'ch_pack' + str(index)}
        state['payments'][payment['id']] = payment
        state['charges'][payment['latest_charge']] = {'id': payment['latest_charge'], 'livemode': False,
            'customer': session['customer'], 'currency': 'usd', 'amount': 399, 'amount_captured': 399,
            'paid': True, 'captured': True, 'status': 'succeeded', 'payment_intent': payment['id'],
            'created': at, 'disputed': False, 'refunded': False, 'amount_refunded': 0}
        kind = 'checkout.session.completed'
    else:
        session.update(status='completed', order={'id': 'ord_pack' + str(index), 'mode': 'test',
            'type': 'onetime', 'status': 'paid', 'product': 'prod_pack', 'customer': session['customer'],
            'amount': 399, 'amount_paid': 399, 'currency': 'USD', 'transaction': 'tran_pack' + str(index)})
        transaction = {'id': session['order']['transaction'], 'mode': 'test', 'type': 'payment',
            'status': 'paid', 'amount': 399, 'amount_paid': 399, 'currency': 'USD',
            'customer': session['customer'], 'order': session['order']['id'], 'created_at': at * 1000}
        state['transactions'][transaction['id']] = transaction
        kind = 'checkout.completed'
    if sync:
        if event:
            assert notify(state, kind, session, 'evt_purchase' + str(index)).status_code == 200
        else:
            from app.billing_sync import sync_session
            sync_session(session['id'], provider=state['provider'])
    return session


def records():
    from app.billing_models import BillingOrder
    from app.entitlement_models import QuotaPeriod
    from app.models import Ledger
    from app.db import session_factory
    with session_factory()() as db:
        return (list(db.scalars(select(BillingOrder).order_by(BillingOrder.created_at))),
            list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.source == 'purchase'))),
            list(db.scalars(select(Ledger).where(Ledger.kind == 'purchase'))))


def test_one_time_purchase_grants_once_and_replays_same_intent(purchase):
    state = purchase
    first = buy(state)
    assert first.status_code == 200, first.text
    assert first.json() == buy(state).json()
    assert len(state['posts']) == 1
    status = state['client'].get('/v1/billing/status', headers=state['auth']).json()
    assert status['subscription_checkout'] is None
    assert 'pending_checkouts' not in status
    session = paid(state)
    from app.billing_sync import sync_session
    sync_session(session['id'], provider=state['provider'])
    fulfilled = buy(state)
    assert fulfilled.status_code == 200, fulfilled.text
    assert fulfilled.json()['fulfilled'] is True and fulfilled.json()['checkout_url'] is None
    orders, buckets, ledger = records()
    assert len(orders) == len(buckets) == len(ledger) == 1
    assert orders[0].status == 'paid' and buckets[0].granted == 100 and buckets[0].ends_at is None
    assert buckets[0].starts_at == state['at'] and orders[0].paid_at == state['at']
    assert buckets[0].billing_order_id == orders[0].id
    assert ledger[0].transaction_key == buckets[0].source_key == 'purchase:' + orders[0].id + ':classic'
    from app.billing_models import BillingAccount, BillingSubscription, BillingTerm
    from app.db import session_factory
    with session_factory()() as db:
        assert db.get(BillingAccount, state['owner']).trial_used_at is None
        assert db.scalar(select(func.count()).select_from(BillingSubscription)) == 0
        assert db.scalar(select(func.count()).select_from(BillingTerm)) == 0
    assert buy(state, 'purchase-intent-2').status_code == 200
    assert len(state['sessions']) == 2


def test_purchase_requires_stable_intent_and_allows_independent_inflight(purchase):
    state = purchase
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'provider': state['provider'], 'price_id': 'purchase-price'})
    assert response.status_code == 409 and response.json()['error']['code'] == 'BILLING_IDEMPOTENCY_KEY_REQUIRED'
    assert not state['posts']
    assert buy(state).status_code == 200
    assert buy(state, 'different-intent').status_code == 200
    assert len(state['posts']) == 2


def test_concurrent_purchase_notifications_grant_and_log_once(purchase):
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    # Keep finite expiry out of this concurrency test: Creem's permanent pack
    # can be fulfilled by a verified read before checkout.completed arrives.
    from app.billing_sync import sync_session
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: sync_session(session['id'], provider=state['provider']), range(8)))
    orders, buckets, ledger = records()
    assert len(orders) == len(buckets) == len(ledger) == 1
    assert buckets[0].used == buckets[0].reserved == 0


def test_completed_unpaid_checkout_does_not_grant(purchase):
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    if state['provider'] == 'stripe':
        session['payment_status'] = 'unpaid'
    else:
        state['transactions'][session['order']['transaction']]['status'] = 'pending'
    notify(state, 'checkout.session.completed' if state['provider'] == 'stripe' else 'checkout.completed', session)
    assert not records()[1] and not records()[2]
    assert buy(state).status_code == 409


def test_pack_can_be_bought_during_gift_without_extending_membership(purchase):
    state = purchase
    from app.db import session_factory
    from app.models import User
    with session_factory()() as db:
        user = db.get(User, state['owner'])
        user.membership_id = 'gift-purchase'
        user.plus_started_at = state['at'] - timedelta(days=1)
        user.plus_expires_at = state['at'] + timedelta(days=29)
        user.plus_timezone = 'UTC'
        db.commit()
    assert buy(state).status_code == 200
    paid(state)
    with session_factory()() as db:
        assert db.get(User, state['owner']).plus_expires_at == state['at'] + timedelta(days=29)


def test_finite_purchase_uses_original_payment_time_not_reconciliation_time(purchase):
    state = purchase
    from app.db import session_factory
    from app.billing_models import BillingPlanRevision
    with session_factory()() as db:
        db.get(BillingPlanRevision, 'pages100-v1').quota_validity_days = 30
        db.commit()
    assert buy(state).status_code == 200
    session = paid(state, event=state['provider'] == 'stripe')
    if state['provider'] == 'creem':
        assert not records()[1]
        assert records()[0][0].status == 'processing' and records()[0][0].paid_at is None
        assert notify(state, 'checkout.completed', session).status_code == 200
    bucket = records()[1][0]
    assert bucket.starts_at == state['at'] and bucket.ends_at == state['at'] + timedelta(days=30)


def test_unknown_creation_recovers_original_order_without_new_charge(purchase):
    state = purchase
    state['lost'] = True
    assert buy(state).status_code == 503
    if state['provider'] == 'creem':
        assert buy(state).status_code == 409
        assert len(state['posts']) == 1
    else:
        assert buy(state).status_code == 200
        assert len(state['sessions']) == 1
    paid(state)
    assert buy(state).json()['fulfilled'] is True
    assert len(records()[0]) == len(records()[1]) == len(records()[2]) == 1


def test_first_purchase_preflight_failure_allows_only_explicit_new_intent(purchase):
    state = purchase
    state['price']['active'] = False
    state['product']['status'] = 'archived'
    response = buy(state)
    assert response.status_code == 409
    assert not state['posts'] and not state['sessions']
    assert state['client'].get('/v1/billing/status', headers=state['auth']).json()['subscription_checkout'] is None
    assert records()[0][0].status == 'failed'
    state['price']['active'] = True
    state['product']['status'] = 'active'
    replay = buy(state)
    assert replay.status_code == 409 and replay.json()['error']['code'] == 'BILLING_PURCHASE_RETRY_ALLOWED'
    assert not state['posts']
    assert buy(state, 'explicit-after-preflight-failure').status_code == 200
    assert len(state['posts']) == len(state['sessions']) == 1
    assert len(records()[0]) == 2


def test_unknown_purchase_cannot_be_released_by_a_later_preflight_failure(purchase):
    state = purchase
    state['lost'] = True
    assert buy(state).status_code == 503
    state['price']['active'] = False
    state['product']['status'] = 'archived'
    response = buy(state)
    assert response.status_code == 409
    assert response.json()['error']['code'] != 'BILLING_PURCHASE_RETRY_ALLOWED'
    assert state['client'].get('/v1/billing/status', headers=state['auth']).json()['subscription_checkout'] is None
    assert records()[0][0].status == 'unknown'
    assert len(state['posts']) == len(state['sessions']) == len(records()[0]) == 1
    state['price']['active'] = True
    state['product']['status'] = 'active'
    paid(state)
    assert buy(state).json()['fulfilled'] is True
    assert len(records()[1]) == len(records()[2]) == 1


def test_stripe_preflight_cannot_dispatch_after_a_competing_failure(purchase, monkeypatch):
    if purchase['provider'] != 'stripe':
        pytest.skip('Stripe idempotent dispatch race')
    from threading import Event
    from app import stripe_client
    from app.billing_checkout import start_checkout
    from app.billing_providers import BillingError
    state = purchase
    started, release = Event(), Event()
    original = state['stripe_call']

    def delayed_price(resource, action, *args, **kwargs):
        if resource == 'prices' and not started.is_set():
            started.set()
            assert release.wait(10)
            return copy.deepcopy(state['price'])
        if resource == 'prices':
            return {**state['price'], 'active': False}
        return original(resource, action, *args, **kwargs)

    monkeypatch.setattr(stripe_client, 'call', delayed_price)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(start_checkout, state['owner'], 'purchase-price', 'stripe', 'purchase-intent-1')
        try:
            assert started.wait(10)
            assert buy(state).json()['error']['code'] == 'BILLING_PLAN_UNAVAILABLE'
        finally:
            release.set()
        with pytest.raises(BillingError, match='BILLING_PURCHASE_RETRY_ALLOWED'):
            pending.result(timeout=10)
    assert not state['posts'] and not state['sessions']
    monkeypatch.setattr(stripe_client, 'call', original)
    assert buy(state, 'explicit-after-competing-failure').status_code == 200
    assert len(state['posts']) == len(state['sessions']) == 1


def reverse(state, session, kind, amount=399, *, stale_payment=False):
    if state['provider'] == 'stripe':
        payment = state['payments'][session['payment_intent']]
        charge = state['charges'][payment['latest_charge']]
        if kind == 'refund':
            value = {'id': 're_pack1', 'object': 'refund', 'charge': charge['id'], 'status': 'succeeded',
                'amount': amount, 'currency': 'usd', 'created': int(state['at'].replace(tzinfo=timezone.utc).timestamp())}
            state['refunds'][value['id']] = value
            if not stale_payment:
                charge.update(amount_refunded=amount, refunded=amount == 399)
            event_kind = 'refund.created'
        else:
            value = {'id': 'dp_pack1', 'object': 'dispute', 'livemode': False, 'charge': charge['id'],
                'status': 'needs_response', 'amount': 399, 'currency': 'usd',
                'created': int(state['at'].replace(tzinfo=timezone.utc).timestamp())}
            state['disputes'][value['id']] = value
            if not stale_payment:
                charge['disputed'] = True
            event_kind = 'charge.dispute.created'
    else:
        value = {'id': 'ref_pack1' if kind == 'refund' else 'disp_pack1', 'mode': 'test', 'object': kind,
            'transaction': session['order']['transaction'], 'checkout': {'id': session['id']},
            'status': 'succeeded' if kind == 'refund' else 'needs_response'}
        if kind == 'refund':
            value.update(refund_amount=amount, refund_currency='USD')
        else:
            value.update(amount=399, currency='USD')
        if not stale_payment:
            transaction = state['transactions'][session['order']['transaction']]
            transaction['status'] = 'chargedBack' if kind == 'dispute' else 'refunded' if amount == 399 else 'partialRefund'
            if kind == 'refund':
                transaction['refunded_amount'] = amount
        event_kind = kind + '.created'
    return notify(state, event_kind, value, 'evt_reversal1')


@pytest.mark.parametrize('kind', ['refund', 'dispute'])
def test_reversal_preserves_usage_and_reservations_and_does_not_restore(purchase, kind):
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state)
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.billing_models import BillingEvent
    with session_factory()() as db:
        bucket = db.scalar(select(QuotaPeriod).where(QuotaPeriod.source == 'purchase'))
        bucket.used, bucket.reserved = 12, 3
        db.commit()
    assert reverse(state, session, kind, stale_payment=True).status_code == 200
    orders, buckets, ledger = records()
    assert orders[0].status == ('refunded' if kind == 'refund' else 'disputed')
    assert buckets[0].revoked_at is not None and (buckets[0].granted, buckets[0].used, buckets[0].reserved) == (100, 12, 3)
    from app.billing_sync import sync_session
    sync_session(session['id'], provider=state['provider'])
    assert records()[1][0].revoked_at is not None and len(records()[2]) == 1
    with session_factory()() as db:
        assert db.get(BillingEvent, state['provider'] + ':test:evt_reversal1').status == 'processed'


@pytest.mark.parametrize('kind', ['refund', 'dispute'])
def test_reversal_before_checkout_notification_never_grants(purchase, kind):
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    assert reverse(state, session, kind, stale_payment=True).status_code == 200
    assert records()[0][0].status == ('refunded' if kind == 'refund' else 'disputed')
    assert not records()[1] and not records()[2]
    kind = 'checkout.session.completed' if state['provider'] == 'stripe' else 'checkout.completed'
    assert notify(state, kind, session).status_code == 200
    assert not records()[1] and not records()[2]
    assert buy(state).json()['fulfilled'] is True


def stripe_dispute(state, session, status='needs_response'):
    charge_id = state['payments'][session['payment_intent']]['latest_charge']
    value = {'id': 'dp_pack_stale', 'object': 'dispute', 'livemode': False, 'charge': charge_id,
        'status': status, 'amount': 399, 'currency': 'usd',
        'created': int(state['at'].replace(tzinfo=timezone.utc).timestamp())}
    state['disputes'][value['id']] = value
    return value


@pytest.mark.parametrize('status,revoked', [
    ('needs_response', True), ('under_review', True), ('won', True), ('lost', True),
    ('warning_needs_response', False), ('warning_under_review', False),
    ('warning_closed', False), ('prevented', False),
])
def test_stripe_dispute_is_checked_before_first_grant_despite_stale_charge(purchase, monkeypatch, status, revoked):
    if purchase['provider'] != 'stripe':
        pytest.skip('Stripe charge/dispute state distinction')
    from app import billing_api
    from app.billing_sync import process_event, sync_session
    from app.billing_models import BillingDispute
    from app.db import session_factory
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    dispute = stripe_dispute(state, session, status)
    # The signed dispute reaches the inbox first, but Checkout reconciliation
    # wins the worker race. Charge.disputed still reports its old false value.
    monkeypatch.setattr(billing_api, 'process_event', lambda _: None)
    assert notify(state, 'charge.dispute.created', dispute, 'evt_staleDispute').status_code == 200
    before = len(state['requests'])
    sync_session(session['id'], provider='stripe')
    reads = [r for r in state['requests'][before:] if r[0] in ('refunds', 'disputes')]
    assert reads == [(resource, 'list', (), {'params': {'charge': dispute['charge'], 'limit': 100}})
        for resource in ('refunds', 'disputes')]
    assert not any('customer' in r[3].get('params', {}) for r in state['requests'][before:])
    assert records()[0][0].status == ('disputed' if revoked else 'paid')
    assert len(records()[1]) == len(records()[2]) == (0 if revoked else 1)
    with session_factory()() as db:
        assert db.scalar(select(BillingDispute)).status == status
    process_event('stripe:test:evt_staleDispute')
    sync_session(session['id'], provider='stripe')
    assert records()[0][0].status == ('disputed' if revoked else 'paid')
    assert len(records()[1]) == len(records()[2]) == (0 if revoked else 1)


def test_stripe_won_dispute_does_not_restore_purchase_with_stale_charge(purchase):
    if purchase['provider'] != 'stripe':
        pytest.skip('Stripe won-dispute terminal policy')
    from app.billing_sync import sync_session
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state)
    with session_factory()() as db:
        bucket = db.scalar(select(QuotaPeriod).where(QuotaPeriod.source == 'purchase'))
        bucket.used, bucket.reserved = 12, 3
        db.commit()
    dispute = stripe_dispute(state, session)
    assert notify(state, 'charge.dispute.created', dispute, 'evt_staleDisputeCreated').status_code == 200
    revoked_at = records()[1][0].revoked_at
    assert revoked_at is not None and records()[0][0].status == 'disputed'
    dispute['status'] = 'won'
    assert notify(state, 'charge.dispute.closed', dispute, 'evt_staleDisputeClosed').status_code == 200
    sync_session(session['id'], provider='stripe')
    orders, buckets, ledger = records()
    assert orders[0].status == 'disputed' and buckets[0].revoked_at == revoked_at
    assert (buckets[0].used, buckets[0].reserved) == (12, 3) and len(ledger) == 1


@pytest.mark.parametrize('amount', [399, 99])
def test_stripe_refund_is_checked_before_first_grant_despite_stale_charge(purchase, monkeypatch, amount):
    if purchase['provider'] != 'stripe':
        pytest.skip('Stripe Charge refund aggregation can lag exact refunds')
    from app import billing_api
    from app.billing_sync import process_event, sync_session
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    monkeypatch.setattr(billing_api, 'process_event', lambda _: None)
    assert reverse(state, session, 'refund', amount, stale_payment=True).status_code == 200
    sync_session(session['id'], provider='stripe')
    full = amount == 399
    assert records()[0][0].status == ('refunded' if full else 'partially_refunded')
    assert records()[0][0].refunded_total == amount
    assert len(records()[1]) == len(records()[2]) == (0 if full else 1)
    process_event('stripe:test:evt_reversal1')
    sync_session(session['id'], provider='stripe')
    assert len(records()[1]) == len(records()[2]) == (0 if full else 1)


@pytest.mark.parametrize('resource', ['refunds', 'disputes'])
@pytest.mark.parametrize('continues', [False, True])
def test_incomplete_stripe_reversal_read_cannot_commit_a_purchase(purchase, monkeypatch, resource, continues):
    if purchase['provider'] != 'stripe':
        pytest.skip('Stripe bounded charge reversal read')
    from app import stripe_client
    from app.billing_providers import BillingError
    from app.billing_sync import sync_session
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    original = state['stripe_call']
    reads = []
    def incomplete(kind, action, *args, **kwargs):
        if kind == resource:
            reads.append(kwargs['params'])
            value = {'id': 're_loop' + str(len(reads)), 'livemode': False,
                'charge': state['payments'][session['payment_intent']]['latest_charge'],
                'amount': 1, 'currency': 'usd',
                'status': 'pending' if kind == 'refunds' else 'warning_needs_response',
                'created': int(state['at'].replace(tzinfo=timezone.utc).timestamp())}
            return {'data': [value] if continues else [], 'has_more': True}
        return original(kind, action, *args, **kwargs)
    monkeypatch.setattr(stripe_client, 'call', incomplete)
    with pytest.raises(BillingError, match='STRIPE_REVERSALS_UNVERIFIED'):
        sync_session(session['id'], provider='stripe')
    assert len(reads) == (10 if continues else 1)
    assert reads[0] == {'charge': state['payments'][session['payment_intent']]['latest_charge'], 'limit': 100}
    assert all(params['starting_after'] == 're_loop' + str(index) for index, params in enumerate(reads[1:], 1))
    assert records()[0][0].status == 'processing' and records()[0][0].external_id is None
    assert not records()[1] and not records()[2]


def test_partial_refund_keeps_pages_and_requires_explicit_admin_review(purchase):
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state)
    assert reverse(state, session, 'refund', 99, stale_payment=True).status_code == 200
    order, bucket = records()[0][0], records()[1][0]
    assert order.status == 'partially_refunded' and bucket.granted == 100 and bucket.revoked_at is None
    admin = login(state['client'], 'admin')
    detail = state['client'].get('/v1/admin/billing/orders/' + order.id, headers=admin)
    assert detail.status_code == 200, detail.text
    assert detail.json()['order']['quota_review_required'] is True
    assert detail.json()['purchase_quota']['granted'] == 100


@pytest.mark.parametrize('field', ['customer', 'currency', 'amount', 'quantity'])
def test_payment_must_match_original_owner_and_quote(purchase, field):
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    if state['provider'] == 'stripe':
        if field == 'quantity':
            state['quantity'] = 2
        else:
            payment = state['payments'][session['payment_intent']]
            payment[field] = {'customer': 'cust_other', 'currency': 'eur', 'amount': 1}[field]
    elif field == 'quantity':
        session['units'] = 2
    else:
        transaction = state['transactions'][session['order']['transaction']]
        transaction[field] = {'customer': 'cust_other', 'currency': 'EUR', 'amount': 1}[field]
    from app.billing_sync import sync_session
    from app.billing_providers import BillingError
    with pytest.raises(BillingError):
        sync_session(session['id'], provider=state['provider'])
    assert not records()[1] and not records()[2]
    assert records()[0][0].status in ('pending', 'processing')


def test_successful_purchase_is_replayable_after_price_archival(purchase):
    state = purchase
    assert buy(state).status_code == 200
    paid(state)
    from app.db import session_factory
    from app.billing_models import BillingPrice, BillingPriceBinding
    with session_factory()() as db:
        db.get(BillingPrice, 'purchase-price').status = 'archived'
        db.get(BillingPriceBinding, 'purchase-binding').status = 'archived'
        db.commit()
    assert buy(state).json()['fulfilled'] is True
    response = buy(state, 'new-after-archive')
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'BILLING_PLAN_UNAVAILABLE'


def test_existing_subscription_does_not_block_purchase_or_get_hidden_from_sync(purchase, monkeypatch):
    state = purchase
    from app.db import session_factory
    from app.billing_models import BillingCheckout, BillingPrice, BillingPriceBinding, BillingSubscription
    with session_factory()() as db:
        db.add(BillingPrice(id='prior-subscription-price', plan_id='plus', plan_revision_id='plus-v1',
            interval='month', environment='test', currency='usd', unit_amount=999, status='archived'))
        db.flush()
        db.add(BillingPriceBinding(id='prior-binding', price_id='prior-subscription-price', provider=state['provider'],
            environment='test', product_id='prod_prior', provider_price_id='price_prior' if state['provider'] == 'stripe' else None,
            status='archived'))
        db.flush()
        db.add(BillingCheckout(id='prior-checkout', owner_id=state['owner'], provider=state['provider'],
            environment='test', price_id='prior-subscription-price', binding_id='prior-binding', trial=False,
            status='completed', created_at=state['at'] - timedelta(days=2), expires_at=state['at'],
            return_url='https://comics.example/account/'))
        db.flush()
        db.add(BillingSubscription(id=state['provider'] + ':test:sub_prior', owner_id=state['owner'],
            checkout_id='prior-checkout', customer_id='cust_pagebuyer', provider=state['provider'],
            environment='test', price_id='prior-subscription-price', binding_id='prior-binding', status='active',
            synced_at=state['at'] - timedelta(hours=1)))
        db.commit()
    assert buy(state).status_code == 200
    paid(state)
    from app import billing_sync
    subscriptions = []
    monkeypatch.setattr(billing_sync, 'sync_subscription', lambda sub_id, *, provider: subscriptions.append((sub_id, provider)))
    from app.billing_checkout import sync_owner
    sync_owner(state['owner'])
    assert subscriptions == [('sub_prior', state['provider'])]


def test_owner_scoped_purchase_keys_cannot_recover_another_account(purchase):
    state = purchase
    assert buy(state).status_code == 200
    paid(state)
    other = login(state['client'], 'another-page-buyer')
    response = state['client'].post('/v1/billing/checkouts', headers={**other, 'Idempotency-Key': 'purchase-intent-1'},
        json={'provider': state['provider'], 'price_id': 'purchase-price'})
    assert response.status_code == 200 and response.json().get('fulfilled') is not True
    assert len(state['sessions']) == 2


def test_concurrent_same_purchase_intent_never_creates_second_order(purchase):
    state = purchase
    from app.billing_checkout import start_checkout
    from app.billing_models import BillingCheckout
    from app.billing_providers import BillingError
    from app.db import session_factory
    def start(_):
        try:
            return start_checkout(state['owner'], 'purchase-price', state['provider'], 'concurrent-intent')
        except BillingError as exc:
            return exc.code
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(start, range(8)))
    assert any(isinstance(result, dict) for result in results)
    assert all(isinstance(result, dict) or state['provider'] == 'creem' and result == 'CREEM_CHECKOUT_UNCERTAIN'
        for result in results)
    assert len(state['sessions']) == len(records()[0]) == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingCheckout).where(
            BillingCheckout.owner_id == state['owner'])) == 1
    if state['provider'] == 'creem':
        assert len(state['posts']) == 1


def test_payment_order_quota_and_ledger_commit_atomically(purchase, monkeypatch):
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    from app import billing_purchases
    from app.billing_sync import sync_session
    from app.billing_providers import BillingError
    original = billing_purchases.grant_purchase
    def interrupted(*args):
        original(*args)
        raise BillingError('ISOLATED_GRANT_INTERRUPTION')
    monkeypatch.setattr(billing_purchases, 'grant_purchase', interrupted)
    with pytest.raises(BillingError):
        sync_session(session['id'], provider=state['provider'])
    orders, buckets, ledger = records()
    assert orders[0].status == 'processing' and orders[0].external_id is None
    assert not buckets and not ledger
    monkeypatch.setattr(billing_purchases, 'grant_purchase', original)
    sync_session(session['id'], provider=state['provider'])
    assert len(records()[1]) == len(records()[2]) == 1


def test_expired_intent_is_never_reused_for_another_purchase(purchase):
    state = purchase
    assert buy(state).status_code == 200
    session = next(iter(state['sessions'].values()))
    session['status'] = 'expired'
    for _ in range(2):
        response = buy(state)
        assert response.status_code == 409 and response.json()['error']['code'] == 'BILLING_PURCHASE_RETRY_ALLOWED'
    assert len(state['sessions']) == 1
    assert buy(state, 'new-after-expiration').status_code == 200
    assert len(state['sessions']) == 2


def test_stripe_one_time_flow_uses_actual_sdk_serialization(purchase, monkeypatch):
    if purchase['provider'] != 'stripe':
        pytest.skip('Stripe SDK-specific transport test')
    state = purchase
    from urllib.parse import parse_qs, urlsplit
    import stripe as sdk
    from app import stripe_client
    class Transport(sdk.HTTPClient):
        name = 'isolated-purchase-sdk'
        def request(self, method, url, headers, post_data=None, **kwargs):
            parsed = urlsplit(url)
            assert parsed.hostname == 'api.stripe.com'
            params = {k: v[0] for k, v in parse_qs(post_data if method == 'post' else parsed.query).items()}
            route = parsed.path.split('/')
            if parsed.path == '/v1/checkout/sessions' and method == 'post':
                assert params['mode'] == 'payment'
                assert params['payment_intent_data[capture_method]'] == 'automatic'
                assert params['payment_intent_data[metadata][app]'] == 'node_comics'
                assert 'subscription_data[metadata][app]' not in params
                value = state['stripe_call']('checkout.sessions', 'create', params={
                    'mode': params['mode'], 'client_reference_id': params['client_reference_id'],
                    'metadata': {'app': 'node_comics', 'checkout_intent_id': params['metadata[checkout_intent_id]']}},
                    options={'idempotency_key': headers['Idempotency-Key']})
            elif parsed.path.endswith('/line_items'):
                assert params['limit'] == '2'
                value = state['stripe_call']('checkout.sessions.line_items', 'list', route[-2], params={'limit': 2})
            elif parsed.path.startswith('/v1/checkout/sessions/'):
                value = state['stripe_call']('checkout.sessions', 'retrieve', route[-1])
            elif route[-2] in ('prices', 'payment_intents', 'charges'):
                value = state['stripe_call'](route[-2], 'retrieve', route[-1])
            elif parsed.path in ('/v1/disputes', '/v1/refunds'):
                assert params['limit'] == '100' and params['charge'].startswith('ch_')
                value = state['stripe_call'](route[-1], 'list', params={'charge': params['charge'], 'limit': 100})
            else:
                raise AssertionError((method, parsed.path, params))
            return json.dumps(value), 200, {'request-id': 'req_purchase_fixture'}
    monkeypatch.setattr(stripe_client, 'client', lambda: sdk.StripeClient('sk_test_fixture', http_client=Transport(), max_network_retries=0))
    monkeypatch.setattr(stripe_client, 'call', state['real_stripe_call'])
    assert buy(state).status_code == 200
    paid(state)
    assert records()[0][0].status == 'paid' and len(records()[1]) == 1


def test_transaction_event_lookup_uses_exact_expression_index(purchase):
    if purchase['provider'] != 'creem':
        pytest.skip('Creem transaction event lookup')
    from app.billing_models import BillingEvent
    from app.billing_purchases import creem_purchase_events
    from app.db import session_factory
    with session_factory()() as db:
        db.add_all([BillingEvent(id=f'creem:test:evt_history{index}', provider='creem', environment='test',
            event_type='checkout.completed', resource_id=f'ch_history{index}',
            payload={'transaction_id': f'tran_history{index}'}, occurred_at=purchase['at']) for index in range(2000)])
        db.flush()
        statement = creem_purchase_events(db, 'tran_history1999').where(BillingEvent.event_type == 'checkout.completed')
        compiled = statement.compile(dialect=db.bind.dialect, compile_kwargs={'literal_binds': True})
        plan = db.connection().exec_driver_sql('EXPLAIN QUERY PLAN ' + str(compiled)).all()
        assert any('ix_billing_events_transaction' in str(row) for row in plan), plan
        assert len(list(db.scalars(statement))) == 1


def test_creem_processing_checkout_reuses_only_its_intent_without_granting(purchase):
    if purchase['provider'] != 'creem':
        pytest.skip('Creem has a distinct processing state')
    state = purchase
    assert buy(state).status_code == 200
    next(iter(state['sessions'].values()))['status'] = 'processing'
    response = buy(state)
    assert response.status_code == 409 and response.json()['error']['code'] == 'BILLING_PURCHASE_PROCESSING'
    assert buy(state, 'another-during-processing').status_code == 200
    assert len(state['posts']) == 2 and not records()[1] and not records()[2]
    replay = buy(state)
    assert replay.status_code == 409 and replay.json()['error']['code'] == 'BILLING_PURCHASE_PROCESSING'
    assert len(state['posts']) == 2


def test_delayed_payment_confirmation_does_not_extend_expired_purchase(purchase):
    state = purchase
    from app.db import session_factory
    from app.billing_models import BillingPlanRevision, BillingCheckout
    with session_factory()() as db:
        db.get(BillingPlanRevision, 'pages100-v1').quota_validity_days = 30
        db.commit()
    assert buy(state).status_code == 200
    state['at'] -= timedelta(days=45)
    with session_factory()() as db:
        db.scalar(select(BillingCheckout)).created_at = state['at'] - timedelta(hours=1)
        db.commit()
    paid(state)
    order, bucket = records()[0][0], records()[1][0]
    assert order.paid_at == bucket.starts_at == state['at']
    assert bucket.ends_at == state['at'] + timedelta(days=30)
    from app.models import now
    assert bucket.ends_at < now()


def test_admin_reconciles_selected_purchase_and_its_reversal_records(purchase):
    state = purchase
    assert buy(state).status_code == 200
    old = paid(state)
    original_order = records()[0][0]
    assert buy(state, 'second-purchase').status_code == 200
    paid(state)
    assert reverse(state, old, 'refund').status_code == 200
    admin = login(state['client'], 'admin')
    response = state['client'].post('/v1/admin/billing/orders/' + original_order.id + '/reconcile', headers=admin, json={})
    assert response.status_code == 200, response.text
    detail = state['client'].get('/v1/admin/billing/orders/' + original_order.id, headers=admin).json()
    assert detail['order']['status'] == 'refunded' and len(detail['refunds']) == 1
    orders, buckets, _ = records()
    assert orders[1].status == 'paid'
    assert next(bucket for bucket in buckets if bucket.billing_order_id == orders[1].id).revoked_at is None


def test_creem_unbound_reversal_waits_for_checkout_event_without_guessing(purchase):
    if purchase['provider'] != 'creem':
        pytest.skip('Creem event correlation fallback')
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    assert notify(state, 'refund.created', {'id': 'ref_delayed', 'mode': 'test', 'object': 'refund',
        'status': 'succeeded', 'refund_amount': 399, 'refund_currency': 'USD',
        'transaction': session['order']['transaction']}, 'evt_reversaldelayed').status_code == 200
    from app.db import session_factory
    from app.billing_models import BillingEvent
    with session_factory()() as db:
        event = db.get(BillingEvent, 'creem:test:evt_reversaldelayed')
        assert event.status == 'pending' and event.error_code == 'CREEM_REFUND_UNBOUND'
    assert not records()[1]
    assert notify(state, 'checkout.completed', session).status_code == 200
    assert records()[0][0].status == 'refunded' and not records()[1]


@pytest.fixture
def returning_creem_buyer(purchase, monkeypatch):
    """An established canonical customer remains frozen through further purchases."""
    from app import creem_client
    from app.billing_models import BillingCustomer, BillingPlan, BillingPlanRevision, BillingPrice, BillingPriceBinding
    from app.db import session_factory
    state = purchase
    with session_factory()() as db:
        db.add(BillingCustomer(owner_id=state['owner'], provider='creem', environment='test', customer_id='cust_pagebuyer'))
        db.add(BillingPlan(id='lite', name='Lite'))
        db.flush()
        db.add(BillingPlanRevision(id='lite-v1', plan_id='lite', version=1, name='Lite',
            monthly_redraw_pages=0, hourly_image_limit=1200, trial_days=0, trial_redraw_pages=0))
        db.flush()
        db.add(BillingPrice(id='lite-month', plan_id='lite', plan_revision_id='lite-v1',
            environment='test', currency='usd', unit_amount=599, interval='month', status='active'))
        db.flush()
        db.add(BillingPriceBinding(id='lite-month-binding', price_id='lite-month', provider='creem',
            environment='test', product_id='prod_lite', status='active'))
        db.commit()
    assert buy(state).status_code == 200
    paid(state)
    assert len(records()[1]) == 1
    original = creem_client.call
    state['pending_customer'] = 'omitted'

    def call(method, path, *, params=None, body=None):
        if method == 'GET' and path == '/products/prod_lite':
            return {'id': 'prod_lite', 'mode': 'test', 'status': 'active', 'price': 599,
                'currency': 'USD', 'billing_type': 'recurring', 'billing_period': 'every-month'}
        if method == 'GET' and path == '/subscriptions':
            assert params == {'subscription_id': 'sub_lite'}
            return copy.deepcopy(state['lite_subscription'])
        if method == 'GET' and path == '/transactions/search':
            assert params['customer_id'] == 'cust_pagebuyer'
            return {'items': copy.deepcopy(list(state['transactions'].values())), 'pagination': {'total_pages': 1}}
        value = original(method, path, params=params, body=body)
        if path == '/checkouts' and value.get('status') == 'pending':
            if state['pending_customer'] == 'omitted':
                value.pop('customer', None)
            else:
                value['customer'] = state['pending_customer']
        return value

    monkeypatch.setattr(creem_client, 'call', call)
    return state


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('next_price', ['lite-month', 'purchase-price'])
@pytest.mark.parametrize('customer', ['omitted', None])
def test_returning_creem_pending_checkout_may_omit_customer(returning_creem_buyer, next_price, customer):
    from app.billing_models import BillingCheckout
    from app.db import session_factory
    state = returning_creem_buyer
    state['pending_customer'] = customer
    headers = {**state['auth'], **({'Idempotency-Key': 'next-purchase'} if next_price == 'purchase-price' else {})}
    body = {'provider': 'creem', 'price_id': next_price}
    response = state['client'].post('/v1/billing/checkouts', headers=headers, json=body)
    assert response.status_code == 200, response.text
    assert response.json() == state['client'].post('/v1/billing/checkouts', headers=headers, json=body).json()
    assert len(state['posts']) == 2 and state['posts'][-1]['customer'] == {'id': 'cust_pagebuyer'}
    with session_factory()() as db:
        row = db.get(BillingCheckout, response.json()['checkout_id'])
        assert row.status == 'open' and row.session_id and row.customer_id == 'cust_pagebuyer'
    assert len(records()[1]) == len(records()[2]) == 1  # No grant for a pending checkout.


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
def test_creem_pack_then_lite_payment_keeps_original_purchase_bucket(returning_creem_buyer):
    from app.billing_models import BillingAccount, BillingTerm
    from app.db import session_factory
    state = returning_creem_buyer
    bucket = records()[1][0]
    original_bucket = {column.name: getattr(bucket, column.name) for column in bucket.__table__.columns}
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'provider': 'creem', 'price_id': 'lite-month'})
    assert response.status_code == 200
    session = list(state['sessions'].values())[-1]
    session.update(status='completed', customer='cust_pagebuyer', subscription='sub_lite')
    start, end = state['at'], state['at'] + timedelta(days=30)
    state['lite_subscription'] = {'id': 'sub_lite', 'mode': 'test', 'status': 'active',
        'customer': 'cust_pagebuyer', 'product': 'prod_lite', 'metadata': session['metadata'],
        'current_period_start_date': start.isoformat() + 'Z', 'current_period_end_date': end.isoformat() + 'Z',
        'next_transaction_date': end.isoformat() + 'Z', 'items': [{'product_id': 'prod_lite', 'units': 1}]}
    state['transactions']['tran_lite'] = {'id': 'tran_lite', 'mode': 'test', 'type': 'invoice', 'status': 'paid',
        'customer': 'cust_pagebuyer', 'subscription': 'sub_lite', 'currency': 'USD', 'amount': 599, 'amount_paid': 599,
        'period_start': int(start.replace(tzinfo=timezone.utc).timestamp() * 1000),
        'period_end': int(end.replace(tzinfo=timezone.utc).timestamp() * 1000)}
    for _ in range(2):
        assert notify(state, 'checkout.completed', session, 'evt_litecompleted').status_code == 200
    with session_factory()() as db:
        terms = list(db.scalars(select(BillingTerm)))
        assert len(terms) == 1 and terms[0].kind == 'paid' and terms[0].price_id == 'lite-month'
        assert terms[0].starts_at == start and terms[0].ends_at == end
        assert db.get(BillingAccount, state['owner']).trial_used_at is None
    orders, buckets, ledger = records()
    assert len(orders) == 2 and all(order.status == 'paid' for order in orders)
    assert len(buckets) == len(ledger) == 1
    assert {column.name: getattr(buckets[0], column.name) for column in buckets[0].__table__.columns} == original_bucket
    assert len(state['posts']) == 2


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('customer', ['cust_other', '', {}, {'email': 'fixture@example.invalid'}])
def test_returning_creem_customer_conflict_retains_first_error_and_never_reposts(returning_creem_buyer, customer):
    from app.billing_models import BillingCheckout, BillingOrder
    from app.db import session_factory
    state = returning_creem_buyer
    state['pending_customer'] = customer
    body = {'provider': 'creem', 'price_id': 'lite-month'}
    first = state['client'].post('/v1/billing/checkouts', headers=state['auth'], json=body)
    assert first.status_code == 409 and first.json()['error']['code'] == 'BILLING_BINDING_MISMATCH'
    retry = state['client'].post('/v1/billing/checkouts', headers=state['auth'], json=body)
    assert retry.status_code == 409 and retry.json()['error']['code'] == 'BILLING_BINDING_MISMATCH'
    with session_factory()() as db:
        row = db.scalar(select(BillingCheckout).where(BillingCheckout.price_id == 'lite-month'))
        order = db.scalar(select(BillingOrder).where(BillingOrder.checkout_id == row.id))
        assert row.status == 'unknown' and row.session_id == list(state['sessions'])[-1]
        assert row.checkout_url is None
        assert row.error_code == order.error_code == 'BILLING_BINDING_MISMATCH'
    assert len(state['posts']) == 2 and len(records()[1]) == 1


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('customer', ['omitted', None, '', {}, 'cust_other'])
def test_completed_creem_checkout_requires_matching_customer(returning_creem_buyer, customer):
    from app.billing_checkout import bind_session
    from app.billing_models import BillingCheckout
    from app.billing_providers import BillingError
    from app.db import session_factory
    state = returning_creem_buyer
    state['pending_customer'] = 'cust_pagebuyer'
    response = buy(state, 'next-purchase')
    assert response.status_code == 200
    value = copy.deepcopy(list(state['sessions'].values())[-1])
    value['status'] = 'completed'
    if customer == 'omitted':
        value.pop('customer', None)
    else:
        value['customer'] = customer
    with pytest.raises(BillingError, match='BILLING_BINDING_MISMATCH'):
        bind_session(response.json()['checkout_id'], value)
    with session_factory()() as db:
        assert db.get(BillingCheckout, response.json()['checkout_id']).status == 'open'
    assert len(records()[1]) == 1


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
def test_first_completed_creem_checkout_requires_customer(purchase):
    from app.billing_checkout import bind_session
    from app.billing_providers import BillingError
    state = purchase
    response = buy(state)
    assert response.status_code == 200
    value = copy.deepcopy(list(state['sessions'].values())[-1])
    value.update(status='completed', customer=None)
    with pytest.raises(BillingError, match='BILLING_BINDING_MISMATCH'):
        bind_session(response.json()['checkout_id'], value)
    assert not records()[1]
