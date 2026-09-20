"""Stripe's real SDK over an isolated HTTP transport; never calls a payment account."""
import copy
import hashlib
import hmac
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta, timezone
from urllib.parse import parse_qs, urlsplit
import pytest
import stripe as sdk
from sqlalchemy import func, select
from conftest import login


def test_real_sdk_client_can_make_sync_requests(monkeypatch, client):
    from app import stripe_client
    from app.config import settings
    monkeypatch.setenv('STRIPE_ENABLED', 'true')
    monkeypatch.setenv('STRIPE_SECRET_KEY', 'sk_test_fixture')
    monkeypatch.setenv('STRIPE_WEBHOOK_SECRET', 'whsec_fixture')
    monkeypatch.setenv('STRIPE_RETURN_URL', 'https://comics.example/account/')
    settings.cache_clear()
    calls = []

    def request(self, method, url, **kwargs):
        from requests import Response
        calls.append((method, url, kwargs['timeout']))
        response = Response()
        response.status_code = 200
        response._content = b'{"id":"price_plus","object":"price"}'
        return response

    monkeypatch.setattr('requests.Session.request', request)
    try:
        assert stripe_client.call('prices', 'retrieve', 'price_plus')['id'] == 'price_plus'
        assert calls == [('get', 'https://api.stripe.com/v1/prices/price_plus', 20)]
    finally:
        settings.cache_clear()


@pytest.fixture
def billing(monkeypatch, request):
    for key, value in {'STRIPE_ENABLED':'true', 'STRIPE_ENVIRONMENT':'test',
        'STRIPE_SECRET_KEY':'sk_test_fixture', 'STRIPE_WEBHOOK_SECRET':'whsec_fixture',
        'STRIPE_RETURN_URL':'https://comics.example/account/'}.items():
        monkeypatch.setenv(key, value)
    client = request.getfixturevalue('client')
    from app import stripe_client
    from app.models import now
    state = {'client':client, 'sessions':{}, 'invoices':{}, 'charges': {}, 'invoice_payments': [], 'sub':None, 'posts':[], 'requests':[],
        'at':int(now().replace(tzinfo=timezone.utc).timestamp())-60, 'lost':False, 'fail_page':False}
    price = {'id':'price_plus', 'object':'price', 'active':True, 'livemode':False, 'product':'prod_plus',
        'currency':'usd', 'unit_amount':999, 'recurring':{'interval':'month','interval_count':1,'usage_type':'licensed'}}
    state['price'] = price
    state['prices'] = {price['id']: price}
    state['price_id'] = 'fixture-price'
    from app.db import session_factory
    from app.billing_models import BillingPrice, BillingPriceBinding
    with session_factory()() as db:
        db.add(BillingPrice(id=state['price_id'], plan_id='plus', plan_revision_id='plus-v1',
            environment='test', currency='usd', unit_amount=999, interval='month',
            status='active'))
        db.flush()
        db.add(BillingPriceBinding(id='fixture-stripe-binding', price_id=state['price_id'], provider='stripe',
            environment='test', product_id='prod_plus', provider_price_id='price_plus', status='active'))
        db.commit()

    class Transport(sdk.HTTPClient):
        name = 'isolated-stripe-fixture'
        def request(self, method, url, headers, post_data=None, **kwargs):
            path = urlsplit(url).path
            params = {k:v[0] for k,v in parse_qs(post_data if method == 'post' else urlsplit(url).query).items()}
            state['requests'].append((method, path, params, headers))
            assert urlsplit(url).hostname == 'api.stripe.com'
            if path.startswith('/v1/prices/'):
                data = state['prices'][path.split('/')[-1]]
            elif path == '/v1/checkout/sessions' and method == 'post':
                key = headers['Idempotency-Key']
                state['posts'].append((key, params))
                # Stripe replays the original response for the same idempotency key.
                data = state['sessions'].setdefault(key, {'object':'checkout.session', 'id':'cs_test_fixture'+str(len(state['sessions'])),
                    'livemode':False, 'mode':'subscription', 'status':'open', 'subscription':None,
                    'customer':params.get('customer'), 'client_reference_id':params['client_reference_id'],
                    'metadata':{'app':'node_comics','checkout_intent_id':params['metadata[checkout_intent_id]']},
                    'url':'https://checkout.stripe.com/c/pay/cs_test_fixture', 'expires_at':int(params['expires_at'])})
                if state['lost']:
                    state['lost'] = False
                    raise sdk.APIConnectionError('isolated lost response')
            elif path.startswith('/v1/checkout/sessions/'):
                data = next(s for s in state['sessions'].values() if s['id'] == path.split('/')[-1])
            elif path == '/v1/checkout/sessions':
                data = {'object':'list','data':list(state['sessions'].values()),'has_more':False}
            elif path == '/v1/subscriptions/sub_fixture':
                data = state['sub']
            elif path == '/v1/invoices':
                rows = sorted((i for i in state['invoices'].values()
                    if not params.get('status') or i['status'] == params['status']), key=lambda x:x['id'])
                if params.get('starting_after'):
                    if state['fail_page']:
                        raise sdk.APIConnectionError('isolated page failure')
                    rows = [i for i in rows if i['id'] > params['starting_after']]
                data = {'object':'list','data':rows[:2],'has_more':len(rows)>2}
            elif path.startswith('/v1/invoices/'):
                data = state['invoices'][path.split('/')[-1]]
            elif path.startswith('/v1/charges/'):
                data = state['charges'][path.split('/')[-1]]
            elif path == '/v1/invoice_payments':
                assert params['payment[type]'] == 'payment_intent'
                rows = [p for p in state['invoice_payments']
                    if p['payment']['payment_intent'] == params['payment[payment_intent]']]
                data = {'object': 'list', 'data': rows, 'has_more': False}
            elif path == '/v1/billing_portal/sessions':
                state['portal_customer'] = params['customer']
                state['portal_configuration'] = params.get('configuration')
                data = {'object':'billing_portal.session','id':'bps_fixture','url':'https://billing.stripe.com/p/session/fixture'}
            else:
                raise AssertionError((method, path, params))
            return json.dumps(copy.deepcopy(data)), 200, {'request-id':'req_fixture'}
    transport = Transport()
    monkeypatch.setattr(stripe_client, 'client', lambda: sdk.StripeClient('sk_test_fixture',
        http_client=transport, max_network_retries=0))
    state['auth'] = login(client, 'buyer')
    state['owner'] = client.get('/v1/me', headers=state['auth']).json()['user']['id']
    return state


