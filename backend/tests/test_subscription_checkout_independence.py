"""Independent subscription quotes over isolated provider transports; no real payments."""
import copy
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select
from conftest import login
from test_stripe_billing import billing, invoice
from test_creem_billing import creem_billing, iso
from test_billing_catalog import administrator, quote


@pytest.fixture(params=['stripe', 'creem'])
def buyer(request, monkeypatch):
    state = request.getfixturevalue('billing' if request.param == 'stripe' else 'creem_billing')
    state['provider'] = request.param
    from app.billing_models import BillingPlanRevision
    from app.db import session_factory
    with session_factory()() as db:
        revision = db.get(BillingPlanRevision, 'plus-v1')
        revision.trial_days = revision.trial_classic_pages = 0
        db.commit()
    administrator(state)
    if request.param == 'stripe':
        quote(state, key='independent-year', interval='year', amount=9999, trial_days=0)
        state['other_price'] = 'independent-year'
        state['subscriptions'] = {}
        from app import stripe_client
        original_call, original_pages = stripe_client.call, stripe_client.pages

        def call(resource, action, *args, **kwargs):
            if resource == 'subscriptions' and action == 'retrieve' and args[0] in state['subscriptions']:
                return copy.deepcopy(state['subscriptions'][args[0]])
            return original_call(resource, action, *args, **kwargs)

        def pages(resource, **params):
            if resource == 'invoices':
                yield copy.deepcopy([value for value in state['invoices'].values()
                    if value['parent']['subscription_details']['subscription'] == params['subscription']])
            else:
                yield from original_pages(resource, **params)

        monkeypatch.setattr(stripe_client, 'call', call)
        monkeypatch.setattr(stripe_client, 'pages', pages)
    else:
        state['other_price'] = 'creem-year'
    return state


def checkout(state, price_id):
    return state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'provider': state['provider'], 'price_id': price_id})


def settle(state, session, index, customer):
    from app.entitlements import month_boundary
    from app.billing_models import BillingCheckout, BillingPrice, BillingPriceBinding
    from app.db import session_factory
    with session_factory()() as db:
        row = db.get(BillingCheckout, session['metadata']['checkout_intent_id'])
        price = db.get(BillingPrice, row.price_id)
        binding = db.get(BillingPriceBinding, row.binding_id)
    start = state['at'] if isinstance(state['at'], datetime) else datetime.fromtimestamp(state['at'], timezone.utc).replace(tzinfo=None)
    end = month_boundary(start, 12 if price.interval == 'year' else 1, 'UTC')
    sub_id = 'sub_independent' + str(index)
    session.update(status='complete' if state['provider'] == 'stripe' else 'completed',
        customer=customer, subscription=sub_id)
    sub = {'id': sub_id, 'customer': customer, 'status': 'active', 'metadata': session['metadata']}
    if state['provider'] == 'stripe':
        remote = state['prices'][binding.provider_price_id]
        end_stamp = int(end.replace(tzinfo=timezone.utc).timestamp())
        sub.update(livemode=False, cancel_at_period_end=False, items={'has_more': False, 'data': [{
            'id': 'si_' + str(index), 'quantity': 1, 'price': remote, 'current_period_end': end_stamp}]})
        value = invoice({**state, 'price': remote}, index=index, total=price.unit_amount, end=end_stamp)
        value['customer'] = customer
        value['parent']['subscription_details']['subscription'] = sub_id
        value['lines']['data'][0]['parent']['subscription_item_details']['subscription'] = sub_id
    else:
        sub.update(mode='test', product=binding.product_id, current_period_start_date=iso(start),
            current_period_end_date=iso(end), next_transaction_date=iso(end),
            items=[{'product_id': binding.product_id, 'units': 1}])
        value = {'id': 'tran_independent' + str(index), 'mode': 'test', 'type': 'invoice', 'status': 'paid',
            'customer': customer, 'subscription': sub_id, 'currency': 'USD', 'amount': price.unit_amount,
            'amount_paid': price.unit_amount, 'period_start': int(start.replace(tzinfo=timezone.utc).timestamp() * 1000),
            'period_end': int(end.replace(tzinfo=timezone.utc).timestamp() * 1000)}
        state['transactions'][value['id']] = value
    state['subscriptions'][sub_id] = sub
    from app.billing_sync import sync_session
    sync_session(session['id'], provider=state['provider'])
    sync_session(session['id'], provider=state['provider'])


