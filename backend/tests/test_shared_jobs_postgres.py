"""Two-device confirmation and FK-lock races on isolated real PostgreSQL."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import threading

from sqlalchemy import func, select, text
from test_postgres_concurrency import pg, pg_scope, pytestmark, new_job, wait_until, assert_single_charge
from conftest import admission_token_for
from app.entitlement_models import QuotaPeriod
from app.batch_items import BatchItem, JobRequest
from app.db import session_factory
from app.jobs import create_batch, create_job, create_preview, locked_user
from app.models import Asset, Batch, Job, Ledger, Outbox, User
from app.scheduler import admit_jobs


def test_two_devices_match_miss_then_confirm_distinct_quotes_share_one_paid_job(pg, monkeypatch):
    from app.file_pages import FilePageIdentity, FilePageMatchRequest, match_file_pages, upload_file_page
    from app.adapters.images import TranslationOutput
    from app import workers
    identity = FilePageIdentity(file_hash=sha256(b"same-comic-file").hexdigest(), page_index=2)
    body = FilePageMatchRequest(pages=[identity.model_dump()], mode="redraw", target_language="zh-Hans")
    with session_factory()() as db:
        source = upload_file_page(db, pg["owner_id"], pg["png"], identity)
        db.commit()
        source_id = source.id
    prices = []
    # Both devices observe the miss and independently obtain a preview BEFORE either confirms.
    for _ in range(2):
        with session_factory()() as db:
            assert match_file_pages(db, pg["owner_id"], body)["items"][0]["jobs"] == []
            price = create_preview(db, db.get(User, pg["owner_id"]), [source_id], "redraw", "zh-Hans")
            prices.append((price.id, price.quota_pages))
    barrier = threading.Barrier(2)
    def confirm(index):
        with session_factory()() as db:
            user = db.get(User, pg["owner_id"])
            barrier.wait(timeout=10)
            batch = create_batch(db, user, *prices[index], f"device-{index}")
            job_id = db.scalar(select(BatchItem.job_id).where(BatchItem.batch_id == batch.id))
            return batch.id, job_id, batch.quota_pages
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(confirm, range(2)))
    assert len({row[0] for row in results}) == 2
    assert len({row[1] for row in results}) == 1
    assert sorted(row[2] for row in results) == [0, 1]
    job_id = results[0][1]
    with session_factory()() as db:
        for model in (Job, Outbox, Ledger):
            assert db.scalar(select(func.count()).select_from(model)) == 1
        assert db.scalar(select(func.count()).select_from(BatchItem)) == 2
        assert db.scalar(select(func.count()).select_from(JobRequest)) == 2
        assert db.scalar(select(QuotaPeriod.reserved).where(QuotaPeriod.owner_id == pg["owner_id"])) == 1
    calls = []
    def provider(*args):
        calls.append(1)
        return TranslationOutput(pg["png"], usage={"total_tokens": 7})
    monkeypatch.setattr(workers, "redraw", provider)
    admit_jobs()
    token = admission_token_for(job_id)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(workers.process_job.run, job_id, token) for _ in range(2)]
        for future in futures:
            future.result(timeout=15)
    assert calls == [1]
    assert_single_charge(pg, job_id)
    with session_factory()() as db:
        assert all(job.status == "succeeded" for job in db.scalars(select(Job).join(BatchItem, BatchItem.job_id == Job.id)))


def test_completion_holding_job_lock_allows_user_locked_reuse_receipt_and_batch_fks(pg, monkeypatch):
    from app.adapters.images import TranslationOutput
    from app import workers
    job_id = new_job(pg)
    with session_factory()() as db:
        price = create_preview(db, db.get(User, pg["owner_id"]), [pg["asset_id"]], "redraw", "zh-Hans")
        preview_id, upper_bound = price.id, price.quota_pages
    admit_jobs()
    token = admission_token_for(job_id)
    job_locked, resume_finalize = threading.Event(), threading.Event()
    backend_pid = {}
    original_save = workers.create_asset
    def pause_under_real_worker_job_lock(db, *args, **kwargs):
        backend_pid["value"] = db.scalar(text("SELECT pg_backend_pid()"))
        job_locked.set()
        assert resume_finalize.wait(10)
        # The output foreign key is compatible with the account's NO KEY UPDATE lock.
        return original_save(db, *args, **kwargs)
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(pg["png"]))
    monkeypatch.setattr(workers, "create_asset", pause_under_real_worker_job_lock)
    with ThreadPoolExecutor(max_workers=1) as pool:
        worker = pool.submit(workers.process_job.run, job_id, token)
        try:
            assert job_locked.wait(10)
            with session_factory()() as db:
                user = locked_user(db, pg["owner_id"])
                # Both new foreign keys reference the locked existing Job. They
                # must be compatible with the worker's NO KEY UPDATE state lock.
                batch = create_batch(db, user, preview_id, upper_bound, "reuse-during-finalize")
                assert batch.quota_pages == 0
                assert db.scalar(select(BatchItem.job_id).where(BatchItem.batch_id == batch.id)) == job_id
        finally:
            resume_finalize.set()
        worker.result(timeout=15)
    assert_single_charge(pg, job_id)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(JobRequest)) == 2
        assert db.scalar(select(func.count()).select_from(BatchItem)) == 1


def test_single_page_and_batch_competing_on_identical_bytes_keep_both_request_receipts(pg):
    from app.assets import create_asset
    with session_factory()() as db:
        alias = create_asset(db, pg["owner_id"], pg["png"])
        db.commit()
        alias_id = alias.id
        price = create_preview(db, db.get(User, pg["owner_id"]), [alias_id], "redraw", "zh-Hans")
        preview_id, upper_bound = price.id, price.quota_pages
    barrier = threading.Barrier(2)
    def single():
        with session_factory()() as db:
            user, asset = db.get(User, pg["owner_id"]), db.get(Asset, pg["asset_id"])
            barrier.wait(timeout=10)
            job = create_job(db, user, asset, "redraw", "zh-Hans", "single-device")
            db.commit()
            return job.id
    def batch():
        with session_factory()() as db:
            user = db.get(User, pg["owner_id"])
            barrier.wait(timeout=10)
            group = create_batch(db, user, preview_id, upper_bound, "batch-device")
            return db.scalar(select(BatchItem.job_id).where(BatchItem.batch_id == group.id))
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = pool.submit(single), pool.submit(batch)
        assert first.result(timeout=15) == second.result(timeout=15)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(JobRequest)) == 2
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
        assert db.scalar(select(QuotaPeriod.reserved).where(QuotaPeriod.owner_id == pg["owner_id"])) == 1