def checkout(state):
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'], json={'provider':'stripe', 'price_id':state['price_id']})
    assert response.status_code == 200, response.text
    return response.json()


def complete_trial(state, synchronize=True):
    checkout(state)
    session = next(iter(state['sessions'].values()))
    session.update(status='complete', subscription='sub_fixture', customer='cus_fixture')
    state['sub'] = {'id':'sub_fixture', 'object':'subscription', 'livemode':False, 'customer':'cus_fixture',
        'metadata':session['metadata'], 'status':'trialing', 'trial_start':state['at'],
        'trial_end':state['at']+7*86400, 'cancel_at_period_end':False,
        'items':{'data':[{'id':'si_fixture','quantity':1,'price':state['price'],
            'current_period_end':state['at']+7*86400}], 'has_more':False}}
    from app.billing_sync import sync_session
    if synchronize:
        sync_session(session['id'])


def invoice(state, index=1, start=None, status='paid', total=999, reason='subscription_cycle', end=None):
    start = start or state['at']
    value = {'id':f'in_{index:04d}', 'object':'invoice', 'livemode':False, 'customer':'cus_fixture',
        'status':status, 'amount_remaining':0 if status=='paid' else total, 'total':total, 'currency':state['price']['currency'],
        'billing_reason':reason, 'parent':{'subscription_details':{'subscription':'sub_fixture'}},
        'lines':{'has_more':False,'data':[{'id':f'il_{index}', 'quantity':1,
            'pricing':{'price_details':{'price':state['price']['id'],'product':state['price']['product']}},
            'parent':{'subscription_item_details':{'subscription':'sub_fixture','proration':False}},
            'period':{'start':start,'end':end or start+30*86400}}]}}
    state['invoices'][value['id']] = value
    return value


