"""Real PostgreSQL account isolation during simultaneous shared-content use."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from conftest import png_variant, run_job
from test_postgres_concurrency import new_job, pg, pg_scope, pytestmark


def test_postgres_concurrent_originals_keep_private_grants_and_one_object(pg, monkeypatch):
    from app.assets import content_storage_key, create_asset, inspect_image, object_path, owned_asset
    from app.db import session_factory
    from app.models import Asset, User, uid
    from app.storage import LocalStore
    data = png_variant(pg["png"], 75)
    key = content_storage_key(inspect_image(data)["sha256"])
    with session_factory()() as db:
        users = [User(id=uid(), subject="concurrent-shared-" + uid(), name="isolated reader") for _ in range(2)]
        db.add_all(users)
        db.commit()
        owners = [user.id for user in users]
    barrier = Barrier(2)
    original_put = LocalStore.put

    def simultaneous_put(self, storage_key, raw, mime, *, kind=None):
        if storage_key == key:
            barrier.wait(timeout=10)
        return original_put(self, storage_key, raw, mime, kind=kind)

    monkeypatch.setattr(LocalStore, "put", simultaneous_put)

    def upload(owner_id):
        with session_factory()() as db:
            asset = create_asset(db, owner_id, data)
            db.commit()
            return asset.id

    with ThreadPoolExecutor(2) as pool:
        asset_ids = list(pool.map(upload, owners))
    assert len(set(asset_ids)) == 2
    assert object_path(key).read_bytes() == data
    assert list(object_path(key).parent.iterdir()) == [object_path(key)]
    with session_factory()() as db:
        assert list(db.scalars(select(Asset.storage_key).where(Asset.id.in_(asset_ids)))) == [key, key]
        for index, owner_id in enumerate(owners):
            assert owned_asset(db, asset_ids[index], owner_id)
            with pytest.raises(HTTPException) as rejected:
                owned_asset(db, asset_ids[1 - index], owner_id)
            assert rejected.value.status_code == 404


def test_postgres_concurrent_accounts_reuse_completed_result_without_new_charge(pg, monkeypatch):
    from app import workers
    from app.adapters.images import TranslationOutput
    from app.assets import available, object_path
    from app.db import session_factory
    from app.jobs import create_job
    from app.models import Asset, Job, Ledger, User, uid
    from app.results import ReaderEntry, ResultAccess, TranslationResult
    from app.queue_models import JobStage
    output = png_variant(pg["png"], 76)
    calls = []
    monkeypatch.setattr(workers, "redraw", lambda *args: calls.append(True) or TranslationOutput(output))
    original_job_id = new_job(pg)
    run_job(original_job_id)
    with session_factory()() as db:
        original_job = db.get(Job, original_job_id)
        assert original_job.status == "succeeded"
        source_hash = original_job.source_sha256
        original_output = db.get(Asset, original_job.output_asset_id)
        output_key = original_output.storage_key
        users = [User(id=uid(), subject="completed-cache-" + uid(), name="isolated reader") for _ in range(6)]
        db.add_all(users)
        db.commit()
        owners = [user.id for user in users]
        initial_ledger = db.scalar(select(func.count()).select_from(Ledger))
    barrier = Barrier(6)

    def reuse(owner_id):
        with session_factory()() as db:
            barrier.wait(timeout=10)
            job = create_job(db, db.get(User, owner_id), None, "redraw", "zh-Hans", "shared-completion",
                             source_sha256=source_hash)
            db.commit()
            return job.id

    with ThreadPoolExecutor(6) as pool:
        job_ids = list(pool.map(reuse, owners))
    assert len(set(job_ids)) == 6 and calls == [True]
    with session_factory()() as db:
        jobs = list(db.scalars(select(ReaderEntry).where(ReaderEntry.id.in_(job_ids))))
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(TranslationResult)) == 1
        assert db.scalar(select(func.count()).select_from(ResultAccess)) == 6
        assert {job.owner_id for job in jobs} == set(owners)
        assert all(job.status == "succeeded" and job.cache_hit and job.quota_pages == 0 and job.settlement == "free" for job in jobs)
        assert len({job.input_asset_id for job in jobs}) == 6
        assert len({job.output_asset_id for job in jobs}) == 6
        assert all(db.get(Asset, job.output_asset_id).storage_key == output_key for job in jobs)
        assert db.scalar(select(func.count()).select_from(Ledger)) == initial_ledger
        assert db.scalar(select(func.count()).select_from(JobStage).where(JobStage.job_id.in_(job_ids))) == 0
    from app.main import delete_image
    with session_factory()() as db:
        delete_image(pg["asset_id"], user=db.get(User, pg["owner_id"]), db=db)
    with session_factory()() as db:
        for job_id in job_ids:
            job = db.get(ReaderEntry, job_id)
            assert available(db.get(Asset, job.input_asset_id))
            assert available(db.get(Asset, job.output_asset_id))
    assert object_path(output_key).read_bytes() == output
