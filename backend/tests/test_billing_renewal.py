"""Gift renewal transitions against isolated Creem-shaped HTTP responses."""
import copy
from datetime import timedelta
from urllib.parse import urlsplit

import httpx
import pytest
from sqlalchemy import select
from conftest import login
from test_creem_billing import creem_billing, complete, iso, periods, rights, transaction


@pytest.fixture
def renewal(creem_billing, monkeypatch):
    state = creem_billing
    state.update(clock=state['at'] + timedelta(seconds=1), renewal_posts=[], scheduled=None,
                 lose_after_apply=False, lose_before_apply=False)
    from app import billing_checkout, billing_orders, billing_renewal, creem_billing_sync, entitlements
    for module in (billing_checkout, billing_orders, billing_renewal, creem_billing_sync, entitlements):
        monkeypatch.setattr(module, 'now', lambda: state['clock'])
    original = httpx.request

    def transport(method, url, *, params=None, json=None, **kwargs):
        path = urlsplit(url).path
        remote = state['subscriptions'].get('sub_fixture')
        if remote and state['scheduled'] == 'pause' and state['clock'] >= state['paid_end']:
            remote.update(status='paused', next_transaction_date=None)
            state['scheduled'] = None
        if method != 'POST' or not path.startswith('/v1/subscriptions/sub_fixture/'):
            return original(method, url, params=params, json=json, **kwargs)
        action, body = path.rsplit('/', 1)[1], json or {}
        state['renewal_posts'].append((action, copy.deepcopy(body)))
        if state['lose_before_apply']:
            state['lose_before_apply'] = False
            raise httpx.ReadTimeout('isolated write result unknown')
        if action == 'cancel' and body == {'mode': 'scheduled', 'onExecute': 'pause'}:
            # Creem does not identify the scheduled action in the returned object.
            remote.update(status='scheduled_cancel', canceled_at=None)
            state['scheduled'] = 'pause'
        elif action == 'cancel' and body == {'mode': 'immediate', 'onExecute': 'cancel'}:
            remote.update(status='canceled', canceled_at=iso(state['clock']), next_transaction_date=None)
            state['scheduled'] = None
        elif action == 'resume' and not body:
            assert remote['status'] == 'paused'
            end = entitlements.month_boundary(state['clock'], 12 if state['price_id'].endswith('year') else 1, 'UTC')
            remote.update(status='active', current_period_start_date=iso(state['clock']),
                          current_period_end_date=iso(end), next_transaction_date=iso(end))
            # A successful resume response alone is not a settled transaction.
        else:
            raise AssertionError((action, body))
        if state['lose_after_apply']:
            state['lose_after_apply'] = False
            raise httpx.ReadTimeout('isolated successful write response lost')
        return httpx.Response(200, json=copy.deepcopy(remote), request=httpx.Request(method, url))

    monkeypatch.setattr(httpx, 'request', transport)
    return state


def paid(state, interval='month'):
    from app.creem_billing_sync import sync_subscription
    state['price_id'] = 'creem-' + interval
    complete(state, trial=False)
    transaction(state)
    sync_subscription('sub_fixture')
    state['paid_end'] = max(period.ends_at for period in periods())


def gift(state, days=30, key='activity-reward'):
    response = state['client'].post(f"/v1/admin/users/{state['owner']}/membership",
        headers={**login(state['client'], 'admin'), 'Idempotency-Key': key},
        json={'days': days, 'monthly_pages': 300, 'note': 'isolated activity reward'})
    assert response.status_code == 200, response.text
    return response.json()['entitlements']


def sync(state):
    response = state['client'].post('/v1/billing/sync', headers=state['auth'])
    assert response.status_code == 200, response.text
    return response.json()


def stored_subscription():
    from app.billing_models import BillingSubscription
    from app.db import session_factory
    with session_factory()() as db:
        return db.scalar(select(BillingSubscription))


