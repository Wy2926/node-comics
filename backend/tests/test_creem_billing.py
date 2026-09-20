"""Creem HTTP contract and durable grants in disposable SQLite; no payment account calls."""
import copy
import hashlib
import hmac
import json
import math
from datetime import timedelta, timezone
from urllib.parse import urlsplit

import httpx
import pytest
from sqlalchemy import func, select
from conftest import login


def iso(value):
    return value.replace(tzinfo=timezone.utc).isoformat().replace('+00:00', 'Z')


@pytest.fixture
def creem_billing(monkeypatch, request):
    for key, value in {'STRIPE_ENABLED': 'false', 'CREEM_ENABLED': 'true', 'CREEM_ENVIRONMENT': 'test',
        'CREEM_API_KEY': 'creem_test_isolated_fixture', 'CREEM_WEBHOOK_SECRET': 'creem_fixture_webhook',
        'CREEM_RETURN_URL': 'https://comics.example/account/'}.items():
        monkeypatch.setenv(key, value)
    client = request.getfixturevalue('client')
    from app.db import session_factory
    from app.billing_models import BillingPrice, BillingPriceBinding
    from app.models import now
    state = {'client': client, 'products': {}, 'sessions': {}, 'subscriptions': {}, 'transactions': {},
        'requests': [], 'posts': [], 'lost_create': False, 'fail_page': False, 'reject_create': False,
        'at': now().replace(microsecond=0) - timedelta(minutes=1), 'price_id': 'creem-month'}
    with session_factory()() as db:
        for interval, amount in [('month', 999), ('year', 9999)]:
            price_id, product_id = 'creem-' + interval, 'prod_' + interval
            db.add(BillingPrice(id=price_id, plan_id='plus', plan_revision_id='plus-v1',
                environment='test', currency='usd', unit_amount=amount, interval=interval, status='active'))
            db.flush()
            db.add(BillingPriceBinding(id=price_id + '-binding', price_id=price_id, provider='creem',
                environment='test', product_id=product_id, trial_product_id=product_id + 'trial', status='active'))
            for suffix, days in [('', 0), ('trial', 7)]:
                state['products'][product_id + suffix] = {'id': product_id + suffix, 'object': 'product',
                    'mode': 'test', 'status': 'active', 'price': amount, 'currency': 'USD',
                    'billing_type': 'recurring', 'billing_period': 'every-' + interval, 'trial_period_days': days}
        db.commit()

    def transport(method, url, *, params=None, json=None, headers=None, **kwargs):
        parsed = urlsplit(url)
        assert parsed.scheme == 'https' and parsed.hostname == 'test-api.creem.io'
        assert headers == {'x-api-key': 'creem_test_isolated_fixture'}
        assert kwargs['timeout'] == 20 and kwargs['follow_redirects'] is False
        params, body, path = params or {}, json or {}, parsed.path
        state['requests'].append((method, path, copy.deepcopy(params), copy.deepcopy(body)))
        if method == 'GET' and path.startswith('/v1/products/'):
            value = state['products'][path.split('/')[-1]]
        elif method == 'POST' and path == '/v1/checkouts':
            state['posts'].append(copy.deepcopy(body))
            if state['reject_create']:
                return httpx.Response(400, json={'error': 'invalid product'}, request=httpx.Request(method, url))
            checkout_id = 'ch_fixture' + str(len(state['sessions']) + 1)
            value = {'id': checkout_id, 'object': 'checkout', 'mode': 'test', 'status': 'pending',
                **body, 'product': body['product_id'], 'customer': (body.get('customer') or {}).get('id'), 'subscription': None,
                'checkout_url': 'https://www.creem.io/test/checkout/' + checkout_id}
            # The real sandbox response preserves metadata but omits request_id.
            value.pop('request_id', None)
            state['sessions'][checkout_id] = value
            if state['lost_create']:
                state['lost_create'] = False
                raise httpx.ReadTimeout('isolated response loss')
        elif method == 'GET' and path == '/v1/checkouts':
            # GET includes correlation but does not return the one-time hosted URL.
            value = {**state['sessions'][params['checkout_id']]}
            value.setdefault('request_id', value['metadata']['checkout_intent_id'])
            value.pop('checkout_url', None)
        elif method == 'GET' and path == '/v1/subscriptions':
            value = state['subscriptions'][params['subscription_id']]
        elif method == 'GET' and path == '/v1/transactions/search':
            rows = sorted((item for item in state['transactions'].values()
                if item['customer'] == params['customer_id']), key=lambda item: item['id'])
            page = params['page_number']
            if state['fail_page'] and page > 1:
                raise httpx.ReadTimeout('isolated pagination failure')
            value = {'items': rows[(page-1)*2:page*2], 'pagination': {'total_pages': max(1, math.ceil(len(rows)/2))}}
        elif method == 'GET' and path == '/v1/transactions':
            value = state['transactions'][params['transaction_id']]
        elif method == 'POST' and path == '/v1/customers/billing':
            state['portal_customer'] = body['customer_id']
            value = {'customer_portal_link': 'https://creem.io/my-orders/login/fixture'}
        else:
            raise AssertionError((method, path, params, body))
        return httpx.Response(200, json=copy.deepcopy(value), request=httpx.Request(method, url))

    monkeypatch.setattr(httpx, 'request', transport)
    state['auth'] = login(client, 'creem-buyer')
    state['owner'] = client.get('/v1/me', headers=state['auth']).json()['user']['id']
    return state