@pytest.mark.parametrize('reverse', [False, True])
@pytest.mark.parametrize('same_customer', [False, True])
def test_both_paid_orders_survive_and_duplicate_subscriptions_are_visible(buyer, reverse, same_customer):
    state = buyer
    prices = [state['price_id'], state['other_price']]
    for price in prices:
        result = checkout(state, price)
        assert result.status_code == 200, result.text
        assert checkout(state, price).json() == result.json()
    assert len(state['posts']) == 2
    assert len(state['sessions']) == 2
    sessions = list(state['sessions'].values())
    for index in ([1, 0] if reverse else [0, 1]):
        settle(state, sessions[index], index + 1, 'cust_same' if same_customer else 'cust_' + str(index))
    from app.billing_models import BillingOrder, BillingInvoice, BillingSubscription
    from app.entitlement_models import QuotaPeriod
    from app.db import session_factory
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 2
        orders = list(db.scalars(select(BillingOrder)))
        assert len(orders) == 2 and all(order.status == 'paid' for order in orders)
        assert sorted(order.total for order in orders) == [999, 9999]
        assert db.scalar(select(func.count()).select_from(QuotaPeriod).where(QuotaPeriod.source == 'subscription')) == 13
        assert db.scalar(select(func.count()).select_from(BillingSubscription)) == 2
    client, auth = state['client'], state['auth']
    path = '/v1/admin/billing/subscriptions'
    response = client.get(path, headers=auth, params={'duplicates_only': True, 'page_size': 1})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['total'] == 2 and len(data['items']) == 1
    assert data['items'][0]['duplicate_subscription'] is True
    detail = client.get(path + '/' + data['items'][0]['id'], headers=auth).json()
    assert detail['subscription']['duplicate_subscription'] is True
    gift = client.post(f"/v1/admin/users/{state['owner']}/membership",
        headers={**auth, 'Idempotency-Key': 'duplicate-gift-guard'},
        json={'days': 30, 'monthly_pages': 300, 'note': 'isolated duplicate subscription guard'})
    assert gift.status_code == 409 and gift.json()['error']['code'] == 'BILLING_DUPLICATE_SUBSCRIPTIONS'
    assert checkout(state, state['price_id']).json()['error']['code'] == 'BILLING_SUBSCRIPTION_EXISTS'
    portal = client.post('/v1/billing/portal', headers=auth, json={'provider': state['provider']})
    assert portal.status_code == 200, portal.text
    assert state['portal_customer'] == sessions[1]['customer']
    # Ending the newer subscription must not hide the older active one.
    with session_factory()() as db:
        from app.billing_models import BillingTerm
        sub = db.scalar(select(BillingSubscription).where(BillingSubscription.checkout_id == sessions[1]['metadata']['checkout_intent_id']))
        sub.status = 'canceled'
        for term in db.scalars(select(BillingTerm).where(BillingTerm.subscription_id == sub.id)):
            term.revoked_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
    assert client.get(path, headers=auth, params={'duplicates_only': True}).json()['total'] == 0
    assert client.get('/v1/billing/status', headers=auth).json()['subscription']['price']['id'] == prices[0]


def test_pending_lookup_is_price_and_account_scoped_and_reconciliation_rotates(buyer):
    state = buyer
    ids = [checkout(state, price).json()['checkout_id'] for price in (state['price_id'], state['other_price'])]
    other = login(state['client'], 'other-subscription-buyer')
    for price, checkout_id in zip((state['price_id'], state['other_price']), ids):
        path = '/v1/billing/status?price_id=' + price
        assert state['client'].get(path, headers=state['auth']).json()['subscription_checkout']['id'] == checkout_id
        assert state['client'].get(path, headers=other).json()['subscription_checkout'] is None
    from app.billing_models import BillingCheckout
    from app.billing_checkout import sync_owner
    from app.db import session_factory
    from app.models import now
    with session_factory()() as db:
        for index, checkout_id in enumerate(ids):
            db.get(BillingCheckout, checkout_id).last_checked_at = now() - timedelta(minutes=20-index)
        db.commit()
    for count in (1, 2):
        sync_owner(state['owner'])
        with session_factory()() as db:
            checked = db.scalar(select(func.count()).select_from(BillingCheckout).where(
                BillingCheckout.id.in_(ids), BillingCheckout.last_checked_at > now() - timedelta(seconds=10)))
            assert checked == count


def test_unknown_creem_checkout_only_blocks_its_own_price(creem_billing):
    state = creem_billing
    state['provider'] = 'creem'
    state['lost_create'] = True
    assert checkout(state, 'creem-month').status_code == 503
    assert checkout(state, 'creem-year').status_code == 200
    assert checkout(state, 'creem-month').status_code != 200
    assert len(state['posts']) == 2
    assert state['posts'][0]['product_id'] == 'prod_monthtrial'
    assert state['posts'][1]['product_id'] == 'prod_year'


def test_independent_subscription_cannot_take_another_accounts_customer(buyer):
    state = buyer
    assert checkout(state, state['price_id']).status_code == 200
    other = login(state['client'], 'other-customer-owner')
    other_id = state['client'].get('/v1/me', headers=other).json()['user']['id']
    from app.billing_models import BillingCustomer, BillingSubscription, BillingInvoice
    from app.db import session_factory
    from app.billing_providers import BillingError
    with session_factory()() as db:
        db.add(BillingCustomer(owner_id=other_id, provider=state['provider'], environment='test', customer_id='cust_other'))
        db.commit()
    with pytest.raises(BillingError, match='BILLING_CUSTOMER_MISMATCH'):
        settle(state, next(iter(state['sessions'].values())), 1, 'cust_other')
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingSubscription)) == 0
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 0


def test_secondary_customer_is_still_account_owned(buyer):
    state = buyer
    for price in (state['price_id'], state['other_price']):
        assert checkout(state, price).status_code == 200
    for index, session in enumerate(list(state['sessions'].values()), 1):
        settle(state, session, index, 'cust_secondary_' + str(index))
    state['auth'] = login(state['client'], 'secondary-customer-other-owner')
    assert checkout(state, state['price_id']).status_code == 200
    from app.billing_models import BillingSubscription, BillingInvoice
    from app.db import session_factory
    from app.billing_providers import BillingError
    with pytest.raises(BillingError, match='BILLING_CUSTOMER_MISMATCH'):
        settle(state, list(state['sessions'].values())[-1], 3, 'cust_secondary_2')
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingSubscription)) == 2
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 2
