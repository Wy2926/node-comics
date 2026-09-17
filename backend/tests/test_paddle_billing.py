"""Billing account binding and atomic quota settlement with isolated Paddle contracts."""
from datetime import datetime, timedelta
import copy
import hashlib
import hmac
import json
import time
import httpx
import pytest
from sqlalchemy import select, func
from conftest import login

TRIAL = 'pri_' + 'a' * 26
PAID = 'pri_' + 'b' * 26
PRODUCT = 'pro_' + 'c' * 26
SUB = 'sub_' + 'd' * 26
CUSTOMER = 'ctm_' + 'e' * 26
TXN = 'txn_' + 'f' * 26
SECRET = 'test-webhook-secret'


@pytest.fixture
def billing(monkeypatch, request):
    for key, value in {'PADDLE_ENABLED':'true', 'PADDLE_ENVIRONMENT':'sandbox',
        'PADDLE_API_KEY':'pdl_sdbx_apikey_test', 'PADDLE_CLIENT_TOKEN':'test_public',
        'PADDLE_WEBHOOK_SECRET':SECRET, 'PADDLE_PRODUCT_ID':PRODUCT,
        'PADDLE_TRIAL_PRICE_ID':TRIAL, 'PADDLE_STANDARD_PRICE_ID':PAID,
        'PADDLE_CHECKOUT_URL':'https://checkout.example.test/billing/checkout'}.items():
        monkeypatch.setenv(key, value)
    client = request.getfixturevalue('client')
    from app.models import now
    from app import paddle_client
    state = {'posts':0, 'at':now(), 'transactions':{}, 'sub':None, 'uncertain':False,
             'requests':[], 'listed_sizes':[]}
    def price(price_id):
        return {'id':price_id, 'product_id':PRODUCT, 'unit_price':{'amount':'999','currency_code':'USD'},
            'billing_cycle':{'interval':'month','frequency':1},
            'trial_period':{'interval':'day','frequency':7,'requires_payment_method':True} if price_id == TRIAL else None}
    state['price'] = price
    def api(method, path, body=None):
        if path.startswith('/prices/'):
            return price(path.split('/')[-1])
        if method == 'POST' and path == '/transactions':
            state['posts'] += 1
            transaction = {'id':TXN, 'status':'draft', 'subscription_id':None, 'customer_id':CUSTOMER,
                'created_at':now().isoformat()+'Z', 'updated_at':now().isoformat()+'Z',
                'currency_code':'USD', 'custom_data':body['custom_data'],
                'items':[{'price':price(body['items'][0]['price_id']), 'quantity':1}]}
            state['transactions'][TXN] = transaction
            if state['uncertain']:
                raise httpx.ReadTimeout('isolated lost POST response')
            return copy.deepcopy(transaction)
        if path.startswith('/transactions/'):
            return copy.deepcopy(state['transactions'][path.split('/')[-1]])
        if method == 'POST' and path.endswith('/cancel'):
            state['sub']['scheduled_change']={'action':'cancel','effective_at':state['sub']['current_billing_period']['ends_at']}
            return copy.deepcopy(state['sub'])
        if path.startswith('/subscriptions/'):
            return copy.deepcopy(state['sub'])
        raise AssertionError((method,path))
    def handle(request):
        method, path, params = request.method, request.url.path, dict(request.url.params)
        state['requests'].append((method, path, params))
        if method == 'GET' and path == '/transactions':
            if params.get('after') and state.get('fail_next_page'):
                return httpx.Response(503, json={'error':{'code':'service_unavailable'}})
            rows = list(state['transactions'].values())
            for key in ('status', 'subscription_id'):
                if key in params:
                    rows = [row for row in rows if row.get(key) == params[key]]
            for key in ('created_at', 'updated_at'):
                if key+'[GTE]' in params:
                    cutoff = datetime.fromisoformat(params[key+'[GTE]'].replace('Z', '+00:00'))
                    rows = [row for row in rows if datetime.fromisoformat(row[key].replace('Z', '+00:00')) >= cutoff]
            descending = params.get('order_by', 'id[DESC]') == 'id[DESC]'
            rows.sort(key=lambda row: row['id'], reverse=descending)
            if params.get('after'):
                rows = [row for row in rows if (row['id'] < params['after'] if descending else row['id'] > params['after'])]
            size = min(int(params.get('per_page', 30)), 30)
            more, rows = len(rows) > size, rows[:size]
            state['listed_sizes'].append(len(rows))
            next_url = str(request.url.copy_set_param('after', rows[-1]['id'])) if more else None
            return httpx.Response(200, json={'data':copy.deepcopy(rows), 'meta':{'pagination':{
                'has_more':more, 'next':next_url, 'per_page':size}}})
        data = api(method, path, json.loads(request.content) if request.content else None)
        return httpx.Response(200, json={'data':data})
    real_client = httpx.Client
    monkeypatch.setattr(paddle_client.httpx, 'Client',
        lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    state['auth'] = login(client, 'buyer')
    state['owner_id'] = client.get('/v1/me', headers=state['auth']).json()['user']['id']
    state['client'] = client
    return state


def complete_trial(state):
    client, auth = state['client'], state['auth']
    response = client.post('/v1/billing/checkouts', headers=auth)
    assert response.status_code == 200, response.text
    at = state['at']
    dates = {'starts_at':at.isoformat()+'Z', 'ends_at':(at+timedelta(days=7)).isoformat()+'Z'}
    transaction = state['transactions'][TXN]
    from app.models import now
    transaction.update(status='completed', subscription_id=SUB, billing_period=dates,
        updated_at=now().isoformat()+'Z', details={'totals':{'grand_total':'0'}})
    state['sub'] = {'id':SUB,'customer_id':CUSTOMER,'status':'trialing','currency_code':'USD',
        'custom_data':transaction['custom_data'], 'items':[{'price':state['price'](TRIAL),'quantity':1,'trial_dates':dates}],
        'current_billing_period':dates, 'next_billed_at':dates['ends_at'], 'updated_at':at.isoformat()+'Z'}
    return response.json()


def deliver(state, event_type='subscription.trialing', event_id=None, resource_id=SUB):
    event_id = event_id or 'evt_' + 'g' * 26
    body = json.dumps({'event_id':event_id,'event_type':event_type,
        'occurred_at':state['at'].isoformat()+'Z','data':{'id':resource_id}}).encode()
    stamp = str(int(time.time()))
    signature = hmac.new(SECRET.encode(), stamp.encode()+b':'+body, hashlib.sha256).hexdigest()
    return state['client'].post('/webhooks/paddle', content=body, headers={'Paddle-Signature':f'ts={stamp};h1={signature}'})


def rights(state):
    return state['client'].get('/v1/me/entitlements', headers=state['auth']).json()


def paid_transaction(state, suffix='h', start=None):
    from app.models import now
    start = start or state['at'] + timedelta(seconds=1)
    txn_id = 'txn_' + suffix * 26
    transaction = copy.deepcopy(state['transactions'][TXN])
    transaction.update(id=txn_id, status='completed', updated_at=now().isoformat()+'Z', details={'totals':{'grand_total':'999'}},
        billing_period={'starts_at':start.isoformat()+'Z','ends_at':(start+timedelta(days=30)).isoformat()+'Z'})
    state['transactions'][txn_id] = transaction
    state['sub'].update(status='active', updated_at=(start+timedelta(seconds=1)).isoformat()+'Z',
        current_billing_period=transaction['billing_period'], next_billed_at=transaction['billing_period']['ends_at'])
    return txn_id


def test_checkout_requires_auth_and_reuses_pending_transaction(billing):
    client = billing['client']
    assert client.post('/v1/billing/checkouts').status_code == 401
    first = client.post('/v1/billing/checkouts', headers=billing['auth'])
    second = client.post('/v1/billing/checkouts', headers=billing['auth'])
    assert first.status_code == second.status_code == 200
    assert billing['posts'] == 1
    assert rights(billing)['plan'] == 'free'
    assert client.post('/v1/billing/checkout-session', json={'token':'invalid' * 8}).status_code == 404


def test_trial_webhook_grants_once_and_reads_do_not_reset_usage(billing):
    complete_trial(billing)
    assert deliver(billing).status_code == 200
    data = rights(billing)
    assert data['plan'] == 'plus' and data['modes']['classic']['unlimited']
    assert data['modes']['redraw']['quota']['available'] == 30
    assert data['queue_capacity'] == 500 and data['realtime_slots'] == 10
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    with session_factory()() as db:
        period = db.scalar(select(QuotaPeriod).where(QuotaPeriod.source_key.startswith('paddle:')))
        period.used, period.reserved = 4, 2
        db.commit()
    assert deliver(billing).json()['duplicate']
    deliver(billing, event_id='evt_'+'i'*26)
    assert rights(billing)['modes']['redraw']['quota']['available'] == 24
    assert billing['client'].post('/v1/billing/checkouts', headers=billing['auth']).status_code == 409


def test_paid_conversion_does_not_carry_trial_pages_and_renewal_is_idempotent(billing, monkeypatch):
    complete_trial(billing); deliver(billing)
    txn = paid_transaction(billing, start=billing['at'])
    deliver(billing, 'transaction.completed', 'evt_'+'j'*26, txn)
    assert rights(billing)['modes']['redraw']['quota']['granted'] == 300
    deliver(billing, 'transaction.completed', 'evt_'+'k'*26, txn)
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(QuotaPeriod).where(QuotaPeriod.source_key.startswith('paddle:paid:'))) == 1
    next_start = billing['at'] + timedelta(days=30)
    renewal = paid_transaction(billing, 'l', next_start)
    deliver(billing, 'transaction.completed', 'evt_'+'m'*26, renewal)
    import app.entitlements as entitlements
    monkeypatch.setattr(entitlements, 'now', lambda: next_start + timedelta(minutes=1))
    assert rights(billing)['modes']['redraw']['quota']['granted'] == 300


