"""Current public products, quarterly grants and no-trial payment contracts."""
from datetime import datetime
from types import SimpleNamespace
import pytest
from sqlalchemy import select, update
from conftest import login
from app.billing_models import BillingCheckout, BillingPlanRevision, BillingPrice, BillingPriceBinding, BillingSubscription, BillingSettings
from app.db import session_factory
from app.entitlement_models import QuotaPeriod
from app.models import User


@pytest.fixture
def catalog_products():
    return None  # Exercise the real public seed, not the protocol tests' sample catalog.


def test_current_catalog_is_finite_no_trial_and_packs_never_expire(client):
    from app.billing_catalog import initialize_catalog
    with session_factory()() as db:
        initialize_catalog(db)
        assert {(p.id, p.unit_amount) for p in db.scalars(select(BillingPrice))} == {
            ('plus-quarter-v1', 666), ('plus-year-v1', 2399),
            ('pro-quarter-v1', 999), ('pro-year-v1', 3599),
            ('pages-3500-once-v1', 599), ('pages-7000-once-v1', 999)}
        for plan, pages in [('plus', 2500), ('pro', 4000)]:
            revision = db.get(BillingPlanRevision, plan + '-v1')
            assert revision.monthly_classic_pages == pages
            assert (revision.trial_days, revision.trial_classic_pages) == (0, 0)
        for pages in (3500, 7000):
            revision = db.get(BillingPlanRevision, f'pages-{pages}-v1')
            assert (revision.quota_pages, revision.quota_validity_days, revision.service_plan_id) == (pages, None, 'plus')
        assert all(p.status == 'draft' for p in db.scalars(select(BillingPrice)))


@pytest.mark.parametrize('plan,pages', [('plus', 2500), ('pro', 4000)])
@pytest.mark.parametrize('interval,count,end', [('quarter', 3, datetime(2026, 4, 30)), ('year', 12, datetime(2027, 1, 31))])
def test_paid_periods_grant_monthly_without_early_access_or_duplicates(client, plan, pages, interval, count, end):
    from app.billing_grants import grant_term
    from app.billing_access import first_subscription
    auth = login(client, 'catalog-reader')
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    start = datetime(2026, 1, 31)
    with session_factory()() as db:
        price = db.get(BillingPrice, f'{plan}-{interval}-v1')
        binding = BillingPriceBinding(id='grant-binding', price_id=price.id, provider='stripe',
            environment='test', product_id='prod_fixture', provider_price_id='price_fixture', status='draft')
        db.add(binding)
        db.flush()
        db.add(BillingCheckout(id='grant-checkout', owner_id=owner, provider='stripe', environment='test',
            price_id=price.id, binding_id=binding.id, return_url='https://comics.example/account/',
            status='completed', trial=False, expires_at=start))
        db.flush()
        sub = BillingSubscription(id='stripe:test:sub_grant', owner_id=owner, provider='stripe',
            checkout_id='grant-checkout', environment='test', customer_id='cus_fixture',
            price_id=price.id, binding_id=binding.id, status='active')
        db.add(sub)
        db.flush()
        for _ in range(2):
            grant_term(db, db.get(User, owner), sub, price, 'paid', start, end)
        buckets = list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.owner_id == owner,
            QuotaPeriod.source == 'subscription').order_by(QuotaPeriod.starts_at)))
        assert len(buckets) == count
        assert all(bucket.granted == pages for bucket in buckets)
        assert [bucket.starts_at.day for bucket in buckets[:3]] == [31, 28, 31]
        assert buckets[-1].ends_at == end
        assert first_subscription(db, owner, start)[0].id == buckets[0].id
        buckets[0].used = pages
        db.flush()
        assert first_subscription(db, owner, start) is None
        assert first_subscription(db, owner, datetime(2026, 2, 28))[0].id == buckets[1].id


def test_models_are_restricted_to_the_confirmed_tiers(client):
    from app.translation_models import TranslationProvider
    from app.translation_providers import provider_profile
    from manual_membership_server import seed_models
    with session_factory()() as db:
        db.execute(update(TranslationProvider).values(enabled=False))
        seed_models(db)
        for plan in ('guest', 'free', 'plus', 'pro'):
            profile = provider_profile(db, plan_id=plan, routing_key='catalog-acceptance')
            assert profile['model'] == ('GPT 6 Luna' if plan in ('guest', 'free') else 'Haiku 5.5')


