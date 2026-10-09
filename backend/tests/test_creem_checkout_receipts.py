"""A rejected create response may retain only a verified locator, never payment rights."""
import copy

import pytest
from sqlalchemy import select
from conftest import login
from test_billing_purchases import purchase, returning_creem_buyer, buy, paid, records


def checkout_row(owner_id):
    from app.billing_models import BillingCheckout, BillingOrder
    from app.db import session_factory
    with session_factory()() as db:
        row = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == owner_id)
            .order_by(BillingCheckout.created_at.desc()))
        order = db.scalar(select(BillingOrder).where(BillingOrder.checkout_id == row.id))
        return row, order


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('next_price', ['lite-month', 'purchase-price'])
@pytest.mark.parametrize('invalid', ['customer', 'checkout_url'])
def test_rejected_create_retains_locator_for_verified_get_without_repost(
        returning_creem_buyer, monkeypatch, next_price, invalid):
    from app import creem_client
    state = returning_creem_buyer
    original = creem_client.call

    def call(method, path, **kwargs):
        value = original(method, path, **kwargs)
        if method == 'POST' and path == '/checkouts':
            value[invalid] = 'cust_other' if invalid == 'customer' else 'https://evil.invalid/checkout/secret'
        return value

    monkeypatch.setattr(creem_client, 'call', call)
    headers = {**state['auth'], **({'Idempotency-Key': 'next-purchase'} if next_price == 'purchase-price' else {})}
    body = {'provider': 'creem', 'price_id': next_price}
    response = state['client'].post('/v1/billing/checkouts', headers=headers, json=body)
    error = 'BILLING_BINDING_MISMATCH' if invalid == 'customer' else 'CREEM_INVALID_URL'
    assert response.status_code == 409 and response.json()['error']['code'] == error
    remote = list(state['sessions'].values())[-1]
    row, order = checkout_row(state['owner'])
    assert row.session_id == remote['id'] and row.status == order.status == 'unknown'
    assert row.checkout_url is None and row.customer_id == 'cust_pagebuyer'
    assert row.error_code == order.error_code == error
    assert len(records()[1]) == len(records()[2]) == 1

    # A further GET rejection must neither clear the first error nor repeat POST.
    state['pending_customer'] = 'cust_other'
    state['requests'].clear()
    response = state['client'].post('/v1/billing/checkouts', headers=headers, json=body)
    assert response.status_code == 409 and response.json()['error']['code'] == 'BILLING_BINDING_MISMATCH'
    row, order = checkout_row(state['owner'])
    assert row.error_code == order.error_code == error and row.status == 'unknown'
    assert state['requests'] == [('GET', '/checkouts', {'checkout_id': remote['id']}, None)]

    state['pending_customer'] = 'cust_pagebuyer'
    response = state['client'].post('/v1/billing/checkouts', headers=headers, json=body)
    assert response.status_code == 200 and response.json()['checkout_id'] == row.id
    assert len(state['posts']) == 2
    row, order = checkout_row(state['owner'])
    assert row.status == 'open' and order.status == 'pending'
    assert row.error_code is None and order.error_code is None
    assert row.checkout_url and len(records()[1]) == len(records()[2]) == 1


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('change', [
    {'metadata': {}}, {'metadata': {'app': 'other', 'checkout_intent_id': 'other'}},
    {'metadata': 'malformed'}, {'request_id': 'other'}, {'mode': 'prod'},
    {'product': 'prod_other'}, {'units': 2}, {'id': None}, {'id': []}, {'id': 'ch_bad/path'},
])
def test_untrusted_create_identity_is_never_retained(purchase, monkeypatch, change):
    from app import creem_client
    state = purchase
    original = creem_client.call

    def call(method, path, **kwargs):
        value = original(method, path, **kwargs)
        return {**value, **change} if method == 'POST' and path == '/checkouts' else value

    monkeypatch.setattr(creem_client, 'call', call)
    response = buy(state)
    assert response.status_code == 409
    error = response.json()['error']['code']
    row, order = checkout_row(state['owner'])
    assert row.session_id is None and row.checkout_url is None
    assert row.status == order.status == 'unknown' and row.error_code == order.error_code == error
    response = buy(state)
    assert response.status_code == 409 and response.json()['error']['code'] == 'CREEM_CHECKOUT_UNCERTAIN'
    assert checkout_row(state['owner'])[0].error_code == error
    assert len(state['posts']) == 1 and not records()[1] and not records()[2]


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('invalid_customer', [False, True])
def test_existing_other_intent_session_cannot_be_claimed(purchase, monkeypatch, invalid_customer):
    from app import creem_client
    state = purchase
    assert buy(state).status_code == 200
    first, _ = checkout_row(state['owner'])
    other_auth = login(state['client'], 'other-receipt-buyer')
    other_owner = state['client'].get('/v1/me', headers=other_auth).json()['user']['id']
    original = creem_client.call

    def call(method, path, **kwargs):
        value = original(method, path, **kwargs)
        if method == 'POST' and path == '/checkouts':
            value['id'] = first.session_id
            if invalid_customer:
                value['customer'] = {}
        return value

    monkeypatch.setattr(creem_client, 'call', call)
    headers = {**other_auth, 'Idempotency-Key': 'other-purchase'}
    body = {'provider': 'creem', 'price_id': 'purchase-price'}
    response = state['client'].post('/v1/billing/checkouts', headers=headers, json=body)
    assert response.status_code == 409 and response.json()['error']['code'] == 'BILLING_BINDING_MISMATCH'
    row, order = checkout_row(other_owner)
    assert row.session_id is None and row.checkout_url is None
    assert row.status == order.status == 'unknown' and row.last_checked_at is not None
    assert row.error_code == order.error_code == 'BILLING_BINDING_MISMATCH'
    preserved, _ = checkout_row(state['owner'])
    assert preserved.session_id == first.session_id and preserved.status == 'open'
    assert preserved.error_code is None
    response = state['client'].post('/v1/billing/checkouts', headers=headers, json=body)
    assert response.status_code == 409 and response.json()['error']['code'] == 'CREEM_CHECKOUT_UNCERTAIN'
    assert len(state['posts']) == 2 and not records()[1]


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('invalid', ['customer', 'checkout_url'])
def test_failed_external_bind_does_not_save_a_locator(purchase, invalid):
    from app.billing_checkout import bind_session
    from app.billing_providers import BillingError
    state = purchase
    state['lost'] = True
    assert buy(state).status_code == 503
    row, _ = checkout_row(state['owner'])
    value = copy.deepcopy(next(iter(state['sessions'].values())))
    value[invalid] = {} if invalid == 'customer' else 'https://evil.invalid/checkout/private'
    with pytest.raises(BillingError):
        bind_session(row.id, value)
    row, order = checkout_row(state['owner'])
    assert row.session_id is None and row.checkout_url is None
    assert row.status == order.status == 'unknown'
    assert row.error_code == order.error_code == 'CREEM_UNAVAILABLE'
    assert buy(state).json()['error']['code'] == 'CREEM_CHECKOUT_UNCERTAIN'
    assert len(state['posts']) == 1 and not records()[1]


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('callback', ['pending', 'paid'])
def test_late_rejected_create_does_not_downgrade_concurrently_bound_session(purchase, monkeypatch, callback):
    from app import creem_client
    from app.billing_checkout import bind_session
    state = purchase
    original = creem_client.call

    def call(method, path, **kwargs):
        value = original(method, path, **kwargs)
        if method == 'POST' and path == '/checkouts':
            if callback == 'paid':
                paid(state)
            else:
                bind_session(value['metadata']['checkout_intent_id'], value)
            value['checkout_url'] = 'https://evil.invalid/checkout/private'
        return value

    monkeypatch.setattr(creem_client, 'call', call)
    response = buy(state)
    assert response.status_code == 409 and response.json()['error']['code'] == 'CREEM_INVALID_URL'
    row, order = checkout_row(state['owner'])
    assert row.session_id and row.status == ('completed' if callback == 'paid' else 'open')
    assert order.status == ('paid' if callback == 'paid' else 'pending')
    assert row.error_code is None and order.error_code is None
    assert len(records()[1]) == len(records()[2]) == (1 if callback == 'paid' else 0)
    response = buy(state)
    assert response.status_code == 200
    if callback == 'paid':
        assert response.json()['fulfilled'] is True
    assert len(state['posts']) == 1


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('customer', ['omitted', None])
def test_verified_expired_without_customer_allows_explicit_new_intent(returning_creem_buyer, customer):
    state = returning_creem_buyer
    response = buy(state, 'expiring-intent')
    assert response.status_code == 200
    remote = list(state['sessions'].values())[-1]
    remote['status'] = 'expired'
    if customer == 'omitted':
        remote.pop('customer', None)
    else:
        remote['customer'] = customer
    for _ in range(2):
        response = buy(state, 'expiring-intent')
        assert response.status_code == 409 and response.json()['error']['code'] == 'BILLING_PURCHASE_RETRY_ALLOWED'
    row, order = checkout_row(state['owner'])
    assert row.status == order.status == 'expired' and row.customer_id == 'cust_pagebuyer'
    assert row.session_id == remote['id']
    status = state['client'].get('/v1/billing/status', headers=state['auth']).json()
    assert status['subscription_checkout'] is None
    assert len(state['posts']) == 2 and len(records()[1]) == len(records()[2]) == 1
    assert buy(state, 'explicit-new-intent').status_code == 200
    assert len(state['posts']) == 3 and len(records()[1]) == len(records()[2]) == 1


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('status,customer', [('expired', 'cust_other'), ('expired', ''), ('expired', {}), ('unknown', None)])
def test_expired_conflicting_or_unknown_missing_customer_cannot_release_intent(returning_creem_buyer, status, customer):
    state = returning_creem_buyer
    assert buy(state, 'expiring-intent').status_code == 200
    remote = list(state['sessions'].values())[-1]
    remote.update(status=status, customer=customer)
    response = buy(state, 'expiring-intent')
    assert response.status_code == 409 and response.json()['error']['code'] == 'BILLING_BINDING_MISMATCH'
    row, order = checkout_row(state['owner'])
    assert row.status == 'open' and order.status == 'pending' and row.customer_id == 'cust_pagebuyer'
    response = buy(state, 'independent-new-intent')
    assert response.status_code == 200
    assert len(state['posts']) == 3 and len(records()[1]) == len(records()[2]) == 1