def test_cancel_preserves_current_trial_and_operator_gift(billing):
    complete_trial(billing); deliver(billing)
    response = billing['client'].post('/v1/billing/cancel', headers=billing['auth'])
    assert response.status_code == 200, response.text
    assert response.json()['subscription']['cancel_at']
    assert rights(billing)['modes']['redraw']['quota']['available'] == 30
    admin = login(billing['client'], 'admin')
    gift = billing['client'].post('/v1/admin/users/'+billing['owner_id']+'/membership',headers={**admin,'Idempotency-Key':'gift-billing'},
        json={'days':30,'monthly_pages':20,'note':'independent gift'})
    assert gift.status_code == 200, gift.text
    assert rights(billing)['modes']['redraw']['quota']['available'] == 50


def test_failed_renewal_and_stale_events_never_grant_next_period(billing, monkeypatch):
    complete_trial(billing); deliver(billing)
    txn = paid_transaction(billing, start=billing['at'])
    deliver(billing, 'transaction.completed', 'evt_'+'n'*26, txn)
    billing['sub'].update(status='past_due', updated_at=(billing['at']+timedelta(days=31)).isoformat()+'Z')
    deliver(billing, 'subscription.past_due', 'evt_'+'p'*26)
    import app.entitlements as entitlements
    monkeypatch.setattr(entitlements,'now',lambda:billing['at']+timedelta(days=31))
    assert rights(billing)['plan'] == 'free'