def checkout(state, price_id=None):
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'price_id': price_id or state['price_id'], 'provider': 'creem'})
    assert response.status_code == 200, response.text
    return response.json()


def mark_trial_used(state):
    from app.billing_models import BillingAccount, BillingCustomer
    from app.db import session_factory
    with session_factory()() as db:
        # Historical Stripe trial usage must also suppress a new Creem trial.
        db.add(BillingAccount(owner_id=state['owner'], trial_used_at=state['at'] - timedelta(days=30)))
        db.add(BillingCustomer(owner_id=state['owner'], provider='stripe', environment='test', customer_id='cus_prior'))
        db.commit()


def complete(state, trial=True, synchronize=True):
    if not state['sessions']:
        if not trial:
            mark_trial_used(state)
        checkout(state)
    session = next(iter(state['sessions'].values()))
    session.update(status='completed', customer='cust_fixture', subscription='sub_fixture')
    from app.entitlements import month_boundary
    start = state['at']
    end = start + timedelta(days=7) if trial else month_boundary(start, 12 if state['price_id'].endswith('year') else 1, 'UTC')
    product_id = session['product_id']
    session['product'] = product_id
    state['subscriptions']['sub_fixture'] = {'id': 'sub_fixture', 'object': 'subscription', 'mode': 'test',
        'customer': 'cust_fixture', 'product': product_id, 'metadata': session['metadata'],
        'status': 'trialing' if trial else 'active', 'current_period_start_date': iso(start),
        'current_period_end_date': iso(end), 'next_transaction_date': iso(end),
        'items': [{'id': 'sitem_fixture', 'product_id': product_id, 'units': 1}]}
    if trial:
        # Real Creem trial invoices retain the normal price but settle for zero.
        transaction(state, index='trial', start=start, end=end)['amount_paid'] = 0
    if synchronize:
        from app.creem_billing_sync import sync_session
        sync_session(session['id'])
    return session


def transaction(state, *, index=1, start=None, end=None, status='paid'):
    from app.entitlements import month_boundary
    start = start or state['at']
    amount, months = (9999, 12) if state['price_id'].endswith('year') else (999, 1)
    value = {'id': 'tran_fixture' + str(index), 'object': 'transaction', 'type': 'invoice', 'mode': 'test',
        'customer': 'cust_fixture', 'subscription': 'sub_fixture', 'currency': 'USD',
        'amount': amount, 'amount_paid': amount, 'status': status,
        'period_start': int(start.replace(tzinfo=timezone.utc).timestamp()*1000),
        'period_end': int((end or month_boundary(start, months, 'UTC')).replace(tzinfo=timezone.utc).timestamp()*1000)}
    state['transactions'][value['id']] = value
    return value


def periods():
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    with session_factory()() as db:
        return list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.source == 'subscription')))


def rights(state, at=None):
    if at is None:
        return state['client'].get('/v1/me/entitlements', headers=state['auth']).json()
    from app.db import session_factory
    from app.models import User
    from app.entitlements import entitlements_json
    with session_factory()() as db:
        return entitlements_json(db, db.get(User, state['owner']), at)