@pytest.mark.parametrize('interval,days', [('month', 30), ('month', 60), ('year', 30)])
def test_creem_paid_then_gift_then_resume_requires_a_new_paid_receipt(renewal, interval, days):
    state = renewal
    paid(state, interval)
    original_periods = [(row.id, row.starts_at, row.ends_at) for row in periods()]
    issued = gift(state, days)
    assert issued['gift']['state'] == 'pending'
    assert issued['gift']['starts_at'] == iso(state['paid_end'])
    assert issued['plus_expires_at'] == iso(state['paid_end'])
    confirmed = sync(state)
    assert state['renewal_posts'] == [('cancel', {'mode': 'scheduled', 'onExecute': 'pause'})]
    assert confirmed['entitlements']['gift']['state'] == 'scheduled'
    assert confirmed['billing']['subscription']['auto_renew'] is True
    assert confirmed['entitlements']['plus_expires_at'] == iso(state['paid_end'] + timedelta(days=days))
    assert [(row.id, row.starts_at, row.ends_at) for row in periods()] == original_periods
    state['clock'] = state['paid_end']
    active = sync(state)
    assert active['entitlements']['gift']['state'] == 'active'
    assert active['entitlements']['modes']['classic']['quota']['granted'] == 300
    assert len(state['renewal_posts']) == 1
    if days == 60:
        state['clock'] += timedelta(days=30)
        assert rights(state)['modes']['classic']['quota']['granted'] == 300
    state['clock'] = state['paid_end'] + timedelta(days=days)
    resumed = sync(state)
    assert state['renewal_posts'][-1] == ('resume', {})
    assert resumed['entitlements']['plan'] == 'free'
    assert [(row.id, row.starts_at, row.ends_at) for row in periods()] == original_periods
    from app.creem_billing_sync import sync_subscription
    transaction(state, index=2, start=state['clock'])
    sync_subscription('sub_fixture')
    assert rights(state)['plan'] == 'plus'
    assert len(periods()) == len(original_periods) * 2


@pytest.mark.parametrize('cancel_at', ['scheduled', 'active'])
def test_creem_user_cancellation_preserves_gift_and_never_resumes(renewal, cancel_at):
    state = renewal
    paid(state)
    gift(state)
    sync(state)
    if cancel_at == 'active':
        state['clock'] = state['paid_end']
        sync(state)
    response = state['client'].post('/v1/billing/cancel-renewal', headers=state['auth'], json={'provider': 'creem'})
    assert response.status_code == 200, response.text
    assert response.json()['subscription']['auto_renew'] is False
    assert state['renewal_posts'][-1] == ('cancel', {'mode': 'immediate', 'onExecute': 'cancel'})
    state['clock'] = state['paid_end'] + timedelta(days=1)
    assert sync(state)['entitlements']['gift']['state'] == 'active'
    state['clock'] = state['paid_end'] + timedelta(days=30)
    assert sync(state)['entitlements']['plan'] == 'free'
    assert not any(action == 'resume' for action, _ in state['renewal_posts'])


@pytest.mark.parametrize('applied', [False, True])
def test_creem_unknown_pause_is_read_back_without_resending(renewal, applied):
    from app.billing_renewal import process_renewal
    state = renewal
    paid(state)
    state['lose_after_apply' if applied else 'lose_before_apply'] = True
    gift(state)
    assert len(state['renewal_posts']) == 1
    assert stored_subscription().renewal_error == 'BILLING_RENEWAL_UNCERTAIN'
    first_read_count = len(state['requests'])
    for _ in range(2):
        process_renewal(stored_subscription().id)
    assert len(state['renewal_posts']) == 1 and len(state['requests']) > first_read_count
    assert rights(state)['gift']['state'] == ('scheduled' if applied else 'pending')
    if not applied:
        state['clock'] = state['paid_end'] + timedelta(days=45)
        assert rights(state)['gift']['state'] == 'pending'
        assert rights(state)['plan'] == 'free'


def test_creem_cancel_replaces_unconfirmed_pause_without_restarting_billing(renewal):
    state = renewal
    paid(state)
    state['lose_after_apply'] = True
    gift(state)
    assert stored_subscription().renewal_error == 'BILLING_RENEWAL_UNCERTAIN'
    state['clock'] = state['paid_end']
    response = state['client'].post('/v1/billing/cancel-renewal', headers=state['auth'], json={'provider': 'creem'})
    assert response.status_code == 200, response.text
    assert response.json()['subscription']['auto_renew'] is False
    assert state['subscriptions']['sub_fixture']['status'] == 'canceled'
    assert state['renewal_posts'][-1] == ('cancel', {'mode': 'immediate', 'onExecute': 'cancel'})
    assert rights(state)['gift']['state'] == 'active'