def rights(state):
    return state['client'].get('/v1/me/entitlements', headers=state['auth']).json()


def periods():
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    with session_factory()() as db:
        return list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.source == 'subscription')))


def test_hosted_checkout_is_account_bound_and_reuses_session(billing):
    assert checkout(billing)['checkout_url'].startswith('https://checkout.stripe.com/')
    checkout(billing)
    assert len(billing['posts']) == 1
    params = billing['posts'][0][1]
    assert params['subscription_data[trial_period_days]'] == '7'
    assert params['payment_method_collection'] == 'always'
    assert params['currency'] == 'usd' and params['adaptive_pricing[enabled]'] == 'false'
    assert params['success_url'] == 'https://comics.example/payment/success/'
    assert params['cancel_url'] == 'https://comics.example/account/'
    assert params['subscription_data[metadata][checkout_intent_id]'] == params['client_reference_id']
    assert not periods()


def test_lost_create_response_retries_same_key_and_parameters(billing):
    billing['lost'] = True
    response = billing['client'].post('/v1/billing/checkouts', headers=billing['auth'], json={'provider':'stripe', 'price_id':billing['price_id']})
    assert response.status_code == 503
    checkout(billing)
    assert len(billing['sessions']) == 1 and billing['posts'][0] == billing['posts'][1]
    from app.db import session_factory
    from app.billing_models import BillingOrder
    with session_factory()() as db:
        order = db.scalar(select(BillingOrder))
        assert order.status == 'pending' and order.error_code is None


def test_unknown_create_past_retention_only_looks_up_original(billing):
    from app.db import session_factory
    from app.billing_models import BillingCheckout
    from app.billing_checkout import recover_checkout
    billing['lost'] = True
    billing['client'].post('/v1/billing/checkouts', headers=billing['auth'], json={'provider':'stripe', 'price_id':billing['price_id']})
    with session_factory()() as db:
        row = db.scalar(select(BillingCheckout))
        row.created_at -= timedelta(days=3)
        row.expires_at -= timedelta(days=3)
        row_id = row.id
        db.commit()
    recover_checkout(row_id)
    assert len(billing['posts']) == 1


def test_trial_conversion_and_replay_never_double_grant(billing):
    from app.billing_sync import sync_subscription
    complete_trial(billing)
    assert [p.granted for p in periods()] == [30]
    invoice(billing)
    billing['sub']['status'] = 'active'
    sync_subscription('sub_fixture')
    sync_subscription('sub_fixture')
    assert sorted(p.granted for p in periods()) == [30,300]
    assert rights(billing)['modes']['redraw']['quota']['available'] == 300
    assert billing['client'].post('/v1/billing/checkouts', headers=billing['auth'], json={'provider':'stripe', 'price_id':billing['price_id']}).status_code == 409


@pytest.mark.parametrize('total',[0,999])
def test_paid_monthly_invoice_including_credit_settlement_grants(billing,total):
    from app.billing_sync import sync_subscription
    complete_trial(billing)
    invoice(billing,total=total)
    sync_subscription('sub_fixture')
    assert sum(p.granted for p in periods()) == 330


@pytest.mark.parametrize('kind',['open','proration','wrong_price','bad_quantity','wrong_customer'])
def test_unpaid_or_unapproved_invoice_cannot_grant(billing,kind):
    from app.billing_sync import sync_subscription
    from app.stripe_client import BillingError
    complete_trial(billing)
    value=invoice(billing)
    if kind=='open': value['status']='open'
    elif kind=='proration': value['billing_reason']='subscription_update'
    elif kind=='wrong_price': value['lines']['data'][0]['pricing']['price_details']['price']='price_other'
    elif kind=='bad_quantity': value['lines']['data'][0]['quantity']=2
    else: value['customer']='cus_other'
    if kind in ('wrong_price','bad_quantity','wrong_customer'):
        with pytest.raises(BillingError): sync_subscription('sub_fixture')
    else:
        sync_subscription('sub_fixture')
    assert [p.granted for p in periods()] == [30]


