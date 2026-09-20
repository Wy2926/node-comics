"""Catalog and annual billing through authenticated APIs and the real Stripe SDK transport."""
import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import pytest
from conftest import login
from test_stripe_billing import billing, checkout, complete_trial, invoice, periods, rights


def administrator(state):
    from app.db import session_factory
    from app.models import User
    with session_factory()() as db:
        db.get(User, state['owner']).role = 'admin'
        db.commit()
    return state['auth']


def quote(state, *, key='annual', plan='plus', pages=300, amount=9990, interval='year', trial_days=7, publish=True):
    client, auth = state['client'], administrator(state)
    revision = {'id':key+'-revision', 'name':plan.upper(), 'monthly_redraw_pages':pages,
        'trial_days':trial_days, 'trial_redraw_pages':30 if trial_days else 0}
    response = client.post(f'/v1/admin/billing/plans/{plan}/revisions', headers=auth, json=revision)
    assert response.status_code == 200, response.text
    remote = {**copy.deepcopy(state['price']), 'id':'price_'+key, 'product':'prod_'+plan,
        'unit_amount':amount, 'active':True,
        'recurring':{'interval':interval,'interval_count':1,'usage_type':'licensed'}}
    state['prices'][remote['id']] = remote
    payload = {'id':key, 'plan_revision_id':revision['id'], 'currency':remote['currency'],
        'unit_amount':amount, 'interval':interval, 'stripe_product_id':remote['product'], 'stripe_price_id':remote['id']}
    response=client.post('/v1/admin/billing/prices', headers=auth, json=payload)
    assert response.status_code == 200, response.text
    if publish:
        response=client.put(f'/v1/admin/billing/prices/{key}/status', headers=auth, json={'status':'active'})
        assert response.status_code == 200, response.text
    return remote, payload


def select_quote(state, **kwargs):
    remote, payload=quote(state, **kwargs)
    state['price'], state['price_id'] = remote, payload['id']


def at_rights(state, at):
    from app.db import session_factory
    from app.models import User
    from app.entitlements import entitlements_json
    with session_factory()() as db:
        return entitlements_json(db, db.get(User,state['owner']),at)


def test_catalog_is_private_for_admin_and_drafts_cannot_be_purchased(billing):
    c=billing['client']
    assert c.get('/v1/admin/billing/catalog',headers=billing['auth']).status_code==403
    _,payload=quote(billing,publish=False)
    public=c.get('/v1/billing/catalog').json()['offers']
    assert {p['id'] for p in public}=={'fixture-price'}
    assert c.post('/v1/billing/checkouts',headers=billing['auth'],json={'price_id':payload['id']}).status_code==409
    assert not billing['posts']
    assert c.post('/v1/billing/checkouts',headers=billing['auth']).status_code==422


def test_quote_immutable_replay_and_explicit_publication(billing):
    _,payload=quote(billing,publish=False)
    c,auth=billing['client'],billing['auth']
    assert c.post('/v1/admin/billing/prices',headers=auth,json=payload).status_code==200
    assert c.post('/v1/admin/billing/prices',headers=auth,json={**payload,'unit_amount':1}).status_code==409
    assert c.patch('/v1/admin/billing/prices/annual',headers=auth,json={'unit_amount':1}).status_code in (404,405)
    assert c.put('/v1/admin/billing/prices/annual/status',headers=auth,json={'status':'active'}).status_code==200
    assert {p['interval'] for p in c.get('/v1/billing/catalog').json()['offers']}=={'month','year'}


@pytest.mark.parametrize('field,value',[('unit_amount',1),('currency','eur'),('product','prod_wrong'),('livemode',True),('active',False)])
def test_publish_validates_remote_quote(billing,field,value):
    remote,_=quote(billing,publish=False)
    remote[field]=value
    c=billing['client']
    assert c.put('/v1/admin/billing/prices/annual/status',headers=billing['auth'],json={'status':'active'}).status_code==409
    assert len(c.get('/v1/billing/catalog').json()['offers'])==1


@pytest.mark.parametrize('start',[datetime(2027,1,31,12),datetime(2028,2,29,12)])
def test_annual_payment_grants_twelve_calendar_months_without_rollover(billing,start):
    from app.billing_sync import sync_subscription
    from app.entitlements import month_boundary
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    select_quote(billing,pages=800)
    complete_trial(billing)
    end=month_boundary(start,12,'UTC')
    stamp=lambda d:int(d.replace(tzinfo=timezone.utc).timestamp())
    invoice(billing,start=stamp(start),end=stamp(end),total=9990)
    sync_subscription('sub_fixture')
    sync_subscription('sub_fixture')
    paid=sorted((p for p in periods() if p.granted==800),key=lambda p:p.starts_at)
    assert len(paid)==12
    assert [p.starts_at for p in paid]==[month_boundary(start,i,'UTC') for i in range(12)]
    assert [p.ends_at for p in paid[:-1]]==[p.starts_at for p in paid[1:]]
    assert paid[-1].ends_at==end
    with session_factory()() as db:
        row=db.get(QuotaPeriod,paid[0].id)
        row.used,row.reserved=120,3
        db.commit()
    assert at_rights(billing,start)['modes']['redraw']['quota']['available']==677
    second=at_rights(billing,paid[1].starts_at)
    assert second['modes']['redraw']['quota']['available']==800
    assert second['pending_previous_period_pages']==3
    assert at_rights(billing,end)['plan']=='free'


