"""Stripe renewal deferrals through the real SDK and an isolated HTTP transport."""
from datetime import datetime, timedelta, timezone

import pytest
from test_stripe_billing import billing, complete_trial, invoice, periods, rights
from test_billing_renewal import gift, sync, stored_subscription


@pytest.fixture
def stripe_renewal(billing, monkeypatch):
    from app import billing_checkout, billing_orders, billing_renewal, entitlements, stripe_billing_sync
    from app.billing_models import BillingAccount
    from app.db import session_factory
    state = billing
    state['clock'] = datetime.fromtimestamp(state['at'] + 1, timezone.utc).replace(tzinfo=None, microsecond=456789)
    for module in (billing_checkout, billing_orders, billing_renewal, entitlements, stripe_billing_sync):
        monkeypatch.setattr(module, 'now', lambda: state['clock'])
    with session_factory()() as db:
        db.add(BillingAccount(owner_id=state['owner'], trial_used_at=state['clock'] - timedelta(days=100)))
        db.commit()
    complete_trial(state, synchronize=False)
    state['sub'].update(status='active', trial_start=None, trial_end=None)
    state['sub']['items']['data'][0]['current_period_end'] = state['at'] + 30 * 86400
    invoice(state)
    stripe_billing_sync.sync_subscription('sub_fixture')
    state['paid_end'] = max(period.ends_at for period in periods())
    return state


def finish_gift(state, *, paid=True):
    state['clock'] = stored_subscription().resume_at
    start = int(state['clock'].replace(tzinfo=timezone.utc).timestamp())
    state['sub'].update(status='active')
    state['sub']['items']['data'][0]['current_period_end'] = start + 30 * 86400
    if paid:
        invoice(state, index=2, start=start)
    # Stripe keeps the promotional trial_start/end after the deferred renewal.


def test_stripe_gift_defers_billing_and_repeated_sync_ignores_promotional_trial(stripe_renewal):
    state = stripe_renewal
    original = [(row.id, row.starts_at, row.ends_at) for row in periods()]
    issued = gift(state)
    assert issued['gift']['state'] == 'pending'
    current = sync(state)
    assert current['entitlements']['gift']['state'] == 'scheduled'
    assert stored_subscription().resume_at == state['paid_end'] + timedelta(days=30)
    assert stored_subscription().trial_starts_at is None
    assert len(state['subscription_posts']) == 1
    assert state['subscription_posts'][0][1]['trial_end'] == str(int(
        (state['paid_end'] + timedelta(days=30)).replace(tzinfo=timezone.utc).timestamp()))
    assert [(row.id, row.starts_at, row.ends_at) for row in periods()] == original
    assert any(row['total'] == 0 and row['billing_reason'] == 'subscription_update' for row in state['invoices'].values())
    state['clock'] = state['paid_end']
    assert rights(state)['gift']['state'] == 'active'
    assert rights(state)['modes']['classic']['quota']['available'] == 300
    finish_gift(state)
    for _ in range(3):
        finished = sync(state)
        assert finished['entitlements']['plan'] == 'plus'
        assert finished['billing']['subscription']['renewal_state'] == 'normal'
        assert finished['billing']['subscription']['resume_at'] is None
    assert len(periods()) == 2 and stored_subscription().trial_starts_at is None
    assert len(state['subscription_posts']) == 1


def test_stripe_resumed_status_without_payment_does_not_grant_access(stripe_renewal):
    state = stripe_renewal
    gift(state)
    finish_gift(state, paid=False)
    for _ in range(2):
        assert sync(state)['entitlements']['plan'] == 'free'
    assert len(periods()) == 1


def test_stripe_cancellation_keeps_gift_and_does_not_restore_billing(stripe_renewal):
    state = stripe_renewal
    gift(state)
    response = state['client'].post('/v1/billing/cancel-renewal', headers=state['auth'], json={'provider': 'stripe'})
    assert response.status_code == 200, response.text
    assert response.json()['subscription']['auto_renew'] is False
    assert state['subscription_posts'][-1][1] == {'cancel_at_period_end': 'true'}
    state['clock'] = state['paid_end'] + timedelta(days=1)
    assert sync(state)['entitlements']['gift']['state'] == 'active'
    state['clock'] = state['paid_end'] + timedelta(days=30)
    state['sub']['status'] = 'canceled'
    for _ in range(2):
        assert sync(state)['billing']['subscription']['auto_renew'] is False
    assert len(state['subscription_posts']) == 2