@pytest.mark.parametrize('provider', ['stripe', 'creem'])
@pytest.mark.parametrize('plan', ['plus', 'pro'])
def test_new_quarterly_checkout_never_requests_a_trial(client, monkeypatch, provider, plan):
    from app import stripe_client, creem_client
    from app.config import settings
    from app.billing_models import BillingCheckout
    for key, value in {f'{provider.upper()}_ENABLED': 'true', f'{provider.upper()}_ENVIRONMENT': 'test',
            f'{provider.upper()}_RETURN_URL': 'https://comics.example/account/',
            'STRIPE_SECRET_KEY': 'sk_test_fixture', 'STRIPE_WEBHOOK_SECRET': 'whsec_fixture',
            'CREEM_API_KEY': 'creem_test_fixture', 'CREEM_WEBHOOK_SECRET': 'creem_fixture'}.items():
        monkeypatch.setenv(key, value)
    settings.cache_clear()
    price_id, amount = f'{plan}-quarter-v1', 666 if plan == 'plus' else 999
    with session_factory()() as db:
        db.get(BillingSettings, 1).default_provider = provider
        db.get(BillingPrice, price_id).status = 'active'
        db.add(BillingPriceBinding(id='checkout-binding', price_id=price_id, provider=provider,
            environment='test', product_id='prod_fixture', provider_price_id='price_fixture' if provider == 'stripe' else None,
            trial_product_id=None, status='active'))
        db.commit()
    dispatched = []
    def stripe_call(resource, action, *args, **kwargs):
        if resource == 'prices':
            return {'id': 'price_fixture', 'product': 'prod_fixture', 'livemode': False, 'active': True,
                'currency': 'usd', 'unit_amount': amount, 'recurring': {'interval': 'month', 'interval_count': 3, 'usage_type': 'licensed'}}
        assert (resource, action) == ('checkout.sessions', 'create')
        params = kwargs['params']
        assert 'trial_period_days' not in params['subscription_data']
        dispatched.append(params)
        return {'id': 'cs_test_fixture', 'livemode': False, 'mode': 'subscription', 'status': 'open',
            'metadata': params['metadata'], 'client_reference_id': params['client_reference_id'],
            'url': 'https://checkout.stripe.com/c/pay/cs_test_fixture'}
    def creem_call(method, path, **kwargs):
        if method == 'GET':
            assert path == '/products/prod_fixture'
            return {'id': 'prod_fixture', 'mode': 'test', 'status': 'active', 'currency': 'USD',
                'price': amount, 'billing_type': 'recurring', 'billing_period': 'every-three-months', 'trial_period_days': 0}
        params = kwargs['body']
        assert params['product_id'] == 'prod_fixture'
        dispatched.append(params)
        return {'id': 'ch_fixture', 'mode': 'test', 'status': 'pending', 'product': 'prod_fixture',
            'metadata': params['metadata'], 'request_id': params['request_id'],
            'checkout_url': 'https://creem.io/test/checkout/prod_fixture/ch_fixture'}
    monkeypatch.setattr(stripe_client, 'call', stripe_call)
    monkeypatch.setattr(creem_client, 'call', creem_call)
    auth = login(client, 'new-buyer')
    response = client.post('/v1/billing/checkouts', headers=auth, json={'price_id': price_id, 'provider': provider})
    assert response.status_code == 200, response.text
    assert len(dispatched) == 1
    with session_factory()() as db:
        assert db.scalar(select(BillingCheckout)).trial is False


@pytest.mark.parametrize('count', [1, 2, 4, 12])
def test_stripe_quarter_rejects_wrong_month_count(client, monkeypatch, count):
    from app.stripe_client import approved_price
    from app.billing_providers import BillingError
    from app.config import settings
    monkeypatch.setenv('STRIPE_ENVIRONMENT', 'test')
    settings.cache_clear()
    quote = SimpleNamespace(interval='quarter', environment='test', stripe_price_id='price_fixture',
        stripe_product_id='prod_fixture', currency='usd', unit_amount=666)
    with pytest.raises(BillingError):
        approved_price({'livemode': False, 'id': 'price_fixture', 'product': 'prod_fixture',
            'currency': 'usd', 'unit_amount': 666,
            'recurring': {'interval': 'month', 'interval_count': count, 'usage_type': 'licensed'}}, quote)
