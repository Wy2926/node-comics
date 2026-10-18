"""One product can sell recurring and prepaid terms without changing old offers."""
from types import SimpleNamespace
import pytest
from pydantic import ValidationError
from sqlalchemy import select
from conftest import login
from app.admin_audit import AdminAudit
from app.billing_models import BillingPlanRevision, BillingPrice, BillingPriceBinding, BillingSettings
from app.db import session_factory
from app.models import User


@pytest.fixture
def catalog_products():
    return None


def price_request(**changes):
    return dict(id='new-price', plan_revision_id='plus-v1', environment='test',
        currency='usd', unit_amount=666, interval='quarter', billing_type='onetime') | changes


@pytest.mark.parametrize('interval,expected', [('once', 'onetime'), ('month', 'recurring'),
    ('quarter', 'recurring'), ('year', 'recurring')])
def test_legacy_price_request_infers_payment_type(interval, expected):
    from app.billing_catalog import PriceRequest
    payload = price_request(interval=interval)
    payload.pop('billing_type')
    assert PriceRequest(**payload).billing_type == expected


@pytest.mark.parametrize('interval,billing_type', [('once', 'recurring'), ('month', 'onetime')])
def test_invalid_payment_duration_combinations_are_rejected(interval, billing_type):
    from app.billing_catalog import PriceRequest
    with pytest.raises(ValidationError):
        PriceRequest(**price_request(interval=interval, billing_type=billing_type))


def admin_auth(client):
    auth = login(client, 'catalog-admin')
    with session_factory()() as db:
        db.scalar(select(User).where(User.subject == 'dev:catalog-admin')).role = 'admin'
        db.commit()
    return auth


def test_same_product_revision_retains_four_offers_and_replaces_only_its_payment_type(client, monkeypatch):
    from app import billing_api, billing_catalog, billing_providers
    monkeypatch.setattr(billing_catalog, 'validate_binding', lambda *args: None)
    monkeypatch.setattr(billing_providers, 'provider_enabled', lambda provider: provider == 'stripe')
    monkeypatch.setattr(billing_api, 'provider_enabled', lambda provider: provider == 'stripe')
    monkeypatch.setattr(billing_providers, 'provider_environment', lambda provider: 'test')
    auth = admin_auth(client)
    with session_factory()() as db:
        db.get(BillingSettings, 1).default_provider = 'stripe'
        for interval in ('quarter', 'year'):
            for suffix in ('-v1', '-prepaid-v1'):
                price_id = f'plus-{interval}{suffix}'
                db.add(BillingPriceBinding(id=price_id + '-stripe', price_id=price_id, provider='stripe',
                    environment='test', product_id='prod_plus', provider_price_id='price_' + price_id, status='active'))
        db.commit()
    for interval in ('quarter', 'year'):
        for suffix in ('-v1', '-prepaid-v1'):
            response = client.put(f'/v1/admin/billing/prices/plus-{interval}{suffix}/status',
                headers=auth, json={'status': 'active'})
            assert response.status_code == 200, response.text
    catalog = client.get('/v1/billing/catalog').json()
    assert {(p['interval'], p['billing_type']) for p in catalog['offers']} == {
        ('quarter', 'recurring'), ('quarter', 'onetime'), ('year', 'recurring'), ('year', 'onetime')}
    assert {p['plan_revision_id'] for p in catalog['offers']} == {'plus-v1'}
    assert not catalog['quota_offers']
    replacement = price_request(id='plus-new-prepaid-quarter', unit_amount=777)
    assert client.post('/v1/admin/billing/prices', headers=auth, json=replacement).status_code == 200
    assert client.post('/v1/admin/billing/prices', headers=auth, json=replacement).status_code == 200
    assert client.post('/v1/admin/billing/prices', headers=auth,
        json=replacement | {'billing_type': 'recurring'}).status_code == 409
    with session_factory()() as db:
        db.add(BillingPriceBinding(id='new-prepaid-binding', price_id=replacement['id'], provider='stripe',
            environment='test', product_id='prod_plus', provider_price_id='price_new', status='active'))
        db.commit()
    for _ in range(2):
        response = client.put(f"/v1/admin/billing/prices/{replacement['id']}/status", headers=auth, json={'status': 'active'})
        assert response.status_code == 200, response.text
    with session_factory()() as db:
        old = db.get(BillingPrice, 'plus-quarter-prepaid-v1')
        assert (old.status, old.unit_amount, old.plan_revision_id) == ('archived', 666, 'plus-v1')
        assert db.get(BillingPrice, 'plus-quarter-v1').status == 'active'
        assert db.get(BillingPrice, 'plus-year-v1').status == 'active'
        assert db.get(BillingPrice, 'plus-year-prepaid-v1').status == 'active'
        assert db.get(BillingPriceBinding, 'plus-quarter-prepaid-v1-stripe').status == 'active'
        db.add(BillingPriceBinding(id='replacement-prepaid-binding', price_id=replacement['id'], provider='stripe',
            environment='test', product_id='prod_plus', provider_price_id='price_replacement', status='draft'))
        db.commit()
    for _ in range(2):
        response = client.put('/v1/admin/billing/bindings/replacement-prepaid-binding/status',
            headers=auth, json={'status': 'active'})
        assert response.status_code == 200, response.text
    with session_factory()() as db:
        assert db.get(BillingPrice, replacement['id']).status == 'active'
        assert db.get(BillingPriceBinding, 'replacement-prepaid-binding').status == 'active'
        assert db.get(BillingPriceBinding, 'new-prepaid-binding').status == 'archived'
        assert db.get(BillingPriceBinding, 'plus-quarter-v1-stripe').status == 'active'
        assert db.get(BillingPriceBinding, 'plus-quarter-prepaid-v1-stripe').status == 'active'
        for action, target, archived in [('billing.price.status', replacement['id'], 'plus-quarter-prepaid-v1'),
                ('billing.binding.status', 'replacement-prepaid-binding', 'new-prepaid-binding')]:
            audits = list(db.scalars(select(AdminAudit).where(AdminAudit.action == action, AdminAudit.target_id == target)))
            assert sorted(audit.details['automatically_archived_ids'] for audit in audits) == [[], [archived]]