def signed_event(state, kind, obj, event_id='evt_creemfixture'):
    body = json.dumps({'id': event_id, 'eventType': kind, 'created_at': int(state['at'].replace(tzinfo=timezone.utc).timestamp()*1000), 'object': obj}).encode()
    signature = hmac.new(b'creem_fixture_webhook', body, hashlib.sha256).hexdigest()
    return body, {'creem-signature': signature, 'Content-Type': 'application/json'}


def test_checkout_reuses_session_and_selects_trial_product(creem_billing):
    state = creem_billing
    first = checkout(state)
    assert first == checkout(state)
    assert first['provider'] == 'creem' and first['environment'] == 'test' and first['trial'] is True
    assert first['checkout_url'].startswith('https://www.creem.io/test/checkout/')
    assert len(state['posts']) == 1
    request = state['posts'][0]
    assert request['product_id'] == 'prod_monthtrial' and request['units'] == 1
    assert request['success_url'] == 'https://comics.example/payment/success/'
    assert request['metadata']['checkout_intent_id'] == request['request_id']
    assert 'request_id' not in next(iter(state['sessions'].values()))
    assert not periods()


@pytest.mark.parametrize('operation', ['session', 'subscription'])
def test_present_checkout_request_id_must_match_original_intent(creem_billing, operation):
    state = creem_billing
    session = complete(state, synchronize=False)
    session['request_id'] = 'different_checkout_intent'
    from app.creem_billing_sync import sync_session, sync_subscription
    from app.billing_providers import BillingError
    with pytest.raises(BillingError):
        if operation == 'session':
            sync_session(session['id'])
        else:
            sync_subscription('sub_fixture')
    assert not periods()


def test_trial_used_on_stripe_selects_nontrial_creem_product(creem_billing):
    state = creem_billing
    mark_trial_used(state)
    assert checkout(state)['trial'] is False
    assert state['posts'][0]['product_id'] == 'prod_month'


def test_unknown_post_is_never_resent_and_webhook_recovers_original(creem_billing):
    state = creem_billing
    state['lost_create'] = True
    body = {'provider': 'creem', 'price_id': state['price_id']}
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'], json=body)
    assert response.status_code == 503
    for _ in range(2):
        assert state['client'].post('/v1/billing/checkouts', headers=state['auth'], json=body).status_code in (409, 503)
    assert len(state['posts']) == 1
    status = state['client'].get('/v1/billing/status', headers=state['auth']).json()
    assert status['checkout_pending'] and status['checkout_provider'] == 'creem'
    assert status['checkout_price']['id'] == state['price_id']
    session = complete(state, synchronize=False)
    payload, headers = signed_event(state, 'checkout.completed', session)
    assert state['client'].post('/webhooks/creem', content=payload, headers=headers).status_code == 200
    assert [period.granted for period in periods()] == [30]
    assert len(state['posts']) == 1


def test_signed_trial_webhook_replay_rejects_tamper_and_environment(creem_billing):
    state = creem_billing
    session = complete(state, synchronize=False)
    payload, headers = signed_event(state, 'checkout.completed', session)
    for _ in range(2):
        assert state['client'].post('/webhooks/creem', content=payload, headers=headers).status_code == 200
    from app.db import session_factory
    from app.billing_models import BillingEvent
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingEvent)) == 1
        assert db.get(BillingEvent, 'creem:test:evt_creemfixture').status == 'processed'
    assert [period.granted for period in periods()] == [30]
    assert state['client'].post('/webhooks/creem', content=payload + b' ', headers=headers).status_code == 401
    payload, headers = signed_event(state, 'checkout.completed', {**session, 'mode': 'prod'}, 'evt_wrongmode')
    assert state['client'].post('/webhooks/creem', content=payload, headers=headers).status_code == 400


