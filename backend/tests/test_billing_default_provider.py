"""Global routing only changes new purchases, never existing payment intents."""
from conftest import login
from test_creem_billing import creem_billing, checkout


def enable_stripe(state, monkeypatch):
    from app.config import settings
    from app.db import session_factory
    from app.models import User
    from app.billing_models import BillingPriceBinding
    for key, value in {'STRIPE_ENABLED': 'true', 'STRIPE_SECRET_KEY': 'sk_test_fixture',
        'STRIPE_WEBHOOK_SECRET': 'whsec_fixture', 'STRIPE_RETURN_URL': 'https://comics.example/account/'}.items():
        monkeypatch.setenv(key, value)
    settings.cache_clear()
    with session_factory()() as db:
        db.get(User, state['owner']).role = 'admin'
        db.add(BillingPriceBinding(id='alternate-stripe', price_id=state['price_id'], provider='stripe',
            environment='test', product_id='prod_stripe', provider_price_id='price_stripe', status='active'))
        db.commit()


def test_default_is_unique_and_only_its_quotes_are_public(creem_billing, monkeypatch):
    state = creem_billing
    enable_stripe(state, monkeypatch)
    client, auth = state['client'], state['auth']
    assert client.get('/v1/admin/billing/catalog', headers=auth).json()['default_provider'] == 'creem'
    assert all(len(p['channels']) == 1 and p['channels'][0]['provider'] == 'creem'
        for p in client.get('/v1/billing/catalog').json()['offers'])
    for provider in ('stripe', 'creem', 'stripe'):
        response = client.put('/v1/admin/billing/default-provider', headers=auth, json={'provider': provider})
        assert response.status_code == 200
        assert response.json() == {'default_provider': provider}
        assert all([c['provider'] for c in p['channels']] == [provider]
            for p in client.get('/v1/billing/catalog').json()['offers'])
    from app.billing_models import BillingSettings
    from app.db import session_factory
    from sqlalchemy import func, select
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingSettings)) == 1
        assert db.get(BillingSettings, 1).default_provider == 'stripe'


def test_default_switch_keeps_pending_checkout_and_rejects_nondefault_purchase(creem_billing, monkeypatch):
    state = creem_billing
    original = checkout(state)
    enable_stripe(state, monkeypatch)
    client, auth = state['client'], state['auth']
    assert client.put('/v1/admin/billing/default-provider', headers=auth, json={'provider':'stripe'}).status_code == 200
    status = client.get('/v1/billing/status', headers=auth).json()
    assert status['checkout_provider'] == 'creem'
    assert [c['provider'] for c in status['checkout_price']['channels']] == ['creem']
    assert checkout(state)['checkout_url'] == original['checkout_url']
    other = login(client, 'new-route-buyer')
    rejected = client.post('/v1/billing/checkouts', headers=other,
        json={'price_id':state['price_id'], 'provider':'creem'})
    assert rejected.status_code == 409
    assert rejected.json()['error']['code'] == 'BILLING_CHANNEL_UNAVAILABLE'
    assert len(state['posts']) == 1


def test_default_selection_requires_admin_and_enabled_provider(creem_billing):
    state = creem_billing
    client, auth = state['client'], state['auth']
    path = '/v1/admin/billing/default-provider'
    assert client.put(path, headers=auth, json={'provider':'stripe'}).status_code == 403
    from app.db import session_factory
    from app.models import User
    with session_factory()() as db:
        db.get(User, state['owner']).role = 'admin'
        db.commit()
    assert client.put(path, headers=auth, json={'provider':'stripe'}).status_code == 409
    assert client.put(path, headers=auth, json={'provider':['stripe','creem']}).status_code == 422
    assert client.get('/v1/admin/billing/catalog', headers=auth).json()['default_provider'] == 'creem'
