"""Provider-neutral product administration and private order audit views."""
from datetime import datetime, timedelta
import pytest
from sqlalchemy import select
from conftest import login
from test_creem_billing import creem_billing


@pytest.fixture
def administrator(client):
    from app.db import session_factory
    from app.models import User
    auth = login(client, 'billing-admin')
    with session_factory()() as db:
        owner = db.scalar(select(User).where(User.subject == 'dev:billing-admin'))
        owner.role = 'admin'
        db.commit()
    return auth


def test_seed_products_have_monthly_and_annual_prices(client, administrator):
    value = client.get('/v1/admin/billing/catalog', headers=administrator).json()
    assert set(value) == {'products', 'channels'}
    plus = next(p for p in value['products'] if p['id'] == 'plus')
    assert {(p['interval'], p['unit_amount']) for p in plus['prices']} == {('month', 999), ('year', 9999)}
    assert all(p['status'] == 'draft' and p['bindings'] == [] for p in plus['prices'])
    assert {c['provider'] for c in value['channels']} == {'stripe', 'creem'}
    assert all('credential_configured' in c and 'webhook_configured' in c for c in value['channels'])


def test_products_revisions_and_prices_are_immutable(client, administrator):
    product = {'id': 'light', 'revision_id': 'light-v1', 'name': 'Light', 'monthly_redraw_pages': 100,
        'trial_days': 0, 'trial_redraw_pages': 0}
    response = client.post('/v1/admin/billing/products', headers=administrator, json=product)
    assert response.status_code == 200, response.text
    assert client.post('/v1/admin/billing/products', headers=administrator, json=product).status_code == 200
    assert client.post('/v1/admin/billing/products', headers=administrator,
        json={**product, 'monthly_redraw_pages': 200}).status_code == 409
    revision = {'id': 'light-v2', 'name': 'Light', 'monthly_redraw_pages': 200, 'trial_days': 0, 'trial_redraw_pages': 0}
    assert client.post('/v1/admin/billing/products/light/revisions', headers=administrator, json=revision).status_code == 200
    assert client.post('/v1/admin/billing/products/missing/revisions', headers=administrator, json=revision).status_code == 404
    price = {'id': 'light-month', 'plan_revision_id': 'light-v1', 'environment': 'test',
        'currency': 'usd', 'unit_amount': 499, 'interval': 'month'}
    assert client.post('/v1/admin/billing/prices', headers=administrator, json=price).status_code == 200
    assert client.post('/v1/admin/billing/prices', headers=administrator, json=price).status_code == 200
    assert client.post('/v1/admin/billing/prices', headers=administrator,
        json={**price, 'unit_amount': 599}).status_code == 409
    assert client.put('/v1/admin/billing/prices/light-month/status', headers=administrator,
        json={'status': 'active'}).status_code == 409


def test_binding_environment_ids_and_creem_trial_products_are_not_reused(client, administrator):
    url = '/v1/admin/billing/prices/plus-month-v1/bindings'
    body = {'id': 'creem-month', 'provider': 'creem', 'environment': 'test', 'product_id': 'prod_regular',
        'trial_product_id': 'prod_trial'}
    assert client.post(url, headers=administrator, json={**body, 'environment': 'live'}).status_code == 409
    assert client.post(url, headers=administrator, json={**body, 'trial_product_id': None}).status_code == 409
    assert client.post(url, headers=administrator, json={**body, 'provider_price_id': 'price_bad'}).status_code == 422
    assert client.post(url, headers=administrator, json=body).status_code == 200
    assert client.post(url, headers=administrator, json=body).status_code == 200
    assert client.post(url, headers=administrator, json={**body, 'product_id': 'prod_changed'}).status_code == 409
    assert client.post('/v1/admin/billing/prices/plus-year-v1/bindings', headers=administrator,
        json={**body, 'id': 'creem-year', 'product_id': 'prod_trial', 'trial_product_id': 'prod_new'}).status_code == 409
    stripe = {'id': 'stripe-month', 'provider': 'stripe', 'environment': 'test', 'product_id': 'prod_regular',
        'provider_price_id': 'price_regular'}
    assert client.post(url, headers=administrator, json=stripe).status_code == 200
    assert client.post('/v1/admin/billing/prices/plus-year-v1/bindings', headers=administrator,
        json={**stripe, 'id': 'stripe-year'}).status_code == 409