@pytest.mark.parametrize('interval', ['month', 'year'])
def test_settled_period_grants_only_once_and_annual_quota_is_monthly(creem_billing, interval):
    state = creem_billing
    state['price_id'] = 'creem-' + interval
    complete(state, trial=False)
    assert not periods()  # Subscription active is not evidence of a settled transaction.
    transaction(state)
    from app.creem_billing_sync import sync_subscription
    sync_subscription('sub_fixture')
    sync_subscription('sub_fixture')
    buckets = sorted(periods(), key=lambda item: item.starts_at)
    assert len(buckets) == (12 if interval == 'year' else 1)
    assert all(item.granted == 300 for item in buckets)
    assert rights(state)['modes']['redraw']['quota']['available'] == 300
    if interval == 'year':
        assert buckets[0].ends_at == buckets[1].starts_at
        assert rights(state, buckets[1].starts_at)['modes']['redraw']['quota']['available'] == 300
    from app.db import session_factory
    from app.billing_models import BillingOrder, BillingInvoice
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 1
        assert db.scalar(select(BillingOrder)).status == 'paid'


def test_trial_conversion_closes_trial_quota_and_preserves_order_history(creem_billing):
    state = creem_billing
    complete(state)
    assert rights(state)['modes']['redraw']['quota']['available'] == 30
    state['subscriptions']['sub_fixture']['status'] = 'active'
    transaction(state)
    from app.creem_billing_sync import sync_subscription
    sync_subscription('sub_fixture')
    sync_subscription('sub_fixture')
    assert rights(state)['modes']['redraw']['quota']['available'] == 300
    from app.db import session_factory
    from app.billing_models import BillingOrder, BillingOrderTransition
    with session_factory()() as db:
        orders = list(db.scalars(select(BillingOrder)))
        assert {(order.kind, order.status) for order in orders} == {('initial', 'trialing'), ('renewal', 'paid')}
        initial = next(order for order in orders if order.kind == 'initial')
        transitions = list(db.scalars(select(BillingOrderTransition).where(BillingOrderTransition.order_id == initial.id)
            .order_by(BillingOrderTransition.created_at)))
        statuses = [item.to_status for item in transitions if item.from_status != item.to_status]
        assert statuses == ['creating', 'pending', 'processing', 'trialing']
        assert [item.detail['subscription_to'] for item in transitions if 'subscription_to' in item.detail] == ['trialing', 'active']


@pytest.mark.parametrize('invalid', ['customer', 'currency', 'amount', 'period', 'quantity'])
def test_untrusted_transaction_or_subscription_cannot_grant(creem_billing, invalid):
    state = creem_billing
    complete(state, trial=False)
    value = transaction(state)
    if invalid == 'customer':
        value['customer'] = 'cust_other'
    elif invalid == 'currency':
        value['currency'] = 'EUR'
    elif invalid == 'amount':
        value['amount'] = 1
    elif invalid == 'period':
        value.pop('period_end')
    else:
        state['subscriptions']['sub_fixture']['items'][0]['units'] = 2
    from app.creem_billing_sync import sync_subscription
    from app.billing_providers import BillingError
    with pytest.raises(BillingError):
        sync_subscription('sub_fixture', value['id'])
    assert not periods()


@pytest.mark.parametrize('status', ['pending', 'declined'])
def test_pending_or_failed_charge_does_not_grant(creem_billing, status):
    state = creem_billing
    complete(state, trial=False)
    transaction(state, status=status)
    from app.creem_billing_sync import sync_subscription
    sync_subscription('sub_fixture')
    assert not periods() and rights(state)['plan'] == 'free'


@pytest.mark.parametrize('status,event_type', [('refunded', 'refund.created'), ('chargedBack', 'dispute.created')])
def test_refund_or_dispute_revokes_access_and_records_transition(creem_billing, status, event_type):
    state = creem_billing
    state['price_id'] = 'creem-year'
    complete(state, trial=False)
    value = transaction(state)
    from app.creem_billing_sync import sync_subscription
    sync_subscription('sub_fixture')
    assert rights(state)['plan'] == 'plus'
    value['status'] = status
    payload, headers = signed_event(state, event_type,
        {'id': 'ref_fixture', 'mode': 'test', 'transaction': value['id']})
    for _ in range(2):
        assert state['client'].post('/webhooks/creem', content=payload, headers=headers).status_code == 200
    assert rights(state)['plan'] == 'free'
    from app.db import session_factory
    from app.billing_models import BillingOrder, BillingTerm, BillingOrderTransition
    with session_factory()() as db:
        assert db.scalar(select(BillingTerm)).revoked_at is not None
        order = db.scalar(select(BillingOrder))
        assert order.status == ('refunded' if status == 'refunded' else 'disputed')
        assert db.scalar(select(func.count()).select_from(BillingOrderTransition).where(
            BillingOrderTransition.order_id == order.id, BillingOrderTransition.to_status == order.status)) == 1
    future = sorted(periods(), key=lambda item: item.starts_at)[-1]
    assert rights(state, future.starts_at)['plan'] == 'free'