def test_cancel_and_payment_failure_retain_only_granted_term(billing):
    from app.billing_sync import sync_subscription
    complete_trial(billing)
    billing['sub'].update(cancel_at_period_end=True)
    sync_subscription('sub_fixture')
    assert rights(billing)['plan']=='plus'
    assert billing['client'].get('/v1/billing/status',headers=billing['auth']).json()['subscription']['cancel_at']
    invoice(billing,status='open')
    billing['sub']['status']='past_due'
    sync_subscription('sub_fixture')
    assert [p.granted for p in periods()]==[30]


def test_portal_is_scoped_to_authenticated_customer(billing, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings(), 'stripe_portal_configuration_id', 'bpc_fixture')
    complete_trial(billing)
    other=login(billing['client'],'other')
    assert billing['client'].post('/v1/billing/portal',headers=other,json={'provider':'stripe'}).status_code==404
    result=billing['client'].post('/v1/billing/portal',headers=billing['auth'],json={'provider':'stripe'})
    assert result.status_code==200 and result.json()['url'].startswith('https://billing.stripe.com/')
    assert billing['portal_customer']=='cus_fixture'
    assert billing['portal_configuration']=='bpc_fixture'


def test_trial_cannot_be_repeated(billing):
    from app.db import session_factory
    from app.billing_models import BillingAccount
    from app.models import now
    with session_factory()() as db:
        db.add(BillingAccount(owner_id=billing['owner'],trial_used_at=now()))
        db.commit()
    assert checkout(billing)['trial'] is False
    assert 'subscription_data[trial_period_days]' not in billing['posts'][0][1]


def test_full_pagination_catches_old_invoice_paid_late(billing):
    from app.billing_sync import sync_subscription
    complete_trial(billing)
    for i in range(1,7): invoice(billing,index=i,start=billing['at']-i*30*86400)
    late=invoice(billing,index=7,status='open')
    sync_subscription('sub_fixture')
    assert len(periods())==7
    late.update(status='paid',amount_remaining=0)
    sync_subscription('sub_fixture')
    assert len(periods())==8
    assert len([r for r in billing['requests'] if r[1]=='/v1/invoices' and 'starting_after' in r[2]])>=5


def test_partial_page_failure_rolls_back_and_recovers(billing):
    from app.billing_sync import sync_subscription
    from app.stripe_client import BillingError
    complete_trial(billing)
    for i in range(1,5): invoice(billing,index=i,start=billing['at']-i*30*86400)
    billing['fail_page']=True
    with pytest.raises(BillingError): sync_subscription('sub_fixture')
    assert len(periods())==1
    billing['fail_page']=False
    sync_subscription('sub_fixture')
    assert len(periods())==5


def test_concurrent_reconciliation_grants_once(billing):
    from app.billing_sync import sync_subscription
    complete_trial(billing)
    invoice(billing)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _:sync_subscription('sub_fixture'),range(2)))
    assert len(periods())==2


def signed_event(value, at=None):
    body=json.dumps(value).encode()
    at=at or int(time.time())
    signature=hmac.new(b'whsec_fixture',str(at).encode()+b'.'+body,hashlib.sha256).hexdigest()
    return body, {'Stripe-Signature':f't={at},v1={signature}','Content-Type':'application/json'}


def test_signed_webhook_durable_replay_and_environment(billing):
    from app.db import session_factory
    from app.billing_models import BillingEvent
    complete_trial(billing)
    value={'id':'evt_fixture','object':'event','type':'customer.subscription.updated',
        'livemode':False,'created':int(time.time()),'data':{'object':{'id':'sub_fixture'}}}
    body,headers=signed_event(value)
    for _ in range(2):
        assert billing['client'].post('/webhooks/stripe',content=body,headers=headers).status_code==200
    assert len(periods())==1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingEvent))==1
        assert db.get(BillingEvent,'stripe:test:evt_fixture').status=='processed'
    assert billing['client'].post('/webhooks/stripe',content=body+b' ',headers=headers).status_code==401
    stale,headers=signed_event(value,int(time.time())-600)
    assert billing['client'].post('/webhooks/stripe',content=stale,headers=headers).status_code==401
    value['livemode']=True
    body,headers=signed_event(value)
    assert billing['client'].post('/webhooks/stripe',content=body,headers=headers).status_code==400


