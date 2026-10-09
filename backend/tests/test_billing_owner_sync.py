"""Account reconciliation uses known sessions without repeating checkout recovery."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
import pytest
from sqlalchemy import select
from conftest import login
from test_billing_purchases import purchase, returning_creem_buyer, buy, paid, notify, records, reverse


def due(state, checkout_id=None):
    from app.billing_models import BillingCheckout
    from app.db import session_factory
    with session_factory()() as db:
        query = select(BillingCheckout).where(BillingCheckout.owner_id == state['owner'])
        if checkout_id:
            query = query.where(BillingCheckout.id == checkout_id)
        for row in db.scalars(query):
            row.last_checked_at = state['at'] - timedelta(minutes=1)
        db.commit()
    state['requests'].clear()


def sync(state):
    return state['client'].post('/v1/billing/sync', headers=state['auth'])


def creem_reads(session, transaction=True):
    return [('GET', '/checkouts', {'checkout_id': session['id']}, None)] * 2 + (
        [('GET', '/transactions', {'transaction_id': session['order']['transaction']}, None)] if transaction else [])


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
def test_unknown_lite_does_not_repeat_completed_purchase_reads(returning_creem_buyer):
    from app.billing_models import BillingCheckout
    from app.db import session_factory
    state = returning_creem_buyer
    completed = next(iter(state['sessions'].values()))
    state['lost'] = True  # No response ID exists locally; the dispatch remains uncertain.
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'provider': 'creem', 'price_id': 'lite-month'})
    assert response.status_code == 503 and response.json()['error']['code'] == 'CREEM_UNAVAILABLE'
    due(state)
    response = sync(state)
    assert response.status_code == 409 and response.json()['error']['code'] == 'CREEM_CHECKOUT_UNCERTAIN'
    assert state['requests'] == creem_reads(completed)
    assert len(state['posts']) == 2
    assert len(records()[0]) == 2 and len(records()[1]) == len(records()[2]) == 1
    with session_factory()() as db:
        row = db.scalar(select(BillingCheckout).where(BillingCheckout.price_id == 'lite-month'))
        assert row.status == 'unknown' and row.session_id is None
        assert row.error_code == 'CREEM_UNAVAILABLE'


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('payment_status', ['paid', 'pending'])
def test_owner_sync_keeps_authoritative_payment_verification(purchase, payment_status):
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    state['transactions'][session['order']['transaction']]['status'] = payment_status
    due(state)
    response = sync(state)
    assert state['requests'] == creem_reads(session)
    if payment_status == 'pending':
        assert response.status_code == 409 and response.json()['error']['code'] == 'CREEM_PURCHASE_UNPAID'
        assert not records()[1] and not records()[2]
    else:
        assert response.status_code == 200
        due(state)
        assert sync(state).status_code == 200
        assert state['requests'] == creem_reads(session)
        for _ in range(2):
            assert notify(state, 'checkout.completed', session).status_code == 200
        orders, buckets, ledger = records()
        assert len(orders) == len(buckets) == len(ledger) == 1
        assert orders[0].status == 'paid' and buckets[0].granted == 100
    assert len(state['posts']) == 1


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('remote_status,local_status', [('pending', 'open'), ('expired', 'expired')])
def test_owner_sync_still_binds_known_pending_and_expired(returning_creem_buyer, remote_status, local_status):
    from app.billing_models import BillingCheckout, BillingOrder
    from app.db import session_factory
    state = returning_creem_buyer
    response = buy(state, 'second-purchase')
    assert response.status_code == 200
    checkout_id = response.json()['checkout_id']
    session = list(state['sessions'].values())[-1]
    session['status'] = remote_status
    due(state, checkout_id)
    response = sync(state)
    assert response.status_code == 200
    assert state['requests'] == creem_reads(session, transaction=False)
    with session_factory()() as db:
        row = db.get(BillingCheckout, checkout_id)
        order = db.scalar(select(BillingOrder).where(BillingOrder.checkout_id == checkout_id))
        assert row.status == local_status and row.customer_id == 'cust_pagebuyer'
        assert row.session_id == session['id'] and row.error_code is None
        assert order.status == ('pending' if remote_status == 'pending' else 'expired')
    assert len(records()[1]) == len(records()[2]) == 1


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('field', ['id', 'metadata', 'request_id', 'product', 'customer', 'mode', 'transaction_customer'])
def test_owner_sync_rejects_wrong_session_and_payment_binding(purchase, monkeypatch, field):
    from app import creem_client
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    original = creem_client.call

    def wrong(method, path, **kwargs):
        value = original(method, path, **kwargs)
        if path == '/checkouts' and field != 'transaction_customer':
            value[field] = {'id': 'ch_other', 'metadata': {}, 'request_id': 'other-intent',
                'product': 'prod_other', 'customer': '', 'mode': 'prod'}[field]
        elif path == '/transactions' and field == 'transaction_customer':
            value['customer'] = 'cust_other'
        return value

    monkeypatch.setattr(creem_client, 'call', wrong)
    due(state)
    response = sync(state)
    assert response.status_code == 409
    assert not records()[1] and not records()[2]
    assert len(state['posts']) == 1


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
def test_owner_sync_cannot_follow_another_valid_checkout_response(purchase, monkeypatch):
    from app import creem_client
    state = purchase
    assert buy(state).status_code == 200
    requested = paid(state, sync=False)
    other_auth = login(state['client'], 'other-page-buyer')
    response = state['client'].post('/v1/billing/checkouts',
        headers={**other_auth, 'Idempotency-Key': 'other-intent'},
        json={'provider': 'creem', 'price_id': 'purchase-price'})
    assert response.status_code == 200
    other = paid(state, sync=False)
    original = creem_client.call

    def wrong(method, path, **kwargs):
        if path == '/checkouts' and kwargs.get('params') == {'checkout_id': requested['id']}:
            kwargs['params'] = {'checkout_id': other['id']}
        return original(method, path, **kwargs)

    monkeypatch.setattr(creem_client, 'call', wrong)
    due(state)
    response = sync(state)
    assert response.status_code == 409 and response.json()['error']['code'] == 'BILLING_BINDING_MISMATCH'
    assert len(records()[0]) == 2 and not records()[1] and not records()[2]


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
def test_owner_sync_and_paid_callback_grant_once(purchase, monkeypatch):
    from app import creem_client
    from app.billing_checkout import sync_owner
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    due(state)
    original = creem_client.call
    first_read, release = Event(), Event()

    def delayed(method, path, **kwargs):
        value = original(method, path, **kwargs)
        if path == '/checkouts' and not first_read.is_set():
            first_read.set()
            assert release.wait(10)
        return value

    monkeypatch.setattr(creem_client, 'call', delayed)
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(sync_owner, state['owner'])
        try:
            assert first_read.wait(10)
            for _ in range(2):
                assert notify(state, 'checkout.completed', session).status_code == 200
        finally:
            release.set()
        pending.result(timeout=10)
    orders, buckets, ledger = records()
    assert len(orders) == len(buckets) == len(ledger) == 1
    assert orders[0].status == 'paid' and buckets[0].granted == 100 and buckets[0].revoked_at is None
    assert len(state['posts']) == 1


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('kind', ['refund', 'dispute'])
def test_owner_sync_late_paid_snapshot_cannot_restore_callback_revocation(purchase, monkeypatch, kind):
    from app import creem_client
    from app.billing_checkout import sync_owner
    from app.entitlement_models import QuotaPeriod
    from app.db import session_factory
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state)
    with session_factory()() as db:
        bucket = db.scalar(select(QuotaPeriod).where(QuotaPeriod.source == 'purchase'))
        bucket.used, bucket.reserved = 12, 3
        db.commit()
    due(state)
    original = creem_client.call
    first_read, release = Event(), Event()

    def delayed(method, path, **kwargs):
        value = original(method, path, **kwargs)
        if path == '/checkouts' and not first_read.is_set():
            first_read.set()
            assert release.wait(10)
        return value

    monkeypatch.setattr(creem_client, 'call', delayed)
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(sync_owner, state['owner'])
        try:
            assert first_read.wait(10)
            assert reverse(state, session, kind, stale_payment=True).status_code == 200
            revoked_at = records()[1][0].revoked_at
            assert revoked_at is not None
        finally:
            release.set()
        pending.result(timeout=10)
    due(state)
    assert sync(state).status_code == 200
    assert state['requests'] == creem_reads(session)
    orders, buckets, ledger = records()
    assert len(orders) == len(buckets) == len(ledger) == 1
    assert orders[0].status == ('refunded' if kind == 'refund' else 'disputed')
    assert buckets[0].revoked_at == revoked_at and (buckets[0].used, buckets[0].reserved) == (12, 3)


@pytest.mark.parametrize('purchase', ['stripe'], indirect=True)
def test_owner_sync_does_not_change_stripe_checkout_recovery(purchase):
    state = purchase
    assert buy(state).status_code == 200
    session = paid(state, sync=False)
    due(state)
    assert sync(state).status_code == 200
    reads = [request for request in state['requests'] if request[:2] == ('checkout.sessions', 'retrieve')]
    assert len(reads) == 3 and all(request[2] == (session['id'],) for request in reads)
    assert len(records()[1]) == len(records()[2]) == 1