def test_portal_never_uses_another_users_customer(creem_billing):
    state = creem_billing
    complete(state)
    other = login(state['client'], 'other-creem-buyer')
    assert state['client'].post('/v1/billing/portal', headers=other, json={'provider': 'creem'}).status_code == 404
    response = state['client'].post('/v1/billing/portal', headers=state['auth'], json={'provider': 'creem'})
    assert response.status_code == 200 and response.json()['provider'] == 'creem'
    assert response.json()['url'].startswith('https://creem.io/my-orders/login/')
    assert state['portal_customer'] == 'cust_fixture'


def test_paginated_transaction_failure_rolls_back_partial_grants(creem_billing):
    state = creem_billing
    complete(state, trial=False)
    from app.entitlements import month_boundary
    for index in range(4):
        transaction(state, index=index, start=month_boundary(state['at'], -index, 'UTC'))
    state['fail_page'] = True
    from app.creem_billing_sync import sync_subscription
    from app.billing_providers import BillingError
    with pytest.raises(BillingError):
        sync_subscription('sub_fixture')
    assert not periods()
    state['fail_page'] = False
    sync_subscription('sub_fixture')
    assert len(periods()) == 4


@pytest.mark.parametrize('url', ['https://creem.io.evil.test/checkout/x', 'https://creem.io/dashboard',
    'http://creem.io/checkout/x', 'https://user@creem.io/checkout/x', 'https://creem.io:444/checkout/x'])
def test_creem_rejects_untrusted_hosted_links(url):
    from app.creem_client import hosted_url
    from app.billing_providers import BillingError
    with pytest.raises(BillingError):
        hosted_url(url)


@pytest.mark.parametrize('value', [None, [], 'not-an-object', 1,
    {'id': 'evt_badshape', 'eventType': 'subscription.trialing', 'object': None},
    {'id': 'evt_badshape', 'eventType': 'subscription.trialing', 'object': []},
    {'id': 'evt_badshape', 'eventType': 'subscription.trialing', 'object': 'invalid'}])
def test_signed_malformed_webhook_is_a_bad_request_not_server_error(creem_billing, value):
    payload = json.dumps(value).encode()
    headers = {'creem-signature': hmac.new(b'creem_fixture_webhook', payload, hashlib.sha256).hexdigest(),
        'Content-Type': 'application/json'}
    response = creem_billing['client'].post('/webhooks/creem', content=payload, headers=headers)
    assert response.status_code == 400


def test_product_validation_failure_allows_corrected_new_attempt_without_previous_post(creem_billing):
    state = creem_billing
    product = state['products']['prod_monthtrial']
    product['price'] = 1
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'price_id': state['price_id'], 'provider': 'creem'})
    assert response.status_code == 409 and not state['posts']
    assert not state['client'].get('/v1/billing/status', headers=state['auth']).json()['checkout_pending']
    product['price'] = 999
    checkout(state)
    assert len(state['posts']) == 1
    from app.db import session_factory
    from app.billing_models import BillingCheckout
    with session_factory()() as db:
        assert sorted(db.scalars(select(BillingCheckout.status))) == ['failed', 'open']


def test_definitive_post_rejection_allows_new_attempt_unlike_timeout(creem_billing):
    state = creem_billing
    state['reject_create'] = True
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'price_id': state['price_id'], 'provider': 'creem'})
    assert response.status_code == 409 and len(state['posts']) == 1
    assert not state['client'].get('/v1/billing/status', headers=state['auth']).json()['checkout_pending']
    state['reject_create'] = False
    checkout(state)
    assert len(state['posts']) == 2 and state['posts'][0]['request_id'] != state['posts'][1]['request_id']