def test_annual_cancel_retains_year_and_failed_renewal_does_not_pregrant(billing):
    from app.billing_sync import sync_subscription
    from app.billing_grants import timestamp
    select_quote(billing)
    complete_trial(billing)
    start=billing['at'];end=start+365*86400
    invoice(billing,start=start,end=end,total=9990)
    billing['sub'].update(status='active',cancel_at_period_end=True)
    billing['sub']['items']['data'][0]['current_period_end']=end
    sync_subscription('sub_fixture')
    assert rights(billing)['modes']['redraw']['quota']['available']==300
    assert at_rights(billing,timestamp(end)-timedelta(seconds=1))['plan']=='plus'
    invoice(billing,index=2,start=end,end=end+365*86400,status='open',total=9990)
    billing['sub']['status']='past_due'
    sync_subscription('sub_fixture')
    assert len([p for p in periods() if p.granted==300])==12
    assert at_rights(billing,timestamp(end))['plan']=='free'
    billing['invoices']['in_0002'].update(status='paid',amount_remaining=0)
    sync_subscription('sub_fixture')
    assert len([p for p in periods() if p.granted==300])==24
    assert at_rights(billing,timestamp(end))['plan']=='plus'


def test_new_price_and_benefits_do_not_change_existing_subscription(billing):
    from app.billing_sync import sync_subscription
    complete_trial(billing)
    invoice(billing)
    sync_subscription('sub_fixture')
    quote(billing,key='newmonthly',interval='month',amount=1499,pages=600)
    c=billing['client']
    assert [p['unit_amount'] for p in c.get('/v1/billing/catalog').json()['offers']]==[1499]
    invoice(billing,index=2,start=billing['at']+30*86400)
    sync_subscription('sub_fixture')
    assert sorted(p.granted for p in periods())==[30,300,300]
    status=c.get('/v1/billing/status',headers=billing['auth']).json()
    assert status['subscription']['price']['unit_amount']==999
    assert status['subscription']['price']['monthly_redraw_pages']==300
    other=login(c,'new-customer')
    assert c.post('/v1/billing/checkouts',headers=other,json={'price_id':'fixture-price'}).status_code==409
    assert c.post('/v1/billing/checkouts',headers=other,json={'price_id':'newmonthly'}).status_code==200
    assert billing['posts'][-1][1]['line_items[0][price]']=='price_newmonthly'


def test_pending_checkout_keeps_quote_and_rejects_switch(billing):
    checkout(billing)
    quote(billing,key='newmonthly',interval='month',amount=1499)
    c=billing['client']
    assert c.post('/v1/billing/checkouts',headers=billing['auth'],json={'price_id':'newmonthly'}).status_code==409
    checkout(billing)
    assert len(billing['posts'])==1
    assert c.get('/v1/billing/status',headers=billing['auth']).json()['checkout_price']['unit_amount']==999


def test_multiple_plans_custom_trial_and_zero_quota_keep_classic_access(billing):
    from app.billing_sync import sync_subscription
    select_quote(billing,key='light',plan='light',pages=0,interval='month',amount=499,trial_days=3)
    checkout(billing)
    assert billing['posts'][0][1]['subscription_data[trial_period_days]']=='3'
    complete_trial(billing,synchronize=False)
    billing['sub']['trial_end']=billing['at']+3*86400
    sync_subscription('sub_fixture')
    invoice(billing,total=499)
    sync_subscription('sub_fixture')
    value=rights(billing)
    assert value['plan']=='plus' and value['modes']['classic']['unlimited']
    assert value['modes']['redraw']['quota']['available']==0
    assert {p['plan_id'] for p in billing['client'].get('/v1/billing/catalog').json()['offers']}=={'plus','light'}


def test_annual_concurrent_reconciliation_grants_once(billing):
    from app.billing_sync import sync_subscription
    select_quote(billing)
    complete_trial(billing)
    invoice(billing,end=billing['at']+365*86400,total=9990)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _:sync_subscription('sub_fixture'),range(2)))
    assert len(periods())==13


def test_monthly_invoice_cannot_grant_an_annual_term(billing):
    from app.billing_sync import sync_subscription
    from app.stripe_client import BillingError
    select_quote(billing)
    complete_trial(billing)
    invoice(billing)
    with pytest.raises(BillingError,match='STRIPE_INVOICE_PERIOD_INVALID'):
        sync_subscription('sub_fixture')
    assert len(periods())==1


def test_long_zero_value_trial_invoice_does_not_grant_paid_month(billing):
    from app.billing_sync import sync_subscription
    select_quote(billing,key='longtrial',interval='month',trial_days=30)
    complete_trial(billing,synchronize=False)
    billing['sub']['trial_end']=billing['at']+30*86400
    invoice(billing,end=billing['sub']['trial_end'],total=0,reason='subscription_create')
    sync_subscription('sub_fixture')
    assert [p.granted for p in periods()]==[30]
    assert billing['client'].get('/v1/billing/status',headers=billing['auth']).json()['subscription']['paid_ends_at'] is None


def test_historical_paid_invoice_does_not_expire_current_trial(billing):
    from app.billing_sync import sync_subscription
    complete_trial(billing)
    invoice(billing,start=billing['at']-90*86400)
    sync_subscription('sub_fixture')
    assert rights(billing)['plan']=='plus'
    assert rights(billing)['modes']['redraw']['quota']['available']==30