def test_legacy_routes_removed_and_auth_required(billing):
    for path in ['/billing/checkout','/v1/billing/checkout-config']:
        assert billing['client'].get(path).status_code==404
    for path in ['/webhooks/paddle','/v1/billing/checkout-session','/v1/billing/cancel']:
        assert billing['client'].post(path).status_code == 404
    assert billing['client'].post('/v1/billing/checkouts').status_code==401


@pytest.mark.parametrize('url',['https://checkout.stripe.com.evil.test/x','http://checkout.stripe.com/x',
    'https://secret@checkout.stripe.com/x','https://checkout.stripe.com:444/x','javascript:alert(1)'])
def test_reject_untrusted_payment_links(url):
    from app.stripe_client import BillingError, hosted_url
    with pytest.raises(BillingError): hosted_url(url)


def test_completed_unbound_checkout_is_reconciled_without_webhook(billing):
    from app.db import session_factory
    from app.billing_models import BillingCheckout
    from app.billing_checkout import bind_session
    from app.billing_sync import reconcile_once
    from app.models import now
    complete_trial(billing,synchronize=False)
    session=next(iter(billing['sessions'].values()))
    bind_session(session['client_reference_id'],session)
    with session_factory()() as db:
        row=db.scalar(select(BillingCheckout))
        row.last_checked_at=now()-timedelta(minutes=10)
        db.commit()
    reconcile_once()
    assert [p.granted for p in periods()]==[30]


def test_concurrent_checkout_uses_one_intent(billing):
    from app.billing_checkout import start_checkout
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:start_checkout(billing['owner'], billing['price_id'], 'stripe'),range(2)))
    assert results[0]['checkout_url']==results[1]['checkout_url']
    assert len({key for key,_ in billing['posts']})==1
    assert len(billing['sessions'])==1


def test_late_first_notification_after_trial_converts_once(billing):
    from app.billing_sync import sync_subscription
    complete_trial(billing,synchronize=False)
    invoice(billing)
    billing['sub']['status']='active'
    sync_subscription('sub_fixture')
    sync_subscription('sub_fixture')
    assert rights(billing)['modes']['redraw']['quota']['available']==300
    assert sorted(p.granted for p in periods())==[30,300]


def test_subscription_for_another_product_is_ignored(billing):
    from app.billing_sync import sync_subscription
    complete_trial(billing,synchronize=False)
    billing['sub']['metadata']={}
    sync_subscription('sub_fixture')
    assert not periods()


def test_completed_checkout_blocks_new_purchase_until_subscription_is_bound(billing):
    from app.billing_checkout import bind_session
    complete_trial(billing, synchronize=False)
    session = next(iter(billing['sessions'].values()))
    bind_session(session['client_reference_id'], session)
    response = billing['client'].post('/v1/billing/checkouts', headers=billing['auth'],
        json={'provider': 'stripe', 'price_id': billing['price_id']})
    assert response.status_code == 409, response.text
    assert len(billing['sessions']) == 1


@pytest.mark.parametrize('refund_status', ['refunded', 'disputed', 'partially_refunded'])
def test_invoice_replay_preserves_refund_state(billing, refund_status):
    from app.billing_sync import sync_subscription
    from app.billing_models import BillingOrder
    from app.billing_orders import transition, revoke_invoice
    from app.db import session_factory
    complete_trial(billing)
    invoice(billing)
    sync_subscription('sub_fixture')
    with session_factory()() as db:
        order = db.scalar(select(BillingOrder).where(BillingOrder.external_id == 'in_0001'))
        transition(db, order, refund_status, 'refund_sync')
        if refund_status in ('refunded', 'disputed'):
            revoke_invoice(db, 'stripe:test:in_0001')
        db.commit()
    sync_subscription('sub_fixture')
    with session_factory()() as db:
        order = db.scalar(select(BillingOrder).where(BillingOrder.external_id == 'in_0001'))
        assert order.status == refund_status