def test_creem_repeated_gift_extends_only_resume_date_and_preserves_reserved_quota(renewal):
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    state = renewal
    paid(state)
    gift(state)
    sync(state)
    state['clock'] = state['paid_end'] + timedelta(days=1)
    active = sync(state)['entitlements']['modes']['classic']['quota']
    with session_factory()() as db:
        period = db.get(QuotaPeriod, active['id'])
        period.used, period.reserved = 3, 2
        db.commit()
    extended = gift(state, 30, 'second-activity-reward')
    assert extended['gift']['days'] == 60
    assert extended['modes']['classic']['quota']['id'] == active['id']
    assert extended['modes']['classic']['quota']['used'] == 3
    assert extended['modes']['classic']['quota']['reserved'] == 2
    assert stored_subscription().resume_at == state['paid_end'] + timedelta(days=60)
    state['clock'] = state['paid_end'] + timedelta(days=30)
    sync(state)
    assert len(state['renewal_posts']) == 1
    assert rights(state)['modes']['classic']['quota']['available'] == 300


def test_gift_blocks_new_checkout_until_its_expiry(renewal):
    state = renewal
    gift(state)
    response = state['client'].post('/v1/billing/checkouts', headers=state['auth'],
        json={'provider': 'creem', 'price_id': state['price_id']})
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'BILLING_GIFT_ACTIVE'
    assert not state['posts']


@pytest.mark.parametrize('applied', [False, True])
def test_creem_unknown_resume_is_never_resent_and_can_be_canceled(renewal, applied):
    state = renewal
    paid(state)
    gift(state)
    state['clock'] = state['paid_end'] + timedelta(days=30)
    state['lose_after_apply' if applied else 'lose_before_apply'] = True
    first = sync(state)
    assert first['billing']['subscription']['renewal_state'] == 'attention'
    assert first['entitlements']['plan'] == 'free'
    for _ in range(2):
        sync(state)
    assert [action for action, _ in state['renewal_posts']].count('resume') == 1
    assert rights(state)['plan'] == 'free'
    response = state['client'].post('/v1/billing/cancel-renewal', headers=state['auth'], json={'provider': 'creem'})
    assert response.status_code == 200, response.text
    assert response.json()['subscription']['auto_renew'] is False
    assert state['subscriptions']['sub_fixture']['status'] == 'canceled'
    assert [action for action, _ in state['renewal_posts']].count('resume') == 1


def test_cancel_renewal_cannot_target_another_account(renewal):
    state = renewal
    paid(state)
    other = login(state['client'], 'other-renewal-user')
    response = state['client'].post('/v1/billing/cancel-renewal', headers=other, json={'provider': 'creem'})
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'SUBSCRIPTION_NOT_FOUND'
    assert stored_subscription().auto_renew is True
    assert not state['renewal_posts']


@pytest.mark.parametrize('confirmed', [False, True])
def test_external_pause_before_paid_end_never_authorizes_automatic_resume(renewal, confirmed):
    state = renewal
    paid(state)
    state['lose_after_apply'] = not confirmed
    gift(state)
    state['scheduled'] = None
    state['subscriptions']['sub_fixture'].update(status='paused', next_transaction_date=None)
    assert state['clock'] < state['paid_end']
    paused = sync(state)
    assert paused['billing']['subscription']['auto_renew'] is False
    assert paused['entitlements']['gift']['state'] == 'scheduled'
    state['clock'] = state['paid_end'] + timedelta(days=30)
    sync(state)
    assert not any(action == 'resume' for action, _ in state['renewal_posts'])


def test_unconfirmed_cancel_rejects_gift_and_rolls_back_membership(renewal):
    from app.db import session_factory
    from app.entitlement_models import MembershipOperation, QuotaPeriod
    from app.models import User
    state = renewal
    paid(state)
    state['lose_before_apply'] = True
    canceled = state['client'].post('/v1/billing/cancel-renewal', headers=state['auth'], json={'provider': 'creem'})
    assert canceled.status_code == 200, canceled.text
    assert canceled.json()['subscription']['auto_renew'] is False
    assert stored_subscription().renewal_action == 'cancel'
    assert stored_subscription().renewal_error == 'BILLING_RENEWAL_UNCERTAIN'
    assert state['subscriptions']['sub_fixture']['status'] == 'active'
    response = state['client'].post(f"/v1/admin/users/{state['owner']}/membership",
        headers={**login(state['client'], 'admin'), 'Idempotency-Key': 'gift-during-unknown-cancel'},
        json={'days': 30, 'note': 'must wait for remote cancellation'})
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'BILLING_RENEWAL_PENDING'
    with session_factory()() as db:
        user = db.get(User, state['owner'])
        assert user.membership_id is user.plus_started_at is user.plus_expires_at is None
        assert user.plus_pending is False
        assert db.scalar(select(MembershipOperation.id).where(MembershipOperation.owner_id == user.id)) is None
        assert db.scalar(select(QuotaPeriod.id).where(QuotaPeriod.owner_id == user.id,
            QuotaPeriod.source == 'membership')) is None
    assert len(state['renewal_posts']) == 1


