"""Real Creem HTTP error handling with synthetic transport; never creates payments."""
from urllib.parse import urlsplit

import httpx
import pytest
from sqlalchemy import select

from app.creem_client import call as creem_http_call
from test_billing_purchases import purchase, buy, records


@pytest.mark.parametrize('purchase', ['creem'], indirect=True)
@pytest.mark.parametrize('stage, failure, expected_status, first_http', [
    *[('post', status, 'unknown', 503) for status in (408, 409, 429, 500, 502, 503)],
    ('post', 'timeout', 'unknown', 503),
    ('post', 'non-json', 'unknown', 503),
    ('post', 400, 'failed', 409),
    ('preflight', 503, 'failed', 503),
    ('preflight', 'timeout', 'failed', 503),
    ('preflight', 'non-json', 'failed', 503),
])
def test_quota_pack_http_failure_preserves_original_intent_without_reposting(
        purchase, monkeypatch, stage, failure, expected_status, first_http):
    from app import creem_client
    from app.billing_models import BillingCheckout
    from app.db import session_factory

    state = purchase
    requests = []

    def transport(method, url, *, params=None, json=None, headers=None, **kwargs):
        parsed = urlsplit(url)
        assert parsed.scheme == 'https' and parsed.hostname == 'test-api.creem.io'
        assert headers == {'x-api-key': 'creem_test_fixture'}
        assert kwargs['timeout'] == 20 and kwargs['follow_redirects'] is False
        requests.append((method, parsed.path))
        request = httpx.Request(method, url)
        if method == 'GET' and parsed.path == '/v1/products/prod_pack':
            if stage != 'preflight':
                return httpx.Response(200, json=state['product'], request=request)
        elif method == 'POST' and parsed.path == '/v1/checkouts':
            assert stage == 'post'
            # Packs use the same provider request as prepaid membership; no
            # quota fields or local entitlement intervals leak into checkout.
            assert set(json) == {'product_id', 'request_id', 'units', 'metadata', 'success_url'}
            assert json['product_id'] == 'prod_pack' and json['units'] == 1
            assert json['metadata'] == {'app': 'node_comics', 'checkout_intent_id': json['request_id']}
            assert json['success_url'] == 'https://comics.example/payment/success/'
            state['posts'].append(json)
        else:
            raise AssertionError((method, parsed.path))
        if failure == 'timeout':
            raise httpx.ReadTimeout('synthetic response loss', request=request)
        if failure == 'non-json':
            return httpx.Response(200, content=b'<html>unavailable</html>', request=request)
        return httpx.Response(failure, json={'error': 'synthetic rejection'}, request=request)

    monkeypatch.setattr(httpx, 'request', transport)
    # The shared purchase fixture mocks call() for settlement tests. Restore
    # the real client here so HTTP classification itself is exercised.
    monkeypatch.setattr(creem_client, 'call', creem_http_call)
    response = buy(state)
    assert response.status_code == first_http
    assert response.json()['error']['code'] == 'CREEM_UNAVAILABLE'
    assert requests == [('GET', '/v1/products/prod_pack')] + (
        [('POST', '/v1/checkouts')] if stage == 'post' else [])
    assert len(state['posts']) == (1 if stage == 'post' else 0)

    with session_factory()() as db:
        row = db.scalar(select(BillingCheckout).where(BillingCheckout.owner_id == state['owner']))
        original_id = row.id
    original_order_id = records()[0][0].id

    def unexpected_request(*args, **kwargs):
        pytest.fail('An original purchase replay must not make another provider request')

    monkeypatch.setattr(httpx, 'request', unexpected_request)
    for _ in range(2):
        replay = buy(state)
        assert replay.status_code == 409
        assert replay.json()['error']['code'] == (
            'CREEM_CHECKOUT_UNCERTAIN' if expected_status == 'unknown' else 'BILLING_PURCHASE_RETRY_ALLOWED')
        with session_factory()() as db:
            rows = list(db.scalars(select(BillingCheckout).where(BillingCheckout.owner_id == state['owner'])))
            assert len(rows) == 1 and rows[0].id == original_id
            row = rows[0]
            assert row.status == expected_status and row.last_checked_at is not None
            assert row.session_id is None and row.checkout_url is None
            assert row.error_code == 'CREEM_UNAVAILABLE'
        orders, buckets, ledger = records()
        assert len(orders) == 1 and orders[0].id == original_order_id
        assert orders[0].status == expected_status and orders[0].error_code == 'CREEM_UNAVAILABLE'
        assert orders[0].external_id is None and orders[0].paid_at is None
        assert not buckets and not ledger
    assert len(state['posts']) == (1 if stage == 'post' else 0)