def test_two_channels_publish_and_disabled_channel_disappears(client, administrator, monkeypatch):
    from app import billing_providers
    calls = []
    monkeypatch.setattr(billing_providers, 'approved_binding', lambda b, p, r: calls.append((b.provider, p.id)))
    monkeypatch.setattr(billing_providers, 'provider_enabled', lambda p: True)
    monkeypatch.setattr(billing_providers, 'provider_environment', lambda p: 'test')
    url = '/v1/admin/billing/prices/plus-month-v1/bindings'
    for provider in ('stripe', 'creem'):
        body = {'id': provider, 'provider': provider, 'environment': 'test', 'product_id': 'prod_' + provider}
        body.update({'provider_price_id': 'price_stripe'} if provider == 'stripe' else {'trial_product_id': 'prod_trial'})
        assert client.post(url, headers=administrator, json=body).status_code == 200
        assert client.put(f'/v1/admin/billing/bindings/{provider}/status', headers=administrator,
            json={'status': 'active'}).status_code == 200
    assert client.put('/v1/admin/billing/prices/plus-month-v1/status', headers=administrator,
        json={'status': 'active'}).status_code == 200
    from app.billing_catalog import offers
    from app.db import session_factory
    with session_factory()() as db:
        assert {c['provider'] for c in offers(db)[0]['channels']} == {'stripe', 'creem'}
    monkeypatch.setattr(billing_providers, 'provider_enabled', lambda p: p == 'creem')
    with session_factory()() as db:
        assert [c['provider'] for c in offers(db)[0]['channels']] == ['creem']
    assert len(calls) == 4


@pytest.fixture
def order_data(client, administrator):
    from app.db import session_factory
    from app.billing_models import BillingCheckout, BillingOrder, BillingOrderTransition, BillingPriceBinding
    from app.models import User
    buyer_auth = login(client, 'buyer-100')
    other_auth = login(client, 'another-buyer')
    at = datetime(2026, 9, 20, 12)
    with session_factory()() as db:
        buyer = db.scalar(select(User).where(User.subject == 'dev:buyer-100'))
        buyer.name = 'buyer_100%'
        other = db.scalar(select(User).where(User.subject == 'dev:another-buyer'))
        for index, (provider, status, owner) in enumerate((('stripe', 'pending', buyer), ('creem', 'paid', buyer), ('creem', 'failed', other))):
            binding = BillingPriceBinding(id=f'binding-{index}', price_id='plus-month-v1', provider=provider,
                environment='test', product_id=f'prod_{index}', provider_price_id='price_0' if provider == 'stripe' else None)
            db.add(binding)
            db.flush()
            checkout = BillingCheckout(id=f'checkout-{index}', owner_id=owner.id, provider=provider, environment='test',
                price_id='plus-month-v1', binding_id=binding.id, return_url='https://comics.example/account/',
                trial=False, status=status, expires_at=at + timedelta(days=1))
            db.add(checkout)
            db.flush()
            order = BillingOrder(id=f'order-{index}', owner_id=owner.id, provider=provider, environment='test',
                checkout_id=checkout.id, price_id='plus-month-v1', binding_id=binding.id, kind='initial', status=status,
                external_id=f'remote_{index}', currency='usd', total=999, created_at=at + timedelta(minutes=index))
            db.add(order)
            db.flush()
            db.add_all([BillingOrderTransition(id=f'created-{index}', order_id=order.id, source='checkout',
                from_status=None, to_status='creating', created_at=at),
                BillingOrderTransition(id=f'updated-{index}', order_id=order.id, source='webhook',
                event_id=f'{provider}:test:evt_{index}', from_status='creating', to_status=status,
                detail={'reason': 'verified_provider_event'}, created_at=at + timedelta(seconds=1))])
        db.commit()
        return {'buyer': buyer.id, 'buyer_auth': buyer_auth, 'other_auth': other_auth}


def test_order_audit_is_admin_only_and_detail_has_no_payment_url(client, administrator, order_data):
    for auth in ({}, order_data['buyer_auth'], order_data['other_auth']):
        expected = 401 if not auth else 403
        assert client.get('/v1/admin/billing/orders', headers=auth).status_code == expected
        assert client.get('/v1/admin/billing/orders/order-1', headers=auth).status_code == expected
    response = client.get('/v1/admin/billing/orders/order-1', headers=administrator)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['order']['provider'] == 'creem' and value['order']['owner_name'] == 'buyer_100%'
    assert value['price']['unit_amount'] == 999
    assert [t['to_status'] for t in value['transitions']] == ['creating', 'paid']
    assert value['transitions'][1]['detail'] == {'reason': 'verified_provider_event'}
    assert 'return_url' not in value['checkout']
    assert client.get('/v1/admin/billing/orders/missing', headers=administrator).status_code == 404


