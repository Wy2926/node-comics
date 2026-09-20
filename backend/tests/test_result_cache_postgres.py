"""Real PostgreSQL races for result grants and lock-free candidate discovery."""
from concurrent.futures import ThreadPoolExecutor
import json
import threading
from sqlalchemy import event, func, select
from test_postgres_concurrency import pg, pg_scope, pytestmark, new_job
from conftest import run_job
from app.db import engine, session_factory
from app.models import Asset, Job, User
from app.plan_api import TranslationPlan, translate
from app.plan_models import TranslationOperation
from app.results import ResultAccess, TranslationResult
from app.scheduler import lock_scheduler


def reader(pg):
    with session_factory()() as db:
        user = User(subject='cache-reader', name='cache reader')
        db.add(user)
        db.commit()
        return user.id


def request(pg, owner_id, key):
    with session_factory()() as db:
        asset = db.get(Asset, pg['asset_id'])
        body = TranslationPlan(trigger='manual', items=[{'page_key': 'p', 'operation_key': key,
            'mode': 'redraw', 'target_language': 'zh-Hans', 'image': {'client_item_id': 'p',
                'image_sha256': asset.sha256, 'byte_size': asset.byte_size, 'content_type': asset.mime}}])
        return json.loads(translate(body, user=db.get(User, owner_id), db=db).body)['items'][0]


def publish(pg, monkeypatch):
    from app import workers
    from app.adapters.images import TranslationOutput
    monkeypatch.setattr(workers, 'redraw', lambda *args: TranslationOutput(pg['png']))
    job_id = new_job(pg)
    run_job(job_id)
    return job_id


def test_concurrent_cache_requests_create_one_grant_and_no_alias_job(pg, monkeypatch):
    original = publish(pg, monkeypatch)
    owner_id = reader(pg)
    barrier = threading.Barrier(2)
    def submit(index):
        barrier.wait(timeout=10)
        return request(pg, owner_id, f'cache-device-{index}')
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(submit, range(2)))
    assert all(row['disposition'] == 'ready' and row['job']['cache_hit'] for row in replies)
    assert len({row['job']['id'] for row in replies}) == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(TranslationResult)) == 1
        assert db.scalar(select(func.count()).select_from(ResultAccess)) == 1
        receipts = list(db.scalars(select(TranslationOperation).where(TranslationOperation.owner_id == owner_id)))
        assert len(receipts) == 2 and all(row.job_id is None for row in receipts)
        assert receipts[0].access_id == receipts[1].access_id != original


def test_shared_discovery_can_run_while_other_transaction_holds_global_lock(pg, monkeypatch):
    publish(pg, monkeypatch)
    owner_id = reader(pg)
    discovered, waiting = threading.Event(), threading.Event()
    def observe(connection, cursor, statement, parameters, context, executemany):
        if threading.current_thread().name.startswith('cache-admission'):
            if 'producer_live' in statement:
                discovered.set()
            if 'pg_advisory_xact_lock' in statement:
                waiting.set()
    event.listen(engine(), 'before_cursor_execute', observe)
    try:
        with session_factory()() as blocker, ThreadPoolExecutor(max_workers=1, thread_name_prefix='cache-admission') as pool:
            lock_scheduler(blocker)
            future = pool.submit(request, pg, owner_id, 'during-lock')
            try:
                assert discovered.wait(10)
                assert waiting.wait(10)
                assert not future.done()
            finally:
                blocker.rollback()
            assert future.result(timeout=15)['job']['cache_hit']
    finally:
        event.remove(engine(), 'before_cursor_execute', observe)
