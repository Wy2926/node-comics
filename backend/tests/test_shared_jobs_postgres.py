"""Cross-device submission and completion races on isolated real PostgreSQL."""
from concurrent.futures import ThreadPoolExecutor
import threading
from sqlalchemy import event, func, select
from test_postgres_concurrency import pg, pg_scope, pytestmark, new_job, assert_single_charge
from conftest import run_job
from app.db import engine, session_factory
from app.entitlement_models import QuotaPeriod
from app.models import Asset, Job, Ledger, User
from app.translation_requests import TranslationRequest, ImageAdmission
from app.translation_api import TranslationInput, translate
from conftest import request_id
from uuid import UUID
import json


def submit_existing(pg, key, asset_ids=None):
    rows = []
    for index, asset_id in enumerate(asset_ids or [pg['asset_id']]):
        with session_factory()() as db:
            user, asset = db.get(User, pg['owner_id']), db.get(Asset, asset_id)
            body = TranslationInput(mode='redraw',target_language='zh-Hans',image={
                'sha256':asset.sha256,'byte_size':asset.byte_size,'content_type':asset.mime})
            identifier = request_id(key if not asset_ids else f'{key}:{index}')
            response = translate(UUID(identifier),body,user=user,db=db)
            assert response.status_code in {200,202}
            rows.append(db.get(TranslationRequest,(user.id,identifier)))
    return rows


def test_two_devices_submit_identical_page_share_one_paid_job(pg, monkeypatch):
    from app.adapters.images import TranslationOutput
    from app import workers
    barrier = threading.Barrier(2)
    def confirmation(index):
        barrier.wait(timeout=10)
        result = submit_existing(pg, f"device-{index}")
        return result[0].id, result[0].job_id
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(confirmation, range(2)))
    assert len({row[0] for row in results}) == 2
    assert len({row[1] for row in results}) == 1
    job_id = results[0][1]
    with session_factory()() as db:
        for model in (Job, Ledger):
            assert db.scalar(select(func.count()).select_from(model)) == 1
        for model in (TranslationRequest,):
            assert db.scalar(select(func.count()).select_from(model)) == 2
        assert db.scalar(select(QuotaPeriod.reserved).where(QuotaPeriod.owner_id == pg["owner_id"])) == 1
    calls = []
    def provider(*args):
        calls.append(1)
        return TranslationOutput(pg["png"], usage={"total_tokens": 7})
    monkeypatch.setattr(workers, "redraw", provider)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run_job, job_id) for _ in range(2)]
        for future in futures:
            future.result(timeout=15)
    assert calls == [1]
    assert_single_charge(pg, job_id)


def test_completion_and_new_receipt_serialize_without_fk_deadlock(pg, monkeypatch):
    from app.adapters.images import TranslationOutput
    from app import workers
    job_id = new_job(pg)
    finalizing, resume, request_waiting = threading.Event(), threading.Event(), threading.Event()
    actual_create = workers.create_asset
    def held_finalize(*args, **kwargs):
        finalizing.set()
        assert resume.wait(10)
        return actual_create(*args, **kwargs)
    def observe(connection, cursor, statement, parameters, context, executemany):
        if threading.current_thread().name.startswith("new-submission") and "pg_advisory_xact_lock" in statement:
            request_waiting.set()
    monkeypatch.setattr(workers, "create_asset", held_finalize)
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(pg["png"]))
    event.listen(engine(), "before_cursor_execute", observe)
    try:
        with ThreadPoolExecutor(max_workers=1) as execution, ThreadPoolExecutor(max_workers=1, thread_name_prefix="new-submission") as admission:
            worker = execution.submit(run_job, job_id)
            try:
                assert finalizing.wait(10)
                receipt = admission.submit(submit_existing, pg, "during-finalize")
                assert request_waiting.wait(10)
                assert not receipt.done()
            finally:
                resume.set()
            worker.result(timeout=15)
            result = receipt.result(timeout=15)
    finally:
        event.remove(engine(), "before_cursor_execute", observe)
    assert result[0].job_id == job_id
    assert_single_charge(pg, job_id)


def test_single_and_multi_page_submission_keep_both_receipts(pg):
    from app.assets import create_asset
    from app.jobs import create_job
    with session_factory()() as db:
        alias = create_asset(db, pg["owner_id"], pg["png"])
        db.commit()
        alias_id = alias.id
    barrier = threading.Barrier(2)
    def single():
        with session_factory()() as db:
            user, asset = db.get(User, pg["owner_id"]), db.get(Asset, pg["asset_id"])
            barrier.wait(timeout=10)
            job = create_job(db, user, asset, "redraw", "zh-Hans", "single-device")
            db.commit()
            return job.id
    def multi():
        barrier.wait(timeout=10)
        result = submit_existing(pg, "multi-device", [alias_id, pg["asset_id"]])
        assert len({item.job_id for item in result}) == 1
        return result[0].job_id
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = pool.submit(single), pool.submit(multi)
        assert first.result(timeout=15) == second.result(timeout=15)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(TranslationRequest)) == 3
        assert db.scalar(select(QuotaPeriod.reserved).where(QuotaPeriod.owner_id == pg["owner_id"])) == 1