def test_creem_initial_trial_then_gift_does_not_repeat_trial_or_pregrant_payment(renewal):
    from app.billing_models import BillingAccount, BillingTerm
    from app.db import session_factory
    state = renewal
    complete(state, trial=True)
    state['paid_end'] = max(period.ends_at for period in periods())
    assert state['paid_end'] == state['at'] + timedelta(days=7)
    assert rights(state)['modes']['classic']['quota']['granted'] == 30
    with session_factory()() as db:
        trial_used_at = db.get(BillingAccount, state['owner']).trial_used_at
    issued = gift(state, 30)
    assert issued['gift']['state'] == 'pending'
    assert issued['gift']['starts_at'] == iso(state['paid_end'])
    assert sync(state)['entitlements']['gift']['state'] == 'scheduled'
    assert state['renewal_posts'] == [('cancel', {'mode': 'scheduled', 'onExecute': 'pause'})]
    state['clock'] = state['paid_end']
    active = sync(state)
    assert active['entitlements']['gift']['state'] == 'active'
    assert active['entitlements']['modes']['classic']['quota']['granted'] == 300
    state['clock'] += timedelta(days=30)
    for _ in range(2):
        finished = sync(state)
        assert finished['entitlements']['plan'] == 'free'
        assert finished['billing']['trial_eligible'] is False
    assert state['renewal_posts'][-1] == ('resume', {})
    assert len(state['renewal_posts']) == 2
    assert [period.granted for period in periods()] == [30]
    with session_factory()() as db:
        assert db.get(BillingAccount, state['owner']).trial_used_at == trial_used_at
        assert list(db.scalars(select(BillingTerm.kind).where(BillingTerm.owner_id == state['owner']))) == ['trial']


def test_known_subscription_arrears_reject_gift_without_membership_changes(renewal):
    from app.creem_billing_sync import sync_subscription
    from app.db import session_factory
    from app.entitlement_models import MembershipOperation, QuotaPeriod
    from app.models import User
    state = renewal
    paid(state)
    state['subscriptions']['sub_fixture']['status'] = 'past_due'
    sync_subscription('sub_fixture')
    response = state['client'].post(f"/v1/admin/users/{state['owner']}/membership",
        headers={**login(state['client'], 'admin'), 'Idempotency-Key': 'gift-with-arrears'},
        json={'days': 30, 'note': 'unpaid subscription must be resolved first'})
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'BILLING_RENEWAL_PENDING'
    with session_factory()() as db:
        user = db.get(User, state['owner'])
        assert user.membership_id is user.plus_started_at is user.plus_expires_at is None
        assert user.plus_pending is False
        assert db.scalar(select(MembershipOperation.id).where(MembershipOperation.owner_id == user.id)) is None
        assert db.scalar(select(QuotaPeriod.id).where(QuotaPeriod.owner_id == user.id,
            QuotaPeriod.source == 'membership')) is None
    assert stored_subscription().renewal_action is None
    assert stored_subscription().gift_membership_id is None
    assert not state['renewal_posts']


def test_fresh_arrears_observation_keeps_gift_pending_until_subscription_recovers(renewal):
    state = renewal
    paid(state)
    assert stored_subscription().status == 'active'
    state['subscriptions']['sub_fixture']['status'] = 'past_due'
    assert gift(state)['gift']['state'] == 'pending'
    waiting = sync(state)
    assert waiting['entitlements']['gift']['state'] == 'pending'
    assert stored_subscription().status == 'past_due'
    assert stored_subscription().renewal_action == 'pause'
    assert stored_subscription().renewal_action_at is None
    assert not state['renewal_posts']
    state['subscriptions']['sub_fixture']['status'] = 'active'
    recovered = sync(state)
    assert recovered['entitlements']['gift']['state'] == 'scheduled'
    assert stored_subscription().gift_deferred is True
    assert stored_subscription().renewal_action is None
    assert state['renewal_posts'] == [('cancel', {'mode': 'scheduled', 'onExecute': 'pause'})]