def test_uncertain_create_is_recovered_without_another_post(billing):
    billing['uncertain'] = True
    response = billing['client'].post('/v1/billing/checkouts',headers=billing['auth'])
    assert response.status_code == 503
    response = billing['client'].post('/v1/billing/checkouts',headers=billing['auth'])
    assert response.status_code == 200, response.text
    assert billing['posts'] == 1


def test_forged_binding_and_wrong_price_do_not_grant(billing):
    complete_trial(billing)
    billing['sub']['custom_data']={'app':'node_comics','checkout_intent_id':'not-a-local-checkout'}
    deliver(billing)
    assert rights(billing)['plan'] == 'free'
    billing['sub']['custom_data']=billing['transactions'][TXN]['custom_data']
    billing['sub']['items'][0]['price']['unit_price']['amount']='1'
    deliver(billing,event_id='evt_'+'q'*26)
    assert rights(billing)['plan'] == 'free'


def test_simulator_and_unsigned_events_never_grant(billing):
    complete_trial(billing)
    assert deliver(billing,event_id='ntfsimevt_'+'r'*26).json()['simulation']
    assert billing['client'].post('/webhooks/paddle',json={}).status_code == 401
    assert rights(billing)['plan'] == 'free'


def test_expired_trial_account_uses_standard_price(billing, monkeypatch):
    complete_trial(billing); deliver(billing)
    from app.db import session_factory
    from app.models import User
    from app.billing_models import BillingSubscription
    with session_factory()() as db:
        sub=db.get(BillingSubscription,SUB); sub.status='canceled'
        user=db.get(User,billing['owner_id']);user.billing_plus_expires_at=billing['at']-timedelta(seconds=1)
        db.commit()
    # The second request's POST is intercepted to inspect the selected plan.
    from app import paddle_client
    old_request=paddle_client.request
    def replacement(method,path,body=None):
        if method=='POST' and path=='/transactions':
            assert body['items'][0]['price_id']==PAID
            value=old_request(method,path,body);value['id']='txn_'+'s'*26;return value
        return old_request(method,path,body)
    monkeypatch.setattr(paddle_client,'request',replacement)
    response=billing['client'].post('/v1/billing/checkouts',headers=billing['auth'])
    assert response.status_code==200,response.text
    assert response.json()['trial'] is False


