"""Durable checkout reuse and local recovery summaries; providers are isolated fixtures."""
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from conftest import login
from test_billing_purchases import purchase, buy, paid, historical_checkout
from test_billing_prepaid import prepaid, existing_recurring_subscription


def assert_alternate_key_is_durable(state, monkeypatch):
    from app.billing_models import BillingCheckout, BillingCheckoutAlias, BillingPrice
    from app.config import settings
    from app.db import session_factory
    first = buy(state, 'original-intent')
    assert first.status_code == 200, first.text
    retry = buy(state, 'second-tab-intent')
    assert retry.status_code == 200 and retry.json() == first.json()
    assert buy(state, 'second-tab-intent').json() == first.json()
    with session_factory()() as db:
        row = db.get(BillingCheckout, first.json()['checkout_id'])
        assert row.idempotency_key == 'original-intent'
        assert db.get(BillingCheckoutAlias, (state['owner'], 'original-intent')) is None
        alias = db.get(BillingCheckoutAlias, (state['owner'], 'second-tab-intent'))
        assert alias.checkout_id == row.id
        assert db.scalar(select(func.count()).select_from(BillingCheckoutAlias)) == 1
    assert len(state['posts']) == len(state['sessions']) == 1

    # The caller can lose its reused response, then retry after payment and a
    # catalog/channel change. Both accepted keys must remain the same purchase.
    paid(state)
    with session_factory()() as db:
        db.get(BillingPrice, 'purchase-price').status = 'archived'
        db.commit()
    monkeypatch.setenv(state['provider'].upper() + '_ENABLED', 'false')
    settings.cache_clear()
    requests = len(state['requests'])
    for key in ('original-intent', 'second-tab-intent'):
        result = buy(state, key)
        assert result.status_code == 200, result.text
        assert result.json()['fulfilled'] is True
        assert result.json()['checkout_id'] == first.json()['checkout_id']
        assert result.json()['checkout_url'] is None
    assert len(state['requests']) == requests

    monkeypatch.setenv(state['provider'].upper() + '_ENABLED', 'true')
    settings.cache_clear()
    with session_factory()() as db:
        db.get(BillingPrice, 'purchase-price').status = 'active'
        db.commit()
    fresh = buy(state, 'new-explicit-purchase')
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()['checkout_id'] != first.json()['checkout_id']
    assert len(state['posts']) == len(state['sessions']) == 2


def test_alternate_key_is_durable_without_replacing_original_intent(purchase, monkeypatch):
    assert_alternate_key_is_durable(purchase, monkeypatch)


@pytest.mark.parametrize('prepaid', ['quarter', 'year'], indirect=True)
def test_prepaid_reused_response_can_be_lost_without_rebuying_after_payment(prepaid, monkeypatch):
    assert_alternate_key_is_durable(prepaid, monkeypatch)


@pytest.mark.parametrize('prepaid', ['quarter', 'year'], indirect=True)
def test_prepaid_unknown_new_key_stays_on_original_checkout_through_payment(prepaid):
    from app.billing_models import BillingCheckout, BillingCheckoutAlias
    from app.db import session_factory
    from test_billing_prepaid import membership_records
    state = prepaid
    state['lost'] = True
    assert buy(state, 'unknown-original').status_code == 503
    reused = buy(state, 'unknown-alias')
    if state['provider'] == 'creem':
        assert reused.status_code == 409
        assert reused.json()['error']['code'] == 'CREEM_CHECKOUT_UNCERTAIN'
        assert len(state['posts']) == 1
    else:
        assert reused.status_code == 200, reused.text
        assert len(state['posts']) == 2
    with session_factory()() as db:
        row = db.scalar(select(BillingCheckout))
        checkout_id = row.id
        assert row.idempotency_key == 'unknown-original'
        assert db.get(BillingCheckoutAlias, (state['owner'], 'unknown-alias')).checkout_id == checkout_id
        assert db.scalar(select(func.count()).select_from(BillingCheckout)) == 1
    assert len(state['sessions']) == 1 and len(membership_records()[0]) == 1
    paid(state)
    requests, posts = len(state['requests']), len(state['posts'])
    for key in ('unknown-original', 'unknown-alias'):
        replay = buy(state, key)
        assert replay.status_code == 200, replay.text
        assert replay.json()['fulfilled'] is True and replay.json()['checkout_id'] == checkout_id
    assert len(state['requests']) == requests
    orders, terms, buckets = membership_records()
    assert len(orders) == len(terms) == 1
    assert len(buckets) == (3 if state['interval'] == 'quarter' else 12)
    fresh = buy(state, 'explicit-next-purchase')
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()['checkout_id'] != checkout_id
    assert len(state['sessions']) == 2 and len(state['posts']) == posts + 1