@pytest.mark.parametrize('trial', [False, True])
def test_cancellation_and_old_events_never_extend_original_entitlement(creem_billing, trial):
    state = creem_billing
    complete(state, trial=trial)
    if not trial:
        transaction(state)
    from app.creem_billing_sync import sync_subscription
    sync_subscription('sub_fixture')
    end = max(period.ends_at for period in periods())
    subscription = state['subscriptions']['sub_fixture']
    subscription.update(status='canceled', canceled_at=iso(state['at'] + timedelta(seconds=10)))
    sync_subscription('sub_fixture')
    # Cancellation stops renewal; the previously granted access expires at its original end.
    assert rights(state)['plan'] == 'plus'
    assert rights(state, end)['plan'] == 'free'
    stale = {**subscription, 'status': 'trialing' if trial else 'active', 'canceled_at': None}
    payload, headers = signed_event(state, 'subscription.trialing' if trial else 'subscription.active', stale, 'evt_oldstate')
    assert state['client'].post('/webhooks/creem', content=payload, headers=headers).status_code == 200
    assert max(period.ends_at for period in periods()) == end
    current = state['client'].get('/v1/billing/status', headers=state['auth']).json()['subscription']
    assert current['status'] == 'canceled' and current['next_billed_at'] is None
    assert rights(state, end)['plan'] == 'free'


def test_trial_canceled_before_first_sync_does_not_grant_from_late_trialing_event(creem_billing):
    state = creem_billing
    complete(state, synchronize=False)
    subscription = state['subscriptions']['sub_fixture']
    stale = copy.deepcopy(subscription)
    subscription.update(status='canceled', canceled_at=iso(state['at'] + timedelta(seconds=10)))
    payload, headers = signed_event(state, 'subscription.trialing', stale, 'evt_latetrial')
    assert state['client'].post('/webhooks/creem', content=payload, headers=headers).status_code == 200
    assert not periods() and rights(state)['plan'] == 'free'
    assert state['client'].get('/v1/billing/status', headers=state['auth']).json()['trial_eligible'] is False


@pytest.mark.parametrize('interval', ['month', 'year'])
def test_real_zero_paid_trial_invoice_is_receipted_without_paid_grant_or_audit_churn(creem_billing, interval):
    state = creem_billing
    state['price_id'] = 'creem-' + interval
    state['at'] = state['at'].replace(microsecond=678000)
    complete(state)
    value = state['transactions']['tran_fixturetrial']
    assert value['amount'] == (9999 if interval == 'year' else 999) and value['amount_paid'] == 0
    from app.creem_billing_sync import sync_subscription
    from app.db import session_factory
    from app.billing_models import BillingInvoice, BillingOrder, BillingOrderTransition, BillingTerm
    with session_factory()() as db:
        before = db.scalar(select(func.count()).select_from(BillingOrderTransition))
    for _ in range(2):
        sync_subscription('sub_fixture', value['id'])
    assert [period.granted for period in periods()] == [30]
    assert rights(state)['modes']['redraw']['quota']['available'] == 30
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 1
        assert db.scalar(select(BillingInvoice)).total == 0
        assert db.scalar(select(BillingOrder)).status == 'trialing'
        assert db.scalar(select(func.count()).select_from(BillingOrderTransition)) == before
        assert list(db.scalars(select(BillingTerm.kind))) == ['trial']