def test_order_search_filters_and_pagination(client, administrator, order_data):
    url = '/v1/admin/billing/orders'
    first = client.get(url, headers=administrator, params={'page_size': 2}).json()
    second = client.get(url, headers=administrator, params={'page_size': 2, 'page': 2}).json()
    assert first['total'] == 3 and [x['id'] for x in first['items']] == ['order-2', 'order-1']
    assert [x['id'] for x in second['items']] == ['order-0']
    for query, expected in (({'provider': 'stripe'}, ['order-0']), ({'status': 'paid'}, ['order-1']),
            ({'owner_id': order_data['buyer']}, ['order-1', 'order-0']), ({'q': '100%'}, ['order-1', 'order-0']),
            ({'q': 'remote_1'}, ['order-1']), ({'environment': 'live'}, []),
            ({'created_from': '2026-09-20T12:01:00Z', 'created_to': '2026-09-20T20:01:00+08:00'}, ['order-1'])):
        result = client.get(url, headers=administrator, params=query)
        assert result.status_code == 200, result.text
        assert [x['id'] for x in result.json()['items']] == expected
    assert client.get(url, headers=administrator, params={'page_size': 101}).status_code == 422
    assert client.get(url, headers=administrator, params={'created_from': '2026-09-21', 'created_to': '2026-09-20'}).status_code == 422


def test_fresh_migration_matches_model_metadata(client):
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from app.db import Base, engine
    with engine().connect() as connection:
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []


def test_order_events_correlate_resources_and_refunds_without_payload_or_cross_environment(client, administrator, order_data):
    from app.db import session_factory
    from app.billing_models import BillingCheckout, BillingEvent
    at = datetime(2026, 9, 20, 12)
    with session_factory()() as db:
        db.get(BillingCheckout, 'checkout-1').session_id = 'ch_one'
        for event_id, provider, environment, resource, payload, status in (
                ('checkout', 'creem', 'test', 'ch_one', {'private': 'never expose'}, 'processed'),
                ('payment', 'creem', 'test', 'remote_1', {}, 'processing'),
                ('refund', 'creem', 'test', 'ref_one', {'transaction_id': 'remote_1', 'private': 'never expose'}, 'pending'),
                ('wrong-provider', 'stripe', 'test', 'remote_1', {}, 'pending'),
                ('wrong-env', 'creem', 'live', 'remote_1', {}, 'pending'),
                ('wrong-payment', 'creem', 'test', 'remote_2', {}, 'pending')):
            db.add(BillingEvent(id=event_id, provider=provider, environment=environment,
                event_type='refund.created' if event_id == 'refund' else 'checkout.completed',
                resource_id=resource, payload=payload, status=status, attempts=2, occurred_at=at,
                received_at=at, error_code='CREEM_UNAVAILABLE' if status == 'pending' else None))
        db.commit()
    response = client.get('/v1/admin/billing/orders/order-1', headers=administrator)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['events_total'] == 3
    assert {event['id'] for event in value['events']} == {'checkout', 'payment', 'refund'}
    assert {event['status'] for event in value['events']} == {'processed', 'processing', 'pending'}
    assert all(event['attempts'] == 2 for event in value['events'])
    assert all('payload' not in event and 'resource_id' not in event for event in value['events'])
    assert 'never expose' not in response.text


@pytest.mark.parametrize('request_id_present', [True, False])
def test_admin_reconciles_unknown_creem_checkout_without_resending_post(creem_billing, administrator, request_id_present, monkeypatch):
    from app.db import session_factory
    from app.billing_models import BillingCheckout, BillingOrder, BillingSubscription
    from test_creem_billing import complete, periods
    state = creem_billing
    state['lost_create'] = True
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'provider': 'creem', 'price_id': state['price_id']})
    assert response.status_code == 503 and len(state['posts']) == 1
    remote = complete(state, synchronize=False)
    if not request_id_present:
        import httpx
        transport = httpx.request
        def omit_request_id(method, url, **kwargs):
            response = transport(method, url, **kwargs)
            if method == 'GET' and url.endswith('/checkouts'):
                value = response.json()
                value.pop('request_id', None)
                return httpx.Response(response.status_code, json=value, request=response.request)
            return response
        monkeypatch.setattr(httpx, 'request', omit_request_id)
    with session_factory()() as db:
        order = db.scalar(select(BillingOrder))
        order_id = order.id
        assert order.status == 'unknown'
    url = f'/v1/admin/billing/orders/{order_id}/reconcile'
    assert state['client'].post(url, headers=state['auth'], json={'session_id': remote['id']}).status_code == 403
    state['sessions']['ch_foreign'] = {**remote, 'id': 'ch_foreign', 'request_id': 'other-intent',
        'metadata': {'app': 'node_comics', 'checkout_intent_id': 'other-intent'}}
    response = state['client'].post(url, headers=administrator, json={'session_id': 'ch_foreign'})
    assert response.status_code == 409, response.text
    with session_factory()() as db:
        assert db.scalar(select(BillingSubscription)) is None
        assert db.scalar(select(BillingCheckout)).session_id is None
    response = state['client'].post(url, headers=administrator, json={'session_id': remote['id']})
    assert response.status_code == 200, response.text
    assert response.json() == {'order_id': order_id, 'status': 'trialing'}
    assert [period.granted for period in periods()] == [30]
    assert len(state['posts']) == 1
    # A later operator attempt cannot replace the already bound session.
    assert state['client'].post(url, headers=administrator, json={'session_id': 'ch_foreign'}).status_code == 409
    assert len(state['posts']) == 1


