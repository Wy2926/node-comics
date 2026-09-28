"""Account-lock renewal races in the dedicated isolated PostgreSQL database."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event, local

from fastapi.testclient import TestClient
import pytest

from test_postgres_concurrency import pg_scope, pytestmark
from test_creem_billing import creem_billing
from test_billing_renewal import renewal, paid, gift, stored_subscription, sync
from test_stripe_billing import billing
from test_stripe_renewal import stripe_renewal


@pytest.fixture
def client(pg_scope):
    from app.main import app
    with TestClient(app) as value:
        yield value


def ready_to_resume(state):
    paid(state)
    gift(state)
    state['clock'] = state['paid_end']
    sync(state)
    state['clock'] += timedelta(days=30)
    return stored_subscription().id


def test_concurrent_resume_workers_dispatch_only_once(renewal):
    from app.billing_renewal import process_renewal
    state = renewal
    subscription_id = ready_to_resume(state)
    ready = Barrier(2)

    def resume():
        ready.wait(timeout=10)
        process_renewal(subscription_id)

    with ThreadPoolExecutor(max_workers=2) as pool:
        workers = [pool.submit(resume) for _ in range(2)]
        for worker in workers:
            worker.result(timeout=15)
    assert [action for action, _ in state['renewal_posts']].count('resume') == 1
    assert stored_subscription().gift_deferred is False
    assert stored_subscription().renewal_action is None


def test_completed_cancel_blocks_previously_claimed_resume(renewal, monkeypatch):
    from app import entitlements
    from app.billing_renewal import cancel_renewal, process_renewal
    state = renewal
    subscription_id = ready_to_resume(state)
    before_dispatch, release_resume = Event(), Event()
    role = local()
    actual_lock = entitlements.locked_user

    def controlled_lock(db, owner_id):
        if getattr(role, 'resume', False):
            role.locks += 1
            if role.locks == 2:
                # process_renewal committed its dispatch marker, but has not yet
                # acquired the second account lock used for the external write.
                before_dispatch.set()
                assert release_resume.wait(10)
        return actual_lock(db, owner_id)

    def resume():
        role.resume, role.locks = True, 0
        process_renewal(subscription_id)

    monkeypatch.setattr(entitlements, 'locked_user', controlled_lock)
    with ThreadPoolExecutor(max_workers=1) as pool:
        worker = pool.submit(resume)
        try:
            assert before_dispatch.wait(10)
            cancel_renewal(state['owner'], 'creem')
            assert stored_subscription().auto_renew is False
            assert state['subscriptions']['sub_fixture']['status'] == 'canceled'
        finally:
            release_resume.set()
        worker.result(timeout=15)
    assert [action for action, _ in state['renewal_posts']].count('resume') == 0
    assert state['renewal_posts'] == [
        ('cancel', {'mode': 'scheduled', 'onExecute': 'pause'}),
        ('cancel', {'mode': 'immediate', 'onExecute': 'cancel'})]
    assert stored_subscription().renewal_action is None


def test_pause_claim_rechecks_arrears_before_dispatch_and_recovers(renewal, monkeypatch):
    from sqlalchemy import select
    from app import billing_renewal, entitlements
    from app.billing_models import BillingOrderTransition
    from app.creem_billing_sync import sync_subscription
    from app.db import session_factory
    state = renewal
    paid(state)
    # Keep the durable operation queued so the competing sync can intervene
    # between the worker's claim and its actual external write.
    with monkeypatch.context() as pending:
        pending.setattr(billing_renewal, 'process_owner', lambda owner_id: None)
        gift(state)
    subscription_id = stored_subscription().id
    before_dispatch, release_pause = Event(), Event()
    role = local()
    actual_lock = entitlements.locked_user

    def controlled_lock(db, owner_id):
        if getattr(role, 'pause', False):
            role.locks += 1
            if role.locks == 2:
                before_dispatch.set()
                assert release_pause.wait(10)
        return actual_lock(db, owner_id)

    def pause():
        role.pause, role.locks = True, 0
        billing_renewal.process_renewal(subscription_id)

    monkeypatch.setattr(entitlements, 'locked_user', controlled_lock)
    with ThreadPoolExecutor(max_workers=1) as pool:
        worker = pool.submit(pause)
        try:
            assert before_dispatch.wait(10)
            state['subscriptions']['sub_fixture']['status'] = 'past_due'
            sync_subscription('sub_fixture')
            assert stored_subscription().status == 'past_due'
        finally:
            release_pause.set()
        worker.result(timeout=15)

    assert state['renewal_posts'] == []
    sub = stored_subscription()
    assert sub.renewal_action == 'pause'
    assert sub.renewal_action_at is None
    assert sub.renewal_error is None
    assert sync(state)['entitlements']['gift']['state'] == 'pending'
    with session_factory()() as db:
        not_sent = [row for row in db.scalars(select(BillingOrderTransition))
                    if row.source == 'renewal' and row.detail.get('state') == 'not_sent']
        assert len(not_sent) == 1
        assert not_sent[0].detail['action'] == 'pause'

    state['subscriptions']['sub_fixture']['status'] = 'active'
    recovered = sync(state)
    assert state['renewal_posts'] == [('cancel', {'mode': 'scheduled', 'onExecute': 'pause'})]
    assert recovered['entitlements']['gift']['state'] == 'scheduled'
    assert stored_subscription().renewal_action is None


def test_stripe_sync_refreshes_gift_state_after_waiting_for_account_lock(stripe_renewal, monkeypatch):
    from app import billing_renewal, stripe_billing_sync
    state = stripe_renewal
    with monkeypatch.context() as pending:
        pending.setattr(billing_renewal, 'process_owner', lambda owner_id: None)
        gift(state)
    subscription_id = stored_subscription().id
    before_lock, release_sync = Event(), Event()
    role = local()
    actual_lock = stripe_billing_sync.locked_user

    def controlled_lock(db, owner_id):
        if getattr(role, 'stale_sync', False):
            # sync_subscription has loaded known before resolving its account
            # lock. Let another worker finish the pending promotion first.
            before_lock.set()
            assert release_sync.wait(10)
        return actual_lock(db, owner_id)

    def stale_sync():
        role.stale_sync = True
        stripe_billing_sync.sync_subscription('sub_fixture')

    monkeypatch.setattr(stripe_billing_sync, 'locked_user', controlled_lock)
    with ThreadPoolExecutor(max_workers=1) as pool:
        worker = pool.submit(stale_sync)
        try:
            assert before_lock.wait(10)
            billing_renewal.process_renewal(subscription_id)
            assert stored_subscription().gift_deferred is True
            assert stored_subscription().auto_renew is True
        finally:
            release_sync.set()
        worker.result(timeout=15)

    sub = stored_subscription()
    assert sub.auto_renew is True
    assert sub.gift_deferred is True
    assert sub.renewal_action is None
    assert sub.renewal_action_at is None
    assert sub.renewal_error is None
    assert len(state['subscription_posts']) == 1
    assert sync(state)['entitlements']['gift']['state'] == 'scheduled'