@pytest.mark.parametrize('applied', [False, True])
def test_stripe_unknown_update_uses_reads_without_another_write(stripe_renewal, applied):
    state = stripe_renewal
    state['subscription_update_loss'] = 'after' if applied else 'before'
    gift(state)
    assert stored_subscription().renewal_error == 'BILLING_RENEWAL_UNCERTAIN'
    for _ in range(2):
        synced = sync(state)
    assert len(state['subscription_posts']) == 1
    assert synced['entitlements']['gift']['state'] == ('scheduled' if applied else 'pending')
    assert len(periods()) == 1


def test_stripe_declines_extension_until_cancel_is_confirmed(stripe_renewal):
    from conftest import login
    state = stripe_renewal
    gift(state)
    before = rights(state)['gift']
    payload = {'days': 30, 'note': 'isolated additional reward'}
    route = f"/v1/admin/users/{state['owner']}/membership"
    response = state['client'].post(route,
        headers={**login(state['client'], 'admin'), 'Idempotency-Key': 'append-stripe'}, json=payload)
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'BILLING_GIFT_EXTENSION_UNSUPPORTED'
    assert rights(state)['gift'] == before
    assert len(state['subscription_posts']) == 1
    canceled = state['client'].post('/v1/billing/cancel-renewal', headers=state['auth'], json={'provider': 'stripe'})
    assert canceled.status_code == 200
    assert gift(state, 30, 'append-after-cancel')['gift']['days'] == 60
    assert len(state['subscription_posts']) == 2


def test_stripe_second_reward_does_not_reinterpret_previous_trial_dates(stripe_renewal):
    state = stripe_renewal
    gift(state)
    finish_gift(state)
    sync(state)
    second = gift(state, 30, 'next-activity-reward')
    assert second['gift']['state'] == 'pending'
    assert sync(state)['entitlements']['gift']['state'] == 'scheduled'
    assert len(state['subscription_posts']) == 2
    assert len(periods()) == 2


def test_stripe_fractional_gift_end_uses_a_confirmable_integer_billing_second(stripe_renewal):
    state = stripe_renewal
    state['clock'] = state['paid_end'] + timedelta(seconds=1, microseconds=456789)
    gift(state)
    confirmed = sync(state)
    assert confirmed['entitlements']['gift']['state'] == 'active'
    assert confirmed['entitlements']['gift']['days'] == 30
    expected_end = state['clock'] + timedelta(days=30)
    actual_end = stored_subscription().resume_at
    assert actual_end.microsecond == 0
    assert timedelta(0) <= actual_end - expected_end < timedelta(seconds=1)
    assert len(state['subscription_posts']) == 1
    assert stored_subscription().renewal_error is None


def test_stripe_late_pause_confirmation_reconfirms_full_gift_duration(stripe_renewal):
    state = stripe_renewal
    state['subscription_update_loss'] = 'after'
    gift(state)
    assert rights(state)['gift']['state'] == 'pending'
    old_remote_end = state['sub']['trial_end']
    state['clock'] = state['paid_end'] + timedelta(days=2, microseconds=456789)
    confirmed = sync(state)
    assert confirmed['entitlements']['gift']['state'] == 'active'
    assert confirmed['entitlements']['gift']['days'] == 30
    assert stored_subscription().resume_at > datetime.fromtimestamp(old_remote_end, timezone.utc).replace(tzinfo=None)
    assert state['sub']['trial_end'] == int(stored_subscription().resume_at.replace(tzinfo=timezone.utc).timestamp())
    assert len(state['subscription_posts']) == 2
    assert state['subscription_posts'][0][0] != state['subscription_posts'][1][0]
    assert len(periods()) == 1
