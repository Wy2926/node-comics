"""Opt-in Creem first-sync and replay races in isolated PostgreSQL schemas."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_postgres_concurrency import pg_scope, pytestmark
from test_creem_billing import creem_billing, complete, transaction, periods
from test_billing_admin import administrator, test_early_subscription_notification_is_visible_before_subscription_binding


@pytest.fixture
def client(pg_scope):
    from app.main import app
    with TestClient(app) as value:
        yield value


@pytest.mark.parametrize('trial,interval', [(True, 'month'), (False, 'month'), (False, 'year')])
def test_concurrent_first_sync_and_replay_grant_once(creem_billing, monkeypatch, trial, interval):
    from app import creem_billing_sync
    from app.billing_models import BillingInvoice, BillingOrder, BillingOrderTransition, BillingSubscription, BillingTerm
    from app.db import session_factory
    state = creem_billing
    state['price_id'] = 'creem-' + interval
    complete(state, trial=trial, synchronize=False)
    if not trial:
        transaction(state)
    real_lock = creem_billing_sync.locked_user
    before_lock = Barrier(2)

    def synchronized_lock(db, owner_id):
        # Both workers must finish the pre-lock lookup before either creates the
        # first subscription. This reproduces the stale-known-row race reliably.
        before_lock.wait(timeout=10)
        return real_lock(db, owner_id)

    monkeypatch.setattr(creem_billing_sync, 'locked_user', synchronized_lock)
    for _ in range(2):
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: creem_billing_sync.sync_subscription('sub_fixture'), range(2)))
    buckets = periods()
    assert len(buckets) == (12 if interval == 'year' else 1)
    assert all(item.granted == (30 if trial else 300) for item in buckets)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingSubscription)) == 1
        assert db.scalar(select(func.count()).select_from(BillingTerm)) == 1
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 1
        assert db.scalar(select(func.count()).select_from(BillingOrder)) == 1
        assert db.scalar(select(func.count()).select_from(BillingOrderTransition).where(
            BillingOrderTransition.detail['subscription_to'].as_string() == ('trialing' if trial else 'active'))) == 1