@pytest.mark.parametrize('interval', ['month', 'year'])
@pytest.mark.parametrize('targeted', [False, True])
def test_late_first_paid_callback_recovers_expired_trial_before_current_paid_term(creem_billing, interval, targeted):
    state = creem_billing
    state['price_id'] = 'creem-' + interval
    state['at'] -= timedelta(days=8)
    complete(state, synchronize=False)
    from app.db import session_factory
    from app.billing_models import BillingAccount, BillingCheckout, BillingInvoice, BillingOrder
    from app.entitlements import month_boundary
    with session_factory()() as db:
        row = db.scalar(select(BillingCheckout))
        row.created_at = state['at'] - timedelta(minutes=1)
        db.commit()
    paid_start = state['at'] + timedelta(days=7)
    paid_end = month_boundary(paid_start, 12 if interval == 'year' else 1, 'UTC')
    state['subscriptions']['sub_fixture'].update(status='active',
        current_period_start_date=iso(paid_start), current_period_end_date=iso(paid_end), next_transaction_date=iso(paid_end))
    value = transaction(state, index=0, start=paid_start, end=paid_end)
    from app.creem_billing_sync import sync_subscription
    for _ in range(2):
        sync_subscription('sub_fixture', value['id'] if targeted else None)
    buckets = sorted(periods(), key=lambda item: item.starts_at)
    assert len(buckets) == (13 if interval == 'year' else 2)
    assert buckets[0].granted == 30 and buckets[0].ends_at == paid_start
    assert all(bucket.granted == 300 for bucket in buckets[1:])
    assert rights(state)['modes']['redraw']['quota']['available'] == 300
    with session_factory()() as db:
        assert db.get(BillingAccount, state['owner']).trial_used_at is not None
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 2
        assert {(item.kind, item.status) for item in db.scalars(select(BillingOrder))} == {('initial', 'trialing'), ('renewal', 'paid')}


def test_full_annual_zero_paid_discount_still_grants_paid_monthly_quotas(creem_billing):
    state = creem_billing
    state['price_id'] = 'creem-year'
    complete(state, trial=False)
    value = transaction(state)
    value['amount_paid'] = 0
    from app.creem_billing_sync import sync_subscription
    sync_subscription('sub_fixture')
    sync_subscription('sub_fixture')
    assert len(periods()) == 12 and all(period.granted == 300 for period in periods())
    assert rights(state)['modes']['redraw']['quota']['available'] == 300
    from app.db import session_factory
    from app.billing_models import BillingOrder, BillingTerm
    with session_factory()() as db:
        assert db.scalar(select(BillingOrder)).status == 'paid'
        assert list(db.scalars(select(BillingTerm.kind))) == ['paid']


@pytest.mark.parametrize('change', [{'amount': 1}, {'amount_paid': 999}])
def test_trial_length_transaction_with_unverified_amounts_grants_nothing(creem_billing, change):
    state = creem_billing
    complete(state, synchronize=False)
    state['transactions']['tran_fixturetrial'].update(change)
    from app.creem_billing_sync import sync_subscription
    from app.billing_providers import BillingError
    with pytest.raises(BillingError):
        sync_subscription('sub_fixture')
    assert not periods()


@pytest.mark.parametrize('reversed_status', ['refunded', 'chargedBack'])
@pytest.mark.parametrize('stale_status', ['paid', 'partialRefund'])
def test_reversal_before_first_paid_receipt_cannot_be_undone_by_stale_paid_snapshot(creem_billing, reversed_status, stale_status):
    state = creem_billing
    state['price_id'] = 'creem-year'
    complete(state, trial=False)
    value = transaction(state, status=reversed_status)
    from app.creem_billing_sync import sync_subscription
    sync_subscription('sub_fixture')
    assert not periods()
    value['status'] = stale_status
    for _ in range(2):
        sync_subscription('sub_fixture')
    assert not periods() and rights(state)['plan'] == 'free'
    from app.db import session_factory
    from app.billing_models import BillingInvoice, BillingOrder, BillingOrderTransition
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 0
        assert db.scalar(select(BillingOrder)).status == ('refunded' if reversed_status == 'refunded' else 'disputed')
        assert db.scalar(select(func.count()).select_from(BillingOrderTransition).where(BillingOrderTransition.to_status == 'paid')) == 0


def test_partial_refund_before_first_receipt_keeps_paid_access(creem_billing):
    state = creem_billing
    complete(state, trial=False)
    value = transaction(state, status='partialRefund')
    value['amount_paid'] = 799
    from app.creem_billing_sync import sync_subscription
    for _ in range(2):
        sync_subscription('sub_fixture')
    assert [period.granted for period in periods()] == [300]
    assert rights(state)['plan'] == 'plus'
    from app.db import session_factory
    from app.billing_models import BillingInvoice, BillingOrder
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 1
        assert db.scalar(select(BillingOrder)).status == 'partially_refunded'
    value['status'] = 'refunded'
    sync_subscription('sub_fixture')
    assert rights(state)['plan'] == 'free'
    with session_factory()() as db:
        assert db.scalar(select(BillingOrder)).status == 'refunded'