def test_gift_waits_for_remote_period_end_without_pregranting_a_late_payment(renewal):
    state = renewal
    paid(state)
    old_end = state['paid_end']
    new_end = old_end + timedelta(days=30)
    state['clock'] = old_end + timedelta(seconds=1)
    state['subscriptions']['sub_fixture'].update(status='active',
        current_period_start_date=iso(old_end), current_period_end_date=iso(new_end),
        next_transaction_date=iso(new_end))
    state['paid_end'] = new_end  # The fixture executes scheduled pause at the remote boundary.
    assert len(periods()) == 1 and periods()[0].ends_at == old_end
    gift(state)
    scheduled = sync(state)
    assert scheduled['entitlements']['gift']['starts_at'] == iso(new_end)
    assert scheduled['entitlements']['gift']['state'] == 'scheduled'
    assert scheduled['entitlements']['plan'] == 'free'
    assert len(periods()) == 1 and stored_subscription().paid_ends_at == old_end
    transaction(state, index=2, start=old_end, end=new_end)
    settled = sync(state)
    assert settled['entitlements']['plan'] == 'plus'
    assert settled['entitlements']['gift']['starts_at'] == iso(new_end)
    assert settled['entitlements']['plus_expires_at'] == iso(new_end + timedelta(days=30))
    assert len(periods()) == 2


def test_old_canceled_subscription_sync_cannot_activate_current_pending_gift(renewal):
    from app.billing_models import BillingCheckout, BillingSubscription
    from app.billing_providers import resource_key
    from app.creem_billing_sync import sync_subscription
    from app.db import session_factory
    state = renewal
    paid(state)
    state['lose_before_apply'] = True
    gift(state)
    current = stored_subscription()
    assert current.renewal_error == 'BILLING_RENEWAL_UNCERTAIN'
    assert rights(state)['gift']['state'] == 'pending'
    old_checkout_id, old_session_id, old_subscription_id = 'older-checkout', 'ch_older', 'sub_older'
    old_metadata = {'app': 'node_comics', 'checkout_intent_id': old_checkout_id}
    state['sessions'][old_session_id] = {**copy.deepcopy(next(iter(state['sessions'].values()))),
        'id': old_session_id, 'metadata': old_metadata, 'subscription': old_subscription_id}
    state['subscriptions'][old_subscription_id] = {**copy.deepcopy(state['subscriptions']['sub_fixture']),
        'id': old_subscription_id, 'metadata': old_metadata, 'status': 'canceled',
        'canceled_at': iso(state['at'] - timedelta(days=1))}
    with session_factory()() as db:
        checkout = db.get(BillingCheckout, current.checkout_id)
        db.add(BillingCheckout(id=old_checkout_id, owner_id=state['owner'], environment='test', provider='creem',
            price_id=current.price_id, binding_id=current.binding_id, return_url=checkout.return_url,
            customer_id=current.customer_id, trial=False, status='completed', session_id=old_session_id,
            expires_at=state['at'] - timedelta(days=30), created_at=state['at'] - timedelta(days=31)))
        db.flush()
        db.add(BillingSubscription(id=resource_key('creem', old_subscription_id), owner_id=state['owner'],
            checkout_id=old_checkout_id, environment='test', provider='creem', customer_id=current.customer_id,
            price_id=current.price_id, binding_id=current.binding_id, status='canceled', auto_renew=False))
        db.commit()
    # A delayed historical webhook and an operator reconciliation share this path.
    sync_subscription(old_subscription_id)
    assert rights(state)['gift']['state'] == 'pending'
    assert state['subscriptions']['sub_fixture']['status'] == 'active'
    with session_factory()() as db:
        subscription = db.get(BillingSubscription, current.id)
        assert subscription.gift_deferred is False and subscription.renewal_action == 'pause'
        assert subscription.renewal_error == 'BILLING_RENEWAL_UNCERTAIN'
    assert len(state['renewal_posts']) == 1