def test_catchup_without_any_webhook_and_retry_after_provider_outage(billing, monkeypatch):
    complete_trial(billing)
    from app.billing_sync import reconcile_once
    from app import paddle_client
    original = paddle_client.request
    def unavailable(*args, **kwargs):
        raise paddle_client.PaddleError()
    monkeypatch.setattr(paddle_client, 'request', unavailable)
    deliver(billing)
    assert rights(billing)['plan'] == 'free'
    from app.db import session_factory
    from app.billing_models import BillingEvent, BillingCheckout
    with session_factory()() as db:
        event = db.get(BillingEvent, 'evt_'+'g'*26)
        assert event.status == 'pending' and event.attempts == 1
        event.next_attempt_at = billing['at'] - timedelta(seconds=1)
        db.commit()
    monkeypatch.setattr(paddle_client, 'request', original)
    reconcile_once()
    assert rights(billing)['modes']['redraw']['quota']['available'] == 30
    # A paid conversion with no incoming webhook is discovered by periodic sync.
    paid_transaction(billing, start=billing['at'])
    from app.billing_models import BillingSubscription
    with session_factory()() as db:
        db.get(BillingSubscription, SUB).synced_at = billing['at'] - timedelta(minutes=6)
        db.commit()
    reconcile_once()
    assert rights(billing)['modes']['redraw']['quota']['available'] == 300


def test_old_trial_job_cancellation_releases_original_bucket_only(billing, png):
    complete_trial(billing); deliver(billing)
    from conftest import upload
    from test_membership import submit
    asset = upload(billing['client'], billing['auth'], png)
    response = submit(billing['client'], billing['auth'], asset, 'redraw')
    assert response.status_code == 202, response.text
    job_id = response.json()['id']
    assert rights(billing)['modes']['redraw']['quota']['reserved'] == 1
    txn = paid_transaction(billing, start=billing['at'])
    deliver(billing, 'transaction.completed', 'evt_'+'t'*26, txn)
    from app.db import session_factory
    from app.jobs import cancel_job
    from app.models import Job
    from app.entitlement_models import QuotaPeriod
    with session_factory()() as db:
        job = db.get(Job, job_id)
        old_period = job.quota_period_id
        cancel_job(db, job)
        cancel_job(db, job)
        db.commit()
        assert db.get(QuotaPeriod, old_period).reserved == 0
    assert rights(billing)['modes']['redraw']['quota']['available'] == 300


def test_other_account_cannot_manage_subscription_and_billing_compensation_is_idempotent(billing):
    complete_trial(billing); deliver(billing)
    other = login(billing['client'], 'other-buyer')
    assert billing['client'].post('/v1/billing/cancel', headers=other).status_code == 404
    assert billing['client'].post('/v1/billing/portal', headers=other).status_code == 404
    admin = login(billing['client'], 'admin')
    path = '/v1/admin/users/' + billing['owner_id'] + '/quota-compensations'
    args = {'headers':{**admin, 'Idempotency-Key':'billing-compensation'},
            'json':{'kind':'redraw_monthly','pages':5,'note':'test billing compensation'}}
    assert billing['client'].post(path, **args).status_code == 200
    assert billing['client'].post(path, **args).status_code == 200
    deliver(billing, event_id='evt_'+'u'*26)
    assert rights(billing)['modes']['redraw']['quota']['available'] == 35


