"""Run campaign invariants against real PostgreSQL, including competing workers."""
import pytest
from fastapi.testclient import TestClient
from test_postgres_concurrency import pg_scope, pytestmark
from test_quota_campaign_duration import (
    test_duration_preserves_used_reserved_receipts_and_late_settlement,
    test_duration_future_only_and_explicit_existing_scope,
    test_duration_permissions_validation_and_not_found,
    test_duration_end_stops_registration_without_expiring_existing_gifts,
    test_duration_audit_failure_rolls_back_every_changed_grant,
    test_status_recovery_requires_the_same_actor_and_original_receipt,
)
from test_quota_campaigns import (
    verify_quota_upgrade,
    test_backfill_existing_and_registration_share_once_only_receipts,
    test_configuration_is_private_immutable_and_explicitly_enabled,
    test_audience_boundary_pause_resume_and_no_regrant,
    test_delivery_windows_expiry_and_registration_recovery,
    test_rollback_does_not_leave_receipt_or_partial_registration,
    test_independent_campaigns_and_users_preserve_quota_settlement,
    test_permanent_free_grant_has_nullable_expiry_contract,
    test_concurrent_delivery_is_exactly_once,
    test_oidc_concurrent_first_requests_get_one_user_and_award,
)


def test_upgrade_keeps_referenced_quota_and_ledger(pg_scope):
    from app.db import engine
    verify_quota_upgrade(engine())


@pytest.fixture
def client(pg_scope):
    from app.main import app
    from app.db import session_factory
    from translation_fixtures import configure_text_provider
    from app.migrate import migrate
    migrate()
    with TestClient(app) as value:
        with session_factory()() as db:
            configure_text_provider(db)
            db.commit()
        yield value


def test_pause_waits_for_delivery_and_stops_next_award(client):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from sqlalchemy import select
    from conftest import login
    from test_quota_campaigns import campaign, grants
    from app.db import session_factory
    from app.models import User
    from app.quota_campaigns import award_campaigns, backfill_campaigns
    operator, row = campaign(client, enable=False)
    owner_auth = login(client)
    _, row = campaign(client)
    entered = Event()
    def pause():
        entered.set()
        return client.patch('/v1/admin/quota-campaigns/welcome', headers=operator,
            json={'enabled': False, 'expected_version': row['version']})
    with ThreadPoolExecutor(1) as pool:
        with session_factory()() as db:
            user = db.scalar(select(User).where(User.subject == 'dev:alice'))
            assert award_campaigns(db, user) == 1
            pending = pool.submit(pause)
            assert entered.wait(timeout=5)
            # PostgreSQL must hold the shared campaign lock until award commit.
            import time
            time.sleep(.1)
            assert not pending.done()
            db.commit()
        assert pending.result(timeout=10).status_code == 200
    assert len(grants(client, owner_auth)) == 1
    assert backfill_campaigns() == 0
    assert not grants(client, login(client, 'after-pause'))


def test_duration_waits_for_delivery_and_corrects_the_just_committed_award(client):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from datetime import timedelta
    from sqlalchemy import select
    from conftest import login
    from test_quota_campaigns import campaign, grants
    from test_quota_campaign_duration import duration
    from app.db import session_factory
    from app.models import User
    from app.quota_campaigns import award_campaigns
    from app.entitlement_models import QuotaPeriod
    operator, _ = campaign(client, enable=False)
    auth = login(client)
    _, row = campaign(client)
    entered = Event()
    def edit():
        entered.set()
        return duration(client, operator, row['version'])[0]
    with ThreadPoolExecutor(1) as pool:
        with session_factory()() as db:
            user = db.scalar(select(User).where(User.subject == 'dev:alice'))
            assert award_campaigns(db, user) == 1
            pending = pool.submit(edit)
            assert entered.wait(timeout=5)
            import time
            time.sleep(.1)
            assert not pending.done()
            db.commit()
        assert pending.result(timeout=10).status_code == 200
    gift, = grants(client, auth)
    with session_factory()() as db:
        period = db.get(QuotaPeriod, gift['id'])
        assert period.ends_at == period.starts_at + timedelta(days=7)


def test_competing_duration_changes_cannot_overwrite_each_other(client):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from test_quota_campaigns import campaign
    from test_quota_campaign_duration import duration
    operator, row = campaign(client)
    ready = Barrier(2)
    def edit(days):
        ready.wait(timeout=10)
        return duration(client, operator, row['version'], days=days)[0]
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(edit, [7, 14]))
    assert sorted(r.status_code for r in responses) == [200, 409]
    saved = client.get('/v1/admin/quota-campaigns', headers=operator).json()['items'][0]
    assert saved['version'] == row['version'] + 1
    assert saved['validity_days'] == next(r.json()['validity_days'] for r in responses if r.status_code == 200)
