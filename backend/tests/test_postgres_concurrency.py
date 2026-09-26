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
                processes.append(subprocess.Popen([sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=os.environ.copy()))

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
            assert revisions == ['comic_titles_0002']
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
    from app.adapters.llm import TextError
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


def test_cross_process_committed_notification_wakes_listener(pg):
    """The sender is a different process, so local after_commit cannot pass this."""
    import asyncio
    from app.db import engine
    from app.notifications import Hub
    listener = Hub(engine())
    listener.start()
    assert listener.ready.wait(5)
    sender = """
import os, sys, psycopg
with psycopg.connect(os.environ['DATABASE_URL'].replace('postgresql+psycopg:', 'postgresql:')) as db:
    db.execute("SELECT pg_notify('comics_changes', 'isolated-notification')")
    if sys.argv[1] == 'rollback':
        db.rollback()
"""
    async def run():
        with listener.subscribe('isolated-notification') as wake:
            result = await asyncio.to_thread(subprocess.run, [sys.executable, '-c', sender, 'rollback'],
                                             capture_output=True, timeout=10)
            assert result.returncode == 0
            await asyncio.sleep(.1)
            assert not wake.is_set()
            started = time.monotonic()
            result = await asyncio.to_thread(subprocess.run, [sys.executable, '-c', sender, 'commit'],
                                             capture_output=True, timeout=10)
            assert result.returncode == 0
            await asyncio.wait_for(wake.wait(), 2)
            assert time.monotonic() - started < 2
    try:
        asyncio.run(run())
    finally:
        listener.close()


def test_shared_cache_single_flight_across_processes(pg):
    from app.db import session_factory
    from app.comic_title_cache import TitleRecord
    script = '''
import sys, time
from app.comic_title_cache import lookup_or_claim, save_result
from app.comic_titles import TitleTranslationResponse
cached, claim = lookup_or_claim('known title', 'en')
if claim:
    time.sleep(0.5)
    save_result(sys.argv[1], claim, TitleTranslationResponse(name='Existing Title', target_language='en'))
    print('MODEL')
else:
    assert cached == {'name':'Existing Title', 'target_language':'en'}
    print('CACHE')
'''
    processes = [subprocess.Popen([sys.executable, '-c', script, pg['owner_id']],
        cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for _ in range(6)]
    try:
        outputs = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=30)
            assert process.returncode == 0, 'Isolated cache child process failed'
            outputs.append(stdout.strip())
        assert outputs.count('MODEL') == 1
        assert outputs.count('CACHE') == 5
        with session_factory()() as db:
            result = db.scalar(select(TitleRecord))
            assert result.ready and result.name == 'Existing Title'
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


def test_title_admission_concurrency_preserves_window_and_user_isolation(pg, monkeypatch):
    from fastapi import HTTPException
    from app import comic_title_limits as limits
    from app.db import session_factory
    from app.models import User, now, uid
    from app.translation_requests import ControlAdmission

    at = now()
    monkeypatch.setattr(limits, 'server_now', lambda db: at)
    barrier = threading.Barrier(8)

    def admit(_):
        barrier.wait(timeout=10)
        try:
            limits.admit_title(pg['owner_id'])
            return 200
        except HTTPException as error:
            assert error.detail['code'] == 'COMIC_TITLE_RATE_LIMITED'
            assert error.headers == {'Retry-After': '60'}
            return error.status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        statuses = list(pool.map(admit, range(40)))
    assert statuses.count(200) == 30
    assert statuses.count(429) == 10
    with session_factory()() as db:
        assert limits.title_budget(db, pg['owner_id'])['remaining'] == 0
        assert db.scalar(select(func.count()).select_from(ControlAdmission)) == 0
        other_id = uid()
        db.add(User(id=other_id, subject='title-limit:' + other_id, name='Isolated reader'))
        db.commit()
    limits.admit_title(other_id)
    with session_factory()() as db:
        assert limits.title_budget(db, other_id)['used'] == 1
        assert limits.title_budget(db, pg['owner_id'])['used'] == 30

    at += timedelta(seconds=60)
    limits.admit_title(pg['owner_id'])
    with session_factory()() as db:
        budget = limits.title_budget(db, pg['owner_id'])
        assert (budget['used'], budget['remaining'], budget['retry_after_seconds']) == (1, 29, 0)
        assert len(db.get(limits.TitleAdmission, pg['owner_id']).request_times) == 1


def test_title_supplier_concurrent_selection_keeps_one_default_and_body_choice(pg):
    from app.db import session_factory
    from app.translation_models import TranslationProvider
    from app.translation_providers import set_default_provider, provider_profile
    from sqlalchemy.exc import IntegrityError
    with session_factory()() as db:
        original = provider_profile(db)['provider_id']
        candidates = [configure_text_provider(db).id for _ in range(2)]
    barrier = threading.Barrier(2)
    def choose(provider_id):
        with session_factory()() as db:
            barrier.wait(timeout=5)
            return set_default_provider(db, provider_id, pg['owner_id'], purpose='comic_title')['id']
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert set(pool.map(choose, candidates)) == set(candidates)
    with session_factory()() as db:
        assert provider_profile(db)['provider_id'] == original
        selected = provider_profile(db, purpose='comic_title')['provider_id']
        assert selected in candidates
        assert db.scalar(select(func.count()).select_from(TranslationProvider).where(TranslationProvider.is_title_default)) == 1
        # The database enforces uniqueness even if a writer omits the selection lock.
        other = next(key for key in candidates if key != selected)
        db.get(TranslationProvider, other).is_title_default = True
        with pytest.raises(IntegrityError):
            db.flush()
        db.rollback()


def test_title_cache_reads_use_indexes_without_locks_or_user_filters(pg):
    from app import comic_title_cache as cache
    from app.comic_titles import TitleTranslationResponse
    from app.db import engine, session_factory
    owner = pg['owner_id']
    _, claim = cache.lookup_or_claim('known title', 'en')
    cache.save_result(owner, claim, TitleTranslationResponse(name='Existing Title', target_language='en'))
    with session_factory()() as db:
        db.execute(cache.TitleRecord.__table__.insert(), [
            {'input_key': cache.name_key('sample-' + str(n)), 'language': 'en', 'input_name': 'sample-' + str(n),
             'created_by': owner, 'ready': True, 'name': 'Sample result ' + str(n),
             'output_key': cache.name_key('Sample result ' + str(n)), 'actual_language': 'en'} for n in range(5000)])
        db.execute(text('ANALYZE comic_title_cache'))
        db.commit()
        def indexes(node):
            return ({node['Index Name']} if 'Index Name' in node else set()).union(
                *(indexes(child) for child in node.get('Plans', [])))
        plan = db.scalar(text('EXPLAIN (FORMAT JSON) SELECT * FROM comic_title_cache WHERE input_key = :key AND language = :language'),
            {'language': 'en', 'key': cache.name_key('known title')})
        assert 'comic_title_cache_pkey' in indexes(plan[0]['Plan'])
        stmt = cache.related_results(cache.name_key('Existing Title'), 'en')
        sql = str(stmt.compile(dialect=engine().dialect, compile_kwargs={'literal_binds': True}))
        plan = db.scalar(text('EXPLAIN (FORMAT JSON) ' + sql))
        used = indexes(plan[0]['Plan'])
        assert {'comic_title_cache_pkey', 'ix_comic_title_cache_output_key'} <= used
    statements = []
    def track(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    event.listen(engine(), 'before_cursor_execute', track)
    try:
        assert cache.lookup_or_claim('known title', 'en')[0]['name'] == 'Existing Title'
        assert len(statements) == 1
        statements.clear()
        assert cache.lookup_or_claim('Existing Title', 'en')[0]['name'] == 'Existing Title'
        assert len(statements) == 2
    finally:
        event.remove(engine(), 'before_cursor_execute', track)
    assert all(sql.lstrip().upper().startswith(('SELECT', 'WITH')) for sql in statements)
    print('Cache hits are read-only: direct 1 SQL, output-name 2 SQL; primary/output indexes used with 5000 records.')


def test_title_cache_heartbeat_keeps_slow_process_claim_exclusive(pg, monkeypatch):
    from fastapi import HTTPException
    from app import comic_title_cache as cache
    from app.db import session_factory
    script = '''
import sys, time
from app import comic_title_cache as cache
from app.comic_titles import TitleTranslationResponse
cache.LEASE_SECONDS = 2
cache.HEARTBEAT_SECONDS = 0.05
_, claim = cache.lookup_or_claim('slow title', 'en')
with cache.maintain_claim(claim):
    print('RUNNING', flush=True)
    time.sleep(4)
    assert cache.save_result(sys.argv[1], claim, TitleTranslationResponse(name='Existing Title', target_language='en'))
print('DONE', flush=True)
'''
    process = subprocess.Popen([sys.executable, '-c', script, pg['owner_id']],
        cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        with session_factory()() as db:
            def running():
                db.expire_all()
                return db.scalar(select(cache.TitleRecord.lease_until).where(cache.TitleRecord.input_key == cache.name_key('slow title')))
            wait_until(running)
            first_expiry = running()
        # Wait past the initial lease using the database clock, not the host clock.
        def renewed_past_initial_expiry():
            with session_factory()() as db:
                at = cache.server_now(db)
                expiry = db.scalar(select(cache.TitleRecord.lease_until).where(cache.TitleRecord.input_key == cache.name_key('slow title')))
                return at > first_expiry and expiry is not None and expiry > at
        wait_until(renewed_past_initial_expiry, timeout=3)
        monkeypatch.setattr(cache, 'WAIT_SECONDS', 0)
        with pytest.raises(HTTPException) as pending:
            cache.lookup_or_claim('slow title', 'en')
        assert pending.value.detail['code'] == 'COMIC_TITLE_PENDING'
        stdout, stderr = process.communicate(timeout=8)
        assert process.returncode == 0, 'Isolated cache heartbeat child process failed'
        assert stdout.splitlines() == ['RUNNING', 'DONE']
        assert cache.lookup_or_claim('slow title', 'en')[0] == {'name': 'Existing Title', 'target_language': 'en'}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
