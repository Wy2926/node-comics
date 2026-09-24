"""Real PostgreSQL races for result grants and lock-free candidate discovery."""
from concurrent.futures import ThreadPoolExecutor
import json
import threading
from sqlalchemy import event, func, select
from test_postgres_concurrency import pg, pg_scope, pytestmark, new_job
from conftest import run_job
from app.db import engine, session_factory
from app.models import Asset, Job, User
from app.translation_api import TranslationInput, translate
from conftest import request_id
from uuid import UUID
from app.translation_requests import TranslationRequest
from app.results import ResultAccess, TranslationResult
from app.scheduler import lock_scheduler


def reader(pg):
    with session_factory()() as db:
        user = User(subject='cache-reader', name='cache reader')
        db.add(user)
        db.commit()
        return user.id


def request(pg, owner_id, key, language='zh-Hans'):
    with session_factory()() as db:
        asset = db.get(Asset, pg['asset_id'])
        body = TranslationInput(mode='redraw',target_language=language,image={
            'sha256':asset.sha256,'byte_size':asset.byte_size,'content_type':asset.mime})
        return json.loads(translate(UUID(request_id(key)),body,user=db.get(User,owner_id),db=db).body)



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
    assert all(row['state'] == 'succeeded' for row in replies)
    assert len({row['result']['asset_id'] for row in replies}) == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(TranslationResult)) == 1
        assert db.scalar(select(func.count()).select_from(ResultAccess)) == 1
        receipts = list(db.scalars(select(TranslationRequest).where(TranslationRequest.owner_id == owner_id)))
        assert len(receipts) == 2 and all(row.job_id is None for row in receipts)
        assert receipts[0].access_id == receipts[1].access_id != original




def test_opposite_snapshot_orders_share_source_without_deadlock(pg, monkeypatch):
    from app import workers
    from app.adapters.images import TranslationOutput
    from app.translation_api import read_snapshot
    monkeypatch.setattr(workers,'redraw',lambda *args:TranslationOutput(pg['png']))
    accepted = []
    for key, language in [('first','zh-Hans'),('second','en')]:
        snapshot = request(pg,pg['owner_id'],key,language)
        with session_factory()() as db:
            row = db.get(TranslationRequest,(pg['owner_id'],snapshot['id']))
            job_id = row.job_id
        run_job(job_id)
        accepted.append(snapshot['id'])
    barrier = threading.Barrier(2)
    def read(reverse):
        ids = list(reversed(accepted)) if reverse else accepted
        for _ in range(12):
            barrier.wait(timeout=10)
            _, data = read_snapshot(pg['owner_id'], ids)
            assert [item['id'] for item in data['items']] == ids
            assert all(item['state']=='succeeded' and item['result']['download_url'] for item in data['items'])
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(read,[False,True]))
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 2
        assert all(asset.last_accessed_at for asset in db.scalars(select(Asset)))