def test_stale_provider_snapshot_cannot_undo_cancel(billing):
    complete_trial(billing); deliver(billing)
    old = copy.deepcopy(billing['sub'])
    billing['sub'].update(status='canceled', updated_at=(billing['at']+timedelta(minutes=1)).isoformat()+'Z')
    deliver(billing, 'subscription.canceled', 'evt_'+'v'*26)
    from app.billing_sync import reconcile_snapshot
    reconcile_snapshot(old)
    value = billing['client'].get('/v1/billing/status', headers=billing['auth']).json()
    assert value['subscription']['status'] == 'canceled'
    assert rights(billing)['modes']['redraw']['quota']['available'] == 30


def test_unconfirmed_paid_subscription_does_not_report_entitlements_delivered(billing):
    complete_trial(billing)
    billing['sub']['status'] = 'active'
    deliver(billing, 'subscription.activated')
    assert rights(billing)['plan'] == 'free'
    assert billing['client'].get('/v1/billing/status', headers=billing['auth']).json()['checkout_pending']


def test_signature_rejects_expired_changed_payload_and_accepts_rotated_signatures():
    from app.paddle_client import valid_signature
    body = b'{"event":"test"}'
    signature = hmac.new(SECRET.encode(), b'1000:'+body, hashlib.sha256).hexdigest()
    header = 'ts=1000;h1='+'0'*64+';h1='+signature
    assert valid_signature(body, header, SECRET, at=1000)
    assert not valid_signature(body+b' ', header, SECRET, at=1000)
    assert not valid_signature(body, header, SECRET, at=1301)
    assert not valid_signature(body, header+';ts=1000', SECRET, at=1000)


def test_startup_rejects_mixing_billing_environments_in_one_database(billing):
    complete_trial(billing)
    from app.config import settings
    from app.db import initialize
    settings().paddle_environment = 'production'
    with pytest.raises(RuntimeError, match='isolated database'):
        initialize()


def test_missing_grand_total_cannot_fall_back_to_total(billing):
    from app import paddle_client
    from app.billing_sync import sync_transaction
    from app.billing_models import BillingTransaction
    from app.db import session_factory
    complete_trial(billing); deliver(billing)
    txn_id = paid_transaction(billing, start=billing['at'])
    billing['transactions'][txn_id]['details']['totals'] = {'total':'999'}
    with pytest.raises(paddle_client.PaddleError, match='PADDLE_TOTAL_INVALID'):
        sync_transaction(txn_id)
    with session_factory()() as db:
        assert db.get(BillingTransaction, txn_id) is None
    assert rights(billing)['modes']['redraw']['quota']['available'] == 30


def test_missing_trial_dates_cannot_fall_back_to_billing_period(billing):
    from app import paddle_client
    from app.billing_sync import sync_subscription
    complete_trial(billing)
    billing['sub']['items'][0].pop('trial_dates')
    with pytest.raises(paddle_client.PaddleError, match='PADDLE_TRIAL_PERIOD_INVALID'):
        sync_subscription(SUB)
    assert rights(billing)['plan'] == 'free'


@pytest.mark.parametrize('body, expected', [(b'not-json', 400), (b'[]', 400), (b'{}', 400),
                                           (b'x'*(1024*1024+1), 413)], ids=['invalid-json', 'array', 'missing-fields', 'oversized'])
def test_business_webhook_rejects_invalid_signed_body_and_size(billing, body, expected):
    stamp = str(int(time.time()))
    signature = hmac.new(SECRET.encode(), stamp.encode()+b':'+body, hashlib.sha256).hexdigest()
    response = billing['client'].post('/webhooks/paddle', content=body,
        headers={'Paddle-Signature':f'ts={stamp};h1={signature}'})
    assert response.status_code == expected