def test_alias_replay_cannot_change_quote_or_provider(purchase):
    from app.billing_models import BillingCheckout, BillingCheckoutAlias
    from app.db import session_factory
    state = purchase
    original = buy(state, 'original-intent').json()
    assert buy(state, 'alternate-intent').json() == original
    requests = len(state['requests'])
    for provider, price_id in ((state['provider'], 'plus-month-v1'),
            ('creem' if state['provider'] == 'stripe' else 'stripe', 'purchase-price')):
        response = state['client'].post('/v1/billing/checkouts',
            headers={**state['auth'], 'Idempotency-Key': 'alternate-intent'},
            json={'provider': provider, 'price_id': price_id})
        assert response.status_code == 409
        assert response.json()['error']['code'] == 'BILLING_CHECKOUT_PRICE_CONFLICT'
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingCheckout)) == 1
        assert db.scalar(select(func.count()).select_from(BillingCheckoutAlias)) == 1
    assert len(state['requests']) == requests


def test_new_key_reuses_oldest_pending_without_merging_historical_checkouts(purchase):
    from app.billing_models import BillingCheckout, BillingCheckoutAlias
    from app.db import session_factory
    state = purchase
    first = historical_checkout(state, 'historical-first')['metadata']['checkout_intent_id']
    second = historical_checkout(state, 'historical-second')['metadata']['checkout_intent_id']
    reused = buy(state, 'new-tab')
    assert reused.status_code == 200 and reused.json()['checkout_id'] == first
    original_second = buy(state, 'historical-second')
    assert original_second.status_code == 200 and original_second.json()['checkout_id'] == second
    with session_factory()() as db:
        assert db.get(BillingCheckoutAlias, (state['owner'], 'new-tab')).checkout_id == first
        assert db.get(BillingCheckout, first).idempotency_key == 'historical-first'
        assert db.get(BillingCheckout, second).idempotency_key == 'historical-second'
        assert db.scalar(select(func.count()).select_from(BillingCheckout)) == 2
    assert len(state['posts']) == len(state['sessions']) == 2


def test_same_key_is_scoped_to_its_account(purchase):
    state = purchase
    original = buy(state, 'original-intent').json()
    assert buy(state, 'alternate-intent').json() == original
    other_auth = login(state['client'], 'another-purchase-owner')
    response = state['client'].post('/v1/billing/checkouts',
        headers={**other_auth, 'Idempotency-Key': 'alternate-intent'},
        json={'provider': state['provider'], 'price_id': 'purchase-price'})
    assert response.status_code == 200, response.text
    assert response.json()['checkout_id'] != original['checkout_id']
    assert len(state['posts']) == len(state['sessions']) == 2


def test_alias_never_resolves_another_accounts_checkout(purchase):
    from app.billing_models import BillingCheckoutAlias
    from app.db import session_factory
    state = purchase
    original = buy(state).json()
    other_auth = login(state['client'], 'another-alias-owner')
    other_owner = state['client'].get('/v1/me', headers=other_auth).json()['user']['id']
    with session_factory()() as db:
        db.add(BillingCheckoutAlias(owner_id=other_owner, idempotency_key='invalid-cross-owner-alias',
            checkout_id=original['checkout_id']))
        db.commit()
    requests = len(state['requests'])
    response = state['client'].post('/v1/billing/checkouts',
        headers={**other_auth, 'Idempotency-Key': 'invalid-cross-owner-alias'},
        json={'provider': state['provider'], 'price_id': 'purchase-price'})
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'BILLING_ACCOUNT_UNBOUND'
    assert len(state['requests']) == requests and len(state['posts']) == 1