def test_early_subscription_notification_is_visible_before_subscription_binding(creem_billing, administrator, monkeypatch):
    from app import billing_api
    from app.billing_models import BillingCheckout, BillingEvent, BillingOrder
    from app.db import session_factory
    from test_creem_billing import complete, signed_event
    state = creem_billing
    complete(state, synchronize=False)
    monkeypatch.setattr(billing_api, 'process_event', lambda event_id: None)
    value = {**state['subscriptions']['sub_fixture'],
        'customer': {'id': 'cust_fixture', 'email': 'private@example.invalid', 'name': 'Private Name'}}
    payload, headers = signed_event(state, 'subscription.trialing', value, 'evt_earlysubscription')
    assert state['client'].post('/webhooks/creem', content=payload, headers=headers).status_code == 200
    with session_factory()() as db:
        checkout = db.scalar(select(BillingCheckout))
        order = db.scalar(select(BillingOrder))
        assert order.subscription_id is None
        event = db.get(BillingEvent, 'creem:test:evt_earlysubscription')
        assert event.payload == {'checkout_id': checkout.id}
        order_id = order.id
    response = state['client'].get(f'/v1/admin/billing/orders/{order_id}', headers=administrator)
    assert response.status_code == 200, response.text
    assert response.json()['events_total'] == 1
    assert response.json()['events'][0]['status'] == 'pending'
    assert 'private@example.invalid' not in response.text and 'Private Name' not in response.text


def test_event_reference_snapshot_validates_ids_and_ignores_private_and_malformed_metadata():
    from app.billing_api import event_references
    assert event_references({'metadata': ['bad'], 'charge': {'id': 'ch_test', 'email': 'private'},
        'invoice': {'id': 'in_test', 'name': 'private'}, 'transaction': {'id': ['not-an-id']},
        'subscription': 'bad id', 'parent': 'bad', 'customer': {'email': 'private'}}) == {
            'charge_id': 'ch_test', 'invoice_id': 'in_test'}


def test_non_ascii_creem_signature_is_unauthorized(creem_billing):
    response = creem_billing['client'].post('/webhooks/creem', content=b'{}',
        headers={b'creem-signature': b'\xff', b'content-type': b'application/json'})
    assert response.status_code == 401


def test_creem_create_only_url_is_reused_privately_and_not_in_order_detail(creem_billing, administrator):
    from app.db import session_factory
    from app.billing_models import BillingCheckout, BillingOrder
    from test_creem_billing import checkout
    state = creem_billing
    first = checkout(state)
    # The fixture's GET response omits checkout_url, matching the real platform.
    assert checkout(state) == first
    assert len(state['posts']) == 1
    with session_factory()() as db:
        stored = db.scalar(select(BillingCheckout))
        assert stored.checkout_url == first['checkout_url']
        order_id = db.scalar(select(BillingOrder.id))
    response = state['client'].get(f'/v1/admin/billing/orders/{order_id}', headers=administrator)
    assert response.status_code == 200, response.text
    assert 'checkout_url' not in response.json()['checkout']
    assert first['checkout_url'] not in response.text


def test_admin_recovers_pending_lost_post_and_owner_resumes_without_second_payment(creem_billing, administrator):
    from app.db import session_factory
    from app.billing_models import BillingCheckout, BillingOrder
    state = creem_billing
    state['lost_create'] = True
    request = {'provider': 'creem', 'price_id': state['price_id']}
    assert state['client'].post('/v1/billing/checkouts', headers=state['auth'], json=request).status_code == 503
    remote = next(iter(state['sessions'].values()))
    assert remote['status'] == 'pending'
    with session_factory()() as db:
        assert db.scalar(select(BillingCheckout)).checkout_url is None
        order_id = db.scalar(select(BillingOrder.id))
    response = state['client'].post(f'/v1/admin/billing/orders/{order_id}/reconcile',
        headers=administrator, json={'session_id': remote['id']})
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'pending'
    for _ in range(2):
        response = state['client'].post('/v1/billing/checkouts', headers=state['auth'], json=request)
        assert response.status_code == 200, response.text
        assert response.json()['checkout_url'] == 'https://creem.io/test/checkout/prod_monthtrial/' + remote['id']
    with session_factory()() as db:
        assert db.scalar(select(BillingCheckout)).checkout_url == response.json()['checkout_url']
    assert len(state['posts']) == 1
