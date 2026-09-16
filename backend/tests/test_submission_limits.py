"""Admission accounts are shared by API replicas and independent of job slots."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from conftest import login
from test_cluster_submissions import cluster, descriptor, manifest, submit


def test_reusing_one_job_cannot_create_unbounded_receipts(cluster, png):
    from app.config import settings
    from app.db import session_factory
    from app.models import Job
    from app.queue_models import Submission
    client, _ = cluster
    auth = login(client)
    settings().submission_request_burst = 3
    settings().submission_requests_per_minute = 1
    results = [submit(client, auth, [descriptor(png)], key=f"reuse-{index}") for index in range(6)]
    assert [response.status_code for response in results] == [202, 202, 202, 429, 429, 429]
    assert all(response.headers["Retry-After"] for response in results[3:])
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Submission)) == 3


def test_rejected_work_still_consumes_tokens_and_releases_concurrency(cluster):
    from app.config import settings
    from app.db import session_factory
    from app.queue_models import SubmissionAdmission
    client, _ = cluster
    auth = login(client)
    settings().submission_request_burst = 2
    settings().submission_requests_per_minute = 1
    assert submit(client, auth, manifest(11), key="too-many-1").status_code == 409
    assert submit(client, auth, manifest(11), key="too-many-2").status_code == 409
    assert submit(client, auth, manifest(1), key="otherwise-valid").status_code == 429
    with session_factory()() as db:
        assert db.scalar(select(SubmissionAdmission)).leases == []


def test_daily_receipt_limit_preserves_replays_and_resets_next_day(cluster, png, monkeypatch):
    from app import submission_limits
    from app.config import settings
    from app.db import session_factory
    from app.models import now
    from app.queue_models import SubmissionAdmission
    client, _ = cluster
    auth = login(client)
    settings().submission_receipts_per_day = 2
    assert submit(client, auth, [descriptor(png)], key="first").status_code == 202
    assert submit(client, auth, [descriptor(png)], key="second").status_code == 202
    blocked = submit(client, auth, [descriptor(png)], key="third")
    assert blocked.status_code == 429 and blocked.json()["error"]["code"] == "SUBMISSION_DAILY_LIMIT"
    assert submit(client, auth, [descriptor(png)], key="first").status_code == 202
    tomorrow = now() + timedelta(days=1)
    monkeypatch.setattr(submission_limits, "now", lambda: tomorrow)
    assert submit(client, auth, [descriptor(png)], key="third").status_code == 202
    with session_factory()() as db:
        assert db.scalar(select(SubmissionAdmission)).daily_submissions == 1


def test_daily_item_limit_counts_repeated_content_without_charging_replay(cluster, png):
    from app.config import settings
    client, _ = cluster
    auth = login(client)
    settings().submission_items_per_day = 3
    pages = [descriptor(png, str(index)) for index in range(2)]
    assert submit(client, auth, pages, key="two-descriptors").status_code == 202
    assert submit(client, auth, pages, key="two-descriptors").status_code == 202
    response = submit(client, auth, pages, key="two-more-descriptors")
    assert response.status_code == 429 and response.json()["error"]["code"] == "SUBMISSION_DAILY_LIMIT"
    assert submit(client, auth, [descriptor(png)], key="last-descriptor").status_code == 202


def test_large_submission_concurrency_is_bounded_before_scheduler(cluster, png, monkeypatch):
    from app import submission_api
    from app.config import settings
    client, _ = cluster
    auth = login(client)
    settings().submission_large_batch_items = 2
    entered, resume = Event(), Event()
    actual_submit = submission_api._submit
    def delayed(body, key, user, db):
        if key == "slow":
            entered.set()
            assert resume.wait(10)
        return actual_submit(body, key, user, db)
    monkeypatch.setattr(submission_api, "_submit", delayed)
    pages = [descriptor(png, str(index)) for index in range(2)]
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(submit, client, auth, pages, key="slow")
        try:
            assert entered.wait(5)
            rejected = submit(client, auth, pages, key="second-large")
            assert rejected.status_code == 429 and rejected.json()["error"]["code"] == "SUBMISSION_BUSY"
            assert submit(client, auth, [descriptor(png)], key="small").status_code == 202
        finally:
            resume.set()
        assert future.result(timeout=10).status_code == 202


def test_chunked_manifest_is_bounded_before_parsing_or_admission(cluster):
    from app.config import settings
    from app.db import session_factory
    from app.queue_models import SubmissionAdmission
    client, _ = cluster
    auth = login(client)
    settings().submission_max_body_bytes = 1024
    response = client.post("/v1/translation-submissions", headers={**auth, "Content-Type": "application/json"},
        content=iter([b'{"padding":"', b"a" * 2048, b'"}']))
    assert response.status_code == 413
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(SubmissionAdmission)) == 0


def test_archiving_drops_details_but_retains_idempotency_and_active_receipts(cluster, png):
    from app.db import session_factory
    from app.models import Job, User, now
    from app.job_requests import JobRequest
    from app.queue_models import Submission, SubmissionItem
    from app.submission_limits import archive_submission_receipts
    client, _ = cluster
    auth = login(client)
    done_pages = [descriptor(png, str(index)) for index in range(3)]
    done = submit(client, auth, done_pages, key="done").json()
    active = submit(client, auth, manifest(1), key="active").json()
    assert client.post(f"/v1/translation-submissions/{done['id']}/cancel", headers=auth).status_code == 200
    with session_factory()() as db:
        owner = db.get(Submission, done["id"]).owner_id
        db.add(User(id='other-archive-owner', subject='isolated-archive-owner', name='Other'))
        db.flush()
        for owner_id, operation in [(owner, 'other-operation'), ('other-archive-owner', 'submission')]:
            db.add(JobRequest(owner_id=owner_id, operation=operation, idempotency_key=done["id"] + ':0',
                request_hash='a' * 64, job_id=done["items"][0]["job"]["id"]))
        for receipt in db.scalars(select(Submission)):
            receipt.created_at = now() - timedelta(days=31)
        db.commit()
        assert archive_submission_receipts(db) == 0  # Fresh completion retains its full receipt.
        db.get(Job, done["items"][0]["job"]["id"]).completed_at = now() - timedelta(days=31)
        db.commit()
        assert archive_submission_receipts(db) == 1
        db.commit()
        assert db.get(Submission, done["id"]).archived_at is not None
        assert db.get(Submission, active["id"]).archived_at is None
        assert db.scalar(select(func.count()).select_from(SubmissionItem)) == 1
        assert db.scalar(select(func.count()).select_from(JobRequest)) == 3
        assert db.get(JobRequest, (owner, 'submission', active["id"] + ':0')) is not None
        assert db.get(JobRequest, (owner, 'other-operation', done["id"] + ':0')) is not None
        assert db.get(JobRequest, ('other-archive-owner', 'submission', done["id"] + ':0')) is not None
        assert db.scalar(select(func.count()).select_from(Job)) == 2
    replay = submit(client, auth, done_pages, key="done")
    assert replay.status_code == 410 and replay.json()["error"]["code"] == "SUBMISSION_ARCHIVED"
    assert submit(client, auth, manifest(1), key="done").status_code == 409
    assert client.get(f"/v1/translation-submissions/{done['id']}", headers=auth).status_code == 410
    assert client.get("/v1/translation-submissions", headers=auth).json()["total"] == 1


def test_independent_sessions_enforce_same_account_concurrency(scheduler_case):
    from app.submission_limits import acquire_submission, release_submission
    from app.config import settings
    settings().submission_concurrency = 2
    gate = Barrier(8)
    def enter(index):
        gate.wait()
        try:
            return acquire_submission("free-user", f"different-{index}", 1)
        except HTTPException as error:
            assert error.status_code == 429 and error.detail["code"] == "SUBMISSION_BUSY"
            return None
    with ThreadPoolExecutor(max_workers=8) as pool:
        accepted = [token for token in pool.map(enter, range(8)) if token]
    assert len(accepted) == 2
    other = acquire_submission("plus-user", "other-account", 1)
    release_submission("plus-user", other)
    for token in accepted:
        release_submission("free-user", token)
    token = acquire_submission("free-user", "after-release", 1)
    release_submission("free-user", token)


def test_expired_admission_lease_does_not_permanently_block_account(scheduler_case, monkeypatch):
    from app import submission_limits
    from app.config import settings
    from app.models import now
    settings().submission_concurrency = 1
    first = submission_limits.acquire_submission("free-user", "before-crash", 1)
    later = now() + timedelta(seconds=settings().submission_admission_lease_seconds + 1)
    monkeypatch.setattr(submission_limits, "now", lambda: later)
    next_token = submission_limits.acquire_submission("free-user", "after-crash", 1)
    assert next_token != first
    submission_limits.release_submission("free-user", first)
    with pytest.raises(HTTPException) as denied:
        submission_limits.acquire_submission("free-user", "still-busy", 1)
    assert denied.value.detail["code"] == "SUBMISSION_BUSY"
    submission_limits.release_submission("free-user", next_token)


def test_independent_sessions_share_request_and_item_bursts(scheduler_case):
    from app.submission_limits import acquire_submission, release_submission
    from app.config import settings
    settings().submission_concurrency = 32
    settings().submission_request_burst = 3
    settings().submission_requests_per_minute = 1
    gate = Barrier(8)
    def enter(index):
        gate.wait()
        try:
            return acquire_submission("free-user", f"burst-{index}", 1)
        except HTTPException as error:
            assert error.detail["code"] == "SUBMISSION_RATE_LIMITED"
            return None
    with ThreadPoolExecutor(max_workers=8) as pool:
        accepted = [token for token in pool.map(enter, range(8)) if token]
    assert len(accepted) == 3
    for token in accepted:
        release_submission("free-user", token)
    settings().submission_item_burst = 5
    settings().submission_items_per_minute = 1
    token = acquire_submission("plus-user", "three-items", 3)
    release_submission("plus-user", token)
    with pytest.raises(HTTPException) as denied:
        acquire_submission("plus-user", "three-more-items", 3)
    assert denied.value.detail["code"] == "SUBMISSION_RATE_LIMITED"


from test_cluster_scheduler import scheduler_case
from test_classic import text_database