def test_prepaid_membership_rejects_trial_or_page_pack_revision(client):
    auth = admin_auth(client)
    with session_factory()() as db:
        db.add(BillingPlanRevision(id='trial-revision', plan_id='plus', version=2, name='Trial',
            monthly_classic_pages=2500, trial_days=7, trial_classic_pages=30))
        db.commit()
    for revision in ('trial-revision', 'pages-3500-v1'):
        response = client.post('/v1/admin/billing/prices', headers=auth,
            json=price_request(plan_revision_id=revision))
        assert response.status_code == 422, response.text


@pytest.mark.parametrize('interval', ['quarter', 'year'])
@pytest.mark.parametrize('provider', ['stripe', 'creem'])
@pytest.mark.parametrize('billing_type', ['onetime', 'recurring'])
def test_remote_binding_requires_explicit_matching_payment_type(monkeypatch, interval, provider, billing_type):
    from app import creem_client, stripe_client
    from app.billing_providers import BillingError
    from app.config import settings
    monkeypatch.setenv(provider.upper() + '_ENVIRONMENT', 'test')
    settings.cache_clear()
    quote = SimpleNamespace(interval=interval, billing_type=billing_type, environment='test',
        currency='usd', unit_amount=666, stripe_product_id='prod_plus', stripe_price_id='price_prepaid')
    other_type = 'recurring' if billing_type == 'onetime' else 'onetime'
    if provider == 'stripe':
        cadences = {'onetime': {'type': 'one_time', 'recurring': None},
            'recurring': {'type': 'recurring', 'recurring': {
                'interval': 'month' if interval == 'quarter' else 'year',
                'interval_count': 3 if interval == 'quarter' else 1, 'usage_type': 'licensed'}}}
        remote = dict(id='price_prepaid', product='prod_plus', livemode=False,
            currency='usd', unit_amount=666, **cadences[billing_type])
        stripe_client.approved_price(remote, quote)
        remote.update(cadences[other_type])
        with pytest.raises(BillingError, match='STRIPE_PLAN_MISMATCH'):
            stripe_client.approved_price(remote, quote)
        del quote.billing_type
        with pytest.raises(AttributeError, match='billing_type'):
            stripe_client.approved_price(remote, quote)
    else:
        periods = {'onetime': 'once',
            'recurring': 'every-three-months' if interval == 'quarter' else 'every-year'}
        remote = dict(id='prod_plus', mode='test', status='active', currency='USD', price=666,
            billing_type=billing_type, billing_period=periods[billing_type], trial_period_days=0)
        creem_client.approved_product(remote, 'prod_plus', quote, 0)
        remote.update(billing_type=other_type, billing_period=periods[other_type])
        with pytest.raises(BillingError, match='CREEM_PLAN_MISMATCH'):
            creem_client.approved_product(remote, 'prod_plus', quote, 0)
        del quote.billing_type
        with pytest.raises(AttributeError, match='billing_type'):
            creem_client.approved_product(remote, 'prod_plus', quote, 0)


def test_bootstrap_does_not_add_or_replace_offers_for_existing_products(client):
    from app.billing_catalog import initialize_catalog
    with session_factory()() as db:
        prepaid = db.get(BillingPrice, 'plus-quarter-prepaid-v1')
        db.delete(prepaid)
        db.get(BillingPrice, 'plus-quarter-v1').status = 'archived'
        db.flush()
        initialize_catalog(db)
        db.flush()
        assert db.get(BillingPrice, 'plus-quarter-prepaid-v1') is None
        assert db.get(BillingPrice, 'plus-quarter-v1').status == 'archived'
        assert not list(db.scalars(select(BillingPriceBinding)))
