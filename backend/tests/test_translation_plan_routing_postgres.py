"""Opt-in plan routing and migration against a dedicated PostgreSQL test schema."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import func, select

from app.db import engine, session_factory
from app.models import Job
from conftest import login, login_plus
from test_cluster_submissions import descriptor, submit
from test_postgres_concurrency import pg_scope, pytestmark  # noqa: F401
from test_translation_providers import PATH, admin_case, test_decimal_prices_round_trip_and_pin_existing_revision  # noqa: F401
from test_translation_plan_routing import (
    supplier,
    test_admin_plan_validation_and_omitted_update_preserves_restrictions,
    test_plan_pools_keep_stable_weights_and_read_candidates_once,
    test_stopped_plan_pool_cannot_fall_back_to_another_plan,
    test_missing_plan_fails_before_quota_and_capabilities_match_user,
    test_membership_changes_separate_new_models_but_replay_and_reuse_do_not_rebill,
    test_completed_same_model_result_reuses_across_plan_change_without_new_admission,
    test_explicit_retry_is_a_new_admission_using_current_plan,
)
from test_translation_plan_routing_migration import test_existing_providers_remain_unrestricted


@pytest.fixture
def isolated_migration_database(pg_scope):
    return engine()


@pytest.fixture
def client(pg_scope):
    from app.main import app
    from app.migrate import migrate
    migrate()
    with TestClient(app, headers={'X-Translation-Protocol': 'overlay-v1'}) as value:
        yield value


def test_scope_edit_serializes_with_new_admission(admin_case):
    client, admin = admin_case
    provider = supplier(admin_case, ['free'])
    reader = login(client)
    premium = login_plus(client, 'premium')
    ready = Barrier(2)
    def edit():
        ready.wait(timeout=10)
        return client.put(PATH + '/' + provider['id'], headers=admin, json={
            **{key: provider[key] for key in ('name', 'channel', 'enabled', 'text_weight', 'title_weight', 'config')},
            'text_plan_ids': ['plus']})
    def accept():
        ready.wait(timeout=10)
        return submit(client, reader, descriptor(b'racing'), key='racing')
    with ThreadPoolExecutor(max_workers=2) as pool:
        edited, accepted = pool.submit(edit), pool.submit(accept)
        assert edited.result().status_code == 200
        status = accepted.result().status_code
        assert status in (202, 503)
    assert submit(client, reader, descriptor(b'after'), key='after').status_code == 503
    assert submit(client, premium, descriptor(b'after'), key='premium').status_code == 202
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == (2 if status == 202 else 1)
        jobs = db.scalars(select(Job)).all()
        assert all(job.config['text']['provider_id'] == provider['id'] for job in jobs)
        assert {job.entitlement['plan'] for job in jobs} == ({'free', 'plus'} if status == 202 else {'plus'})


def test_idle_worker_query_does_not_compare_json_plan_scopes(admin_case):
    from app.scheduler import next_control_delay
    supplier(admin_case, ['free'])
    supplier(admin_case, ['plus'])
    with session_factory()() as db:
        # PostgreSQL rejects DISTINCT over JSON even when the queue is empty.
        assert next_control_delay(db) == 5
