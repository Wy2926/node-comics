"""Opt-in real PostgreSQL races, with a separate database/schema and no paid calls.

From the repository root (the database is deliberately not the product database):
  docker exec node-comics-postgres-1 createdb -U nodecomics nodecomics_concurrency_test
  docker run --rm --network node-comics_default --env-file deploy/.env.local \
    -e RUN_POSTGRES_CONCURRENCY=1 -e TEST_PG_HOST=postgres \
    --mount type=bind,source=<absolute backend path>,target=/app,readonly \
    node-comics-backend:local python -m pytest tests/test_postgres_concurrency.py \
    -v -p no:cacheprovider --tb=short

The create-database command is needed only once. Every test creates and drops its
own random schema in nodecomics_concurrency_test; image storage is under pytest's
temporary directory, never the product volume. The fixture replaces provider
credentials, endpoint and adapter. No real model call occurs.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import BytesIO
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import URL, create_engine, event, func, select, text
from conftest import run_job
from translation_fixtures import configure_text_provider

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_POSTGRES_CONCURRENCY") != "1",
    reason="Opt in with RUN_POSTGRES_CONCURRENCY=1 and a separate PostgreSQL test database",
)
TEST_DATABASE = "nodecomics_concurrency_test"
MIGRATION_LOCK_ID = 761349210


def wait_until(predicate, *, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.025)
    raise AssertionError("Timed out waiting for the controlled PostgreSQL race")


@pytest.fixture
def pg_scope(tmp_path, monkeypatch):
    """Never use DATABASE_URL from the live application or touch its schema."""
    monkeypatch.setenv("APP_ENV", "test")
    database = os.environ.get("TEST_PG_DATABASE", TEST_DATABASE)
    if database != TEST_DATABASE:
        pytest.fail("Refusing to run outside the dedicated nodecomics_concurrency_test database")
    password = os.environ.get("TEST_PG_PASSWORD") or os.environ.get("POSTGRES_PASSWORD")
    if not password:
        pytest.fail("Set TEST_PG_PASSWORD or inject deploy/.env.local with docker --env-file")
    base_url = URL.create(
        "postgresql+psycopg", username=os.environ.get("TEST_PG_USER", "nodecomics"),
        password=password, host=os.environ.get("TEST_PG_HOST", "postgres"),
        port=int(os.environ.get("TEST_PG_PORT", "5432")), database=database,
    )
    schema = "nc_concurrency_" + uuid4().hex
    assert re.fullmatch(r"nc_concurrency_[a-f0-9]{32}", schema)
    administration = create_engine(base_url, isolation_level="AUTOCOMMIT")
    with administration.connect() as connection:
        assert connection.scalar(text("SELECT current_database()")) == TEST_DATABASE
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    app_name = "nc-test-" + schema
    url = base_url.update_query_dict({
        "options": f"-csearch_path={schema} -clock_timeout=8000 -cstatement_timeout=15000",
        "application_name": app_name,
    })
    monkeypatch.setenv("DATABASE_URL", url.render_as_string(hide_password=False))
    monkeypatch.setenv("STORAGE_PATH", str(tmp_path / "images"))
    monkeypatch.setenv("RESULT_STORAGE_BACKEND", "local")
    monkeypatch.setenv("R2_ENDPOINT_URL", "")
    monkeypatch.setenv("DEV_AUTH", "true")
    monkeypatch.setenv("DEV_AUTH_SECRET", "isolated-postgres-test-auth-key-not-used-for-product")
    monkeypatch.setenv("OPENAI_API_KEY", "postgres-test-placeholder-no-paid-access")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://provider.invalid/v1")
    monkeypatch.setenv("OPENAI_MODEL", "contract-image-model")
    monkeypatch.setenv("PROVIDERS_JSON", "")
    monkeypatch.setenv('CLASSIC_ENABLED', 'true')
    monkeypatch.setenv('CLASSIC_ENGINE_TOKEN', 'isolated-pg-engine-token')
    from app.config import settings
    from app.db import engine
    if engine.cache_info().currsize:
        engine().dispose()
    engine.cache_clear()
    settings.cache_clear()
    from app import workers

    def prohibited(*args, **kwargs):
        raise AssertionError("Real provider calls are prohibited in PostgreSQL concurrency tests")

    monkeypatch.setattr(workers, "redraw", prohibited)
    from app import classic
    monkeypatch.setattr(classic, 'call_text', prohibited)
    yield {"schema": schema, "application_name": app_name, "administration": administration}
    engine().dispose()
    engine.cache_clear()
    settings.cache_clear()
    with administration.connect() as connection:
        assert connection.scalar(text("SELECT current_database()")) == TEST_DATABASE
        connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    administration.dispose()


@pytest.fixture
def pg(pg_scope):
    from app.db import initialize, session_factory
    from app.providers import initialize_providers
    from app.assets import create_asset
    from app.models import User, uid, now
    from app.entitlements import month_boundary
    initialize()
    image = BytesIO()
    Image.new("RGB", (320, 480), (231, 225, 248)).save(image, "PNG")
    raw = image.getvalue()
    with session_factory()() as db:
        configure_text_provider(db)
        initialize_providers(db)
        user = User(id=uid(), subject="postgres-test:" + uid(), name="PG isolated test", membership_id=uid(), plus_started_at=now(),
                    plus_expires_at=month_boundary(now(), 12, "Asia/Shanghai"),
                    plus_timezone="Asia/Shanghai", plus_monthly_pages=300)
        db.add(user)
        db.flush()
        asset = create_asset(db, user.id, raw)
        from conftest import control_node
        control_node(db, "redraw")
        control_node(db, "text")
        db.commit()
        return {**pg_scope, "owner_id": user.id, "asset_id": asset.id, "png": raw}


def new_job(pg, key="same-operation"):
    from app.db import session_factory
    from app.jobs import create_job
    from app.models import Asset, User
    with session_factory()() as db:
        job = create_job(db, db.get(User, pg["owner_id"]), db.get(Asset, pg["asset_id"]), "redraw", "zh-Hans", key)
        db.commit()
        return job.id


def assert_single_charge(pg, job_id):
    from app.db import session_factory
    from app.models import Job, Ledger, User
    with session_factory()() as db:
        user, job = db.get(User, pg["owner_id"]), db.get(Job, job_id)
        from app.entitlement_models import QuotaPeriod
        period = db.get(QuotaPeriod, job.quota_period_id)
        assert (period.used, period.reserved) == (1, 0)
        assert job.status == "succeeded" and job.settlement == "settled"
        kinds = db.scalars(select(Ledger.kind).where(Ledger.job_id == job_id)).all()
        assert sorted(kinds) == ["reserve", "settle"]


def test_postgres_concurrent_idempotent_creation_reserves_once(pg):
    from app.db import session_factory
    from app.models import Job, Ledger, User
    from app.queue_models import JobStage
    barrier = threading.Barrier(8)

    def create_concurrently(_):
        barrier.wait(timeout=10)
        return new_job(pg)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(create_concurrently, range(8)))
    assert len(set(results)) == 1
    with session_factory()() as db:
        for table in (Job, Ledger, JobStage):
            assert db.scalar(select(func.count()).select_from(table)) == 1
        user = db.get(User, pg["owner_id"])
        from app.entitlement_models import QuotaPeriod
        period = db.scalar(select(QuotaPeriod).where(QuotaPeriod.owner_id == user.id))
        assert (period.used, period.reserved) == (0, 1)


def test_postgres_concurrent_duplicate_workers_call_and_settle_once(pg, monkeypatch):
    from app import workers
    from app.adapters.images import TranslationOutput
    from app.db import session_factory
    from app.models import Attempt
    job_id = new_job(pg)
    provider_entered, release_provider = threading.Event(), threading.Event()
    calls = []
    calls_lock = threading.Lock()

    def provider(*args):
        with calls_lock:
            calls.append(1)
        provider_entered.set()
        assert release_provider.wait(10)
        return TranslationOutput(pg["png"], request_id="pg-test-once", usage={"total_tokens": 10})

    monkeypatch.setattr(workers, "redraw", provider)
    barrier = threading.Barrier(2)

    def run():
        barrier.wait(timeout=10)
        run_job(job_id)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run) for _ in range(2)]
        try:
            assert provider_entered.wait(10)
            wait_until(lambda: sum(future.done() for future in futures) == 1)
        finally:
            release_provider.set()
        for future in futures:
            future.result(timeout=15)
    assert calls == [1]
    assert_single_charge(pg, job_id)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Attempt)) == 1


def test_postgres_stale_worker_before_intent_cannot_call_after_recovery(pg, monkeypatch):
    from app import workers
    from app.adapters.images import TranslationOutput
    from app.db import session_factory
    from app.dispatcher import recover_lease
    from app.errors import ProcessingError
    from app.models import Attempt, Job, now
    from app.queue_models import ExecutionLease, JobStage
    from conftest import claim_job
    job_id = new_job(pg)
    old_lease = claim_job(job_id)
    with session_factory()() as db:
        old = db.get(ExecutionLease, old_lease)
        old.expires_at = now() - timedelta(seconds=1)
        assert db.get(Attempt, db.get(Job, job_id).attempt_id).call_started_at is None
        db.commit()
    recover_lease(old_lease)
    with session_factory()() as db:
        db.get(JobStage, db.get(ExecutionLease, old_lease).stage_id).available_at = now()
        db.commit()
    new_lease = claim_job(job_id)
    assert new_lease and new_lease != old_lease
    calls, barrier = [], threading.Barrier(2)
    def provider(*args):
        calls.append(1)
        return TranslationOutput(pg["png"], usage={"total_tokens": 7})
    monkeypatch.setattr(workers, "redraw", provider)
    def stale():
        barrier.wait(timeout=10)
        with pytest.raises(ProcessingError, match="LEASE_EXPIRED"):
            workers.run_control_stage(old_lease)
    def fresh():
        barrier.wait(timeout=10)
        workers.run_control_stage(new_lease)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(stale), pool.submit(fresh)]
        for future in futures:
            future.result(timeout=15)
    assert calls == [1]
    assert_single_charge(pg, job_id)
    with session_factory()() as db:
        assert db.get(ExecutionLease, new_lease).generation == 2
        assert db.scalar(select(func.count()).select_from(Attempt)) == 1


def test_postgres_delete_during_finalize_revokes_newly_committed_result(pg, monkeypatch):
    from app import workers
    from app.adapters.images import TranslationOutput
    from app.assets import object_path, owned_asset
    from app.db import engine, session_factory
    from app.jobs import job_json
    from app.main import delete_image
    from app.models import Asset, Job, User
    from fastapi import HTTPException
    job_id = new_job(pg)
    finalizing, resume_finalize, deletion_waiting = [threading.Event() for _ in range(3)]
    real_create_asset = workers.create_asset

    def pause_finalization(*args, **kwargs):
        finalizing.set()
        assert resume_finalize.wait(15)
        return real_create_asset(*args, **kwargs)

    def observe_delete_lock(connection, cursor, statement, parameters, context, executemany):
        if threading.current_thread().name.startswith("delete-original") and "pg_advisory_xact_lock" in statement:
            deletion_waiting.set()

    def delete():
        with session_factory()() as db:
            return delete_image(pg["asset_id"], user=db.get(User, pg["owner_id"]), db=db)

    monkeypatch.setattr(workers, "create_asset", pause_finalization)
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(pg["png"], usage={"total_tokens": 9}))
    event.listen(engine(), "before_cursor_execute", observe_delete_lock)
    try:
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="finalize-result") as worker_pool, ThreadPoolExecutor(max_workers=1, thread_name_prefix="delete-original") as delete_pool:
            worker_future = worker_pool.submit(run_job, job_id)
            try:
                assert finalizing.wait(10)
                delete_future = delete_pool.submit(delete)
                assert deletion_waiting.wait(10)
            finally:
                resume_finalize.set()
            worker_future.result(timeout=15)
            deleted = delete_future.result(timeout=15)
    finally:
        event.remove(engine(), "before_cursor_execute", observe_delete_lock)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        assert job.status == "succeeded", job.error_code
        assert job.output_asset_id in deleted["asset_ids"]
        for asset_id in (pg["asset_id"], job.output_asset_id):
            asset = db.get(Asset, asset_id)
            assert asset.deleted_at and asset.purged_at
            assert object_path(asset.storage_key).exists()  # Shared bytes survive grant revocation.
            with pytest.raises(HTTPException) as rejected:
                owned_asset(db, asset_id, pg["owner_id"])
            assert rejected.value.status_code == 410
        assert not job_json(db, job)["result_available"]
    assert_single_charge(pg, job_id)


def test_postgres_initial_migrations_wait_on_advisory_lock_across_processes(pg_scope):
    from app.db import engine
    script = "from app.db import initialize; initialize(); print('migration-complete')"
    processes = []
    # A lock in this isolated database proves both initializers wait before DDL.
    with pg_scope["administration"].connect() as locker:
        locker.execute(text("SELECT pg_advisory_lock(:key)"), {"key": MIGRATION_LOCK_ID})
        try:
            for _ in range(2):
                processes.append(subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=os.environ.copy()))

            def both_waiting():
                with pg_scope["administration"].connect() as observer:
                    count = observer.scalar(text("SELECT count(*) FROM pg_stat_activity WHERE datname = :database AND application_name = :application AND wait_event = 'advisory'"), {"database": TEST_DATABASE, "application": pg_scope["application_name"]})
                    return count == 2

            wait_until(both_waiting, timeout=6)
            assert all(process.poll() is None for process in processes)
        finally:
            locker.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": MIGRATION_LOCK_ID})
    try:
        for process in processes:
            stdout, stderr = process.communicate(timeout=20)
            # Diagnostics intentionally omit credential-bearing environment and DSNs.
            password = os.environ.get("TEST_PG_PASSWORD") or os.environ.get("POSTGRES_PASSWORD", "")
            diagnostic = stderr.replace(password, "[redacted]") if password else stderr
            assert process.returncode == 0, diagnostic
            assert "migration-complete" in stdout
        with engine().connect() as connection:
            revisions = connection.execute(text("SELECT version_num FROM alembic_version")).scalars().all()
            assert revisions == ['shared_0004_text_providers']
            assert connection.scalar(text("SELECT count(*) FROM translation_providers")) == 0
            assert connection.scalar(text("SELECT count(*) FROM translation_provider_revisions")) == 0
            assert connection.scalar(text("SELECT count(*) FROM users")) == 0
            assert connection.scalar(text("SELECT count(*) FROM jobs")) == 0
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


def test_postgres_classic_metering_has_no_cost_cap(pg):
    from app.classic import reserve_call
    from app.adapters.text import TextError
    from app.db import session_factory
    from app.jobs import create_job
    from app.models import Asset, TextCall, User
    from app.queue_models import JobStage
    from conftest import claim_job as claim
    with session_factory()() as db:
        job = create_job(db, db.get(User, pg['owner_id']), db.get(Asset, pg['asset_id']), 'classic', 'zh-Hans', 'classic-budget')
        db.commit()
        job_id = job.id
    with session_factory()() as db:
        for stage in db.scalars(select(JobStage).where(JobStage.job_id == job_id)):
            if stage.name == "analyze":
                stage.status = "succeeded"
            elif stage.name == "text":
                stage.status = "ready"
        db.commit()
    lease_id = claim(job_id)
    assert lease_id
    barrier = threading.Barrier(6)
    def reserve_concurrently(index):
        barrier.wait(timeout=10)
        try:
            return reserve_call(job_id, lease_id, index, [{'id': 'b001', 'source': 'Hello'}], 'zh-Hans')[0]
        except TextError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(reserve_concurrently, range(6)))
    assert len(set(results)) == 6 and all(not value.startswith('TEXT_') for value in results)
    with session_factory()() as db:
        calls = db.scalars(select(TextCall).where(TextCall.job_id == job_id)).all()
        assert len(calls) == 6
        assert sum(call.accounted_micros for call in calls) > 50_000