def test_quota_pending_summary_requires_exact_quote_and_is_account_scoped(purchase):
    state = purchase
    original = buy(state, 'pack-original').json()
    requests = len(state['requests'])
    response = state['client'].get('/v1/billing/status', headers=state['auth'])
    assert response.status_code == 200, response.text
    assert response.json()['pending_checkout'] is None
    assert response.json()['subscription_checkout'] is None
    exact = state['client'].get('/v1/billing/status', headers=state['auth'],
        params={'price_id': 'purchase-price'}).json()
    assert exact['subscription_checkout'] is None
    pending = exact['pending_checkout']
    assert set(pending) == {'id', 'provider', 'price', 'idempotency_key', 'error'}
    assert pending['id'] == original['checkout_id'] and pending['idempotency_key'] == 'pack-original'
    assert pending['price']['id'] == 'purchase-price' and pending['price']['interval'] == 'once'
    other_auth = login(state['client'], 'another-status-owner')
    other = state['client'].get('/v1/billing/status', headers=other_auth,
        params={'price_id': 'purchase-price'}).json()
    assert other['pending_checkout'] is None and other['subscription_checkout'] is None
    assert len(state['requests']) == requests


@pytest.mark.parametrize('prepaid', ['quarter', 'year'], indirect=True)
def test_prepaid_pending_summary_keeps_original_quote_and_old_field_meaning(prepaid):
    from app.billing_models import BillingCheckout, BillingCheckoutAlias, BillingPrice, BillingPriceBinding
    from app.db import session_factory
    state = prepaid
    original = buy(state, 'prepaid-original').json()
    assert buy(state, 'second-tab').json() == original
    with session_factory()() as db:
        db.get(BillingPrice, 'purchase-price').status = 'archived'
        db.get(BillingPriceBinding, 'purchase-binding').status = 'archived'
        db.commit()
    requests = len(state['requests'])
    for params in ({}, {'price_id': 'purchase-price'}):
        response = state['client'].get('/v1/billing/status', headers=state['auth'], params=params)
        assert response.status_code == 200, response.text
        status = response.json()
        pending = status['pending_checkout']
        assert pending['id'] == original['checkout_id'] and pending['idempotency_key'] == 'prepaid-original'
        assert pending['provider'] == state['provider'] and pending['price']['id'] == 'purchase-price'
        assert pending['price']['billing_type'] == 'onetime' and pending['price']['interval'] == state['interval']
        assert pending['price']['channels'] == [{'provider': state['provider'], 'binding_id': 'purchase-binding',
            'trial_days': 0, 'trial_classic_pages': 0}]
        assert status['subscription_checkout'] is None
    assert len(state['requests']) == requests
    recovered = buy(state, 'after-quote-retired')
    assert recovered.status_code == 200 and recovered.json() == original
    assert len(state['posts']) == len(state['sessions']) == 1
    with session_factory()() as db:
        row = db.get(BillingCheckout, original['checkout_id'])
        assert row.provider == state['provider'] and row.binding_id == 'purchase-binding'
        assert row.idempotency_key == 'prepaid-original'
        assert db.get(BillingCheckoutAlias, (state['owner'], 'after-quote-retired')).checkout_id == row.id


def test_mixed_legacy_pending_orders_preserve_recurring_summary(prepaid):
    from app.billing_models import BillingCheckout, BillingSubscription
    from app.db import session_factory
    state = prepaid
    original = buy(state, 'prepaid-original').json()
    with session_factory()() as db:
        existing_recurring_subscription(db, state)
        db.flush()
        db.delete(db.scalar(select(BillingSubscription)))
        recurring = db.get(BillingCheckout, 'existing-recurring')
        recurring.status = 'open'
        recurring.created_at = db.get(BillingCheckout, original['checkout_id']).created_at + timedelta(seconds=1)
        db.commit()
    requests = len(state['requests'])
    status = state['client'].get('/v1/billing/status', headers=state['auth']).json()
    assert status['pending_checkout']['id'] == original['checkout_id']
    assert status['subscription_checkout']['id'] == 'existing-recurring'
    exact = state['client'].get('/v1/billing/status', headers=state['auth'],
        params={'price_id': 'plus-month-v1'}).json()
    assert exact['pending_checkout'] == exact['subscription_checkout']
    assert exact['pending_checkout']['id'] == 'existing-recurring'
    assert len(state['requests']) == requests
