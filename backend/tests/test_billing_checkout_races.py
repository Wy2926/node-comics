"""A stale preflight cannot clear a durable, possibly accepted payment dispatch."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event, local
import httpx
import pytest
from sqlalchemy import func, select
from test_creem_billing import creem_billing


def test_unknown_creem_dispatch_survives_later_product_validation_failure(creem_billing):
    from app.billing_models import BillingCheckout
    from app.db import session_factory
    state = creem_billing
    state['lost_create'] = True
    request = {'provider': 'creem', 'price_id': state['price_id']}
    assert state['client'].post('/v1/billing/checkouts', headers=state['auth'], json=request).status_code == 503
    initial_reads = len(state['requests'])
    state['products']['prod_monthtrial']['price'] = 1
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'], json=request)
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'CREEM_CHECKOUT_UNCERTAIN'
    assert len(state['requests']) == initial_reads
    with session_factory()() as db:
        assert db.scalar(select(BillingCheckout)).status == 'unknown'
        assert db.scalar(select(func.count()).select_from(BillingCheckout)) == 1
    state['products']['prod_monthtrial']['price'] = 999
    assert state['client'].post('/v1/billing/checkouts', headers=state['auth'], json=request).status_code == 409
    assert len(state['posts']) == 1


@pytest.mark.parametrize('complete_before_failure', [False, True])
def test_stale_preflight_cannot_fail_inflight_or_bound_checkout(creem_billing, monkeypatch, complete_before_failure):
    from app.billing_models import BillingCheckout
    from app.billing_checkout import start_checkout
    from app.billing_providers import BillingError
    from app.db import session_factory
    state = creem_billing
    transport = httpx.request
    role = local()
    preflight_started, release_preflight = Event(), Event()
    post_started, release_post = Event(), Event()

    def controlled_transport(method, url, **kwargs):
        if method == 'GET' and '/products/' in url and getattr(role, 'name', None) == 'stale':
            preflight_started.set()
            assert release_preflight.wait(10)
            raise httpx.ReadTimeout('isolated delayed preflight failure')
        if method == 'POST' and url.endswith('/checkouts') and getattr(role, 'name', None) == 'sender':
            post_started.set()
            assert release_post.wait(10)
        return transport(method, url, **kwargs)

    def purchase(name):
        role.name = name
        try:
            return start_checkout(state['owner'], state['price_id'], 'creem')
        except BillingError as exc:
            return exc.code

    monkeypatch.setattr(httpx, 'request', controlled_transport)
    with ThreadPoolExecutor(max_workers=2) as pool:
        stale = pool.submit(purchase, 'stale')
        try:
            assert preflight_started.wait(10)
            sender = pool.submit(purchase, 'sender')
            assert post_started.wait(10)
            if complete_before_failure:
                release_post.set()
                assert isinstance(sender.result(timeout=10), dict)
            release_preflight.set()
            assert stale.result(timeout=10) == 'CREEM_UNAVAILABLE'
            with session_factory()() as db:
                assert db.scalar(select(BillingCheckout)).status == ('open' if complete_before_failure else 'unknown')
                assert db.scalar(select(func.count()).select_from(BillingCheckout)) == 1
            retry = purchase('retry')
            if complete_before_failure:
                assert isinstance(retry, dict)
            else:
                assert retry == 'CREEM_CHECKOUT_UNCERTAIN'
        finally:
            release_preflight.set()
            release_post.set()
        assert isinstance(sender.result(timeout=10), dict)
    assert len(state['posts']) == 1


@pytest.mark.parametrize('product_id,checkout_id', [
    ('prod_valid/other', 'ch_valid'), ('prod_valid', 'ch_valid?next=other'),
    ('https://evil.example', 'ch_valid'), ('prod_valid', '../ch_valid')])
def test_reconstructed_checkout_url_rejects_noncanonical_ids(product_id, checkout_id):
    from app.creem_client import checkout_url
    from app.billing_providers import BillingError
    with pytest.raises(BillingError, match='CREEM_INVALID_URL'):
        checkout_url(product_id, checkout_id)
