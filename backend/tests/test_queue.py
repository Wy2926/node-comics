"""Fairness and persisted admission with no broker or supplier dependency."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import threading

import pytest
from sqlalchemy import func, select
from conftest import login
from app.config import settings
from app.db import session_factory
from app.models import Attempt, Batch, Job, Outbox, User, now, uid
from app.queue_models import QueueAdmission, SchedulerState
from app.scheduler import admit_jobs
from app.workers import claim


def seed_owner(png, owner_id, count, *, modes=("redraw", "classic")):
    from app.assets import create_asset
    from app.providers import configuration
    with session_factory()() as db:
        user = User(id=owner_id, subject="dev:" + owner_id, name=owner_id)
        db.add(user)
        db.flush()
        asset = create_asset(db, owner_id, png)
        batches = [Batch(owner_id=owner_id, preview_id=uid(), idempotency_key=uid(), request_hash="x" * 64, quota_pages=0) for _ in range(2)]
        db.add_all(batches)
        db.flush()
        config = configuration(db, "redraw", "zh-Hans")
        config["provider"]["concurrency"] = 10
        jobs, timestamp = [], now()
        for index in range(count):
            job = Job(id=uid(), owner_id=owner_id, input_asset_id=asset.id,
                      batch_id=None if index % 3 == 0 else batches[index % 3 - 1].id, ordinal=index // 3,
                      mode=modes[index % len(modes)], target_language="zh-Hans", status="queued", phase="queued",
                      operation="translate", idempotency_key=uid(), request_hash="x" * 64, cache_key=uid(),
                      config=config, quota_kind="redraw_monthly", quota_pages=0, settlement="free", created_at=timestamp + timedelta(microseconds=index))
            db.add(job)
            jobs.append(job.id)
        db.flush()
        db.add_all([Outbox(job_id=value) for value in jobs])
        db.commit()
        return jobs


def token_for(job_id):
    with session_factory()() as db:
        return db.get(QueueAdmission, job_id).token


def test_round_robin_persists_across_ticks_multiple_batches_single_pages_and_modes(client, png):
    jobs = {owner: seed_owner(png, owner, 6) for owner in ["user-c", "user-a", "user-b"]}
    chosen = [admit_jobs(limit=1)[0] for _ in range(6)]
    assert chosen == [jobs[owner][index] for index in range(2) for owner in sorted(jobs)]
    assert admit_jobs() == []
    with session_factory()() as db:
        assert db.get(SchedulerState, 1).last_owner_id == "user-c"
        assert db.get(SchedulerState, 1).sequence == 6
        assert db.scalar(select(func.count()).select_from(Outbox).where(Outbox.published_at.is_not(None))) == 0


def test_busy_owner_cannot_hide_other_users_behind_first_100_rows(client, png):
    a = seed_owner(png, "user-a", 140)
    b = seed_owner(png, "user-b", 3)
    c = seed_owner(png, "user-c", 3)
    assert admit_jobs() == [a[0], b[0], c[0], a[1], b[1], c[1]]


def test_unadmitted_and_duplicate_messages_cannot_claim_or_bypass_modes(client, png):
    jobs = seed_owner(png, "user-a", 4)
    assert claim(jobs[0]) is None
    assert admit_jobs() == jobs[:2]
    assert claim(jobs[0]) is None  # Old ID-only messages cannot consume a new admission.
    assert claim(jobs[0], "wrong-token") is None
    assert claim(jobs[0], token_for(jobs[0]))
    assert claim(jobs[1], token_for(jobs[1]))
    assert claim(jobs[0], token_for(jobs[0])) is None
    assert claim(jobs[2]) is None
    assert admit_jobs() == []
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Attempt)) == 2
        assert set(db.scalars(select(Job.mode).where(Job.status == "running"))) == {"redraw", "classic"}


def test_limit_changes_revoke_pending_tokens_and_preserve_running_work(client, png):
    jobs = seed_owner(png, "user-a", 5)
    auth = login(client, "user-a")
    settings().free_concurrency = 4
    assert admit_jobs() == jobs[:4]
    revoked = token_for(jobs[3])
    assert claim(jobs[0], token_for(jobs[0]))
    assert claim(jobs[1], token_for(jobs[1]))
    settings().free_concurrency = 1
    admit_jobs()
    response = client.get("/v1/me/queue", headers=auth)
    assert response.json()["running"] == 2 and response.json()["dispatched"] == 0
    assert claim(jobs[3], revoked) is None and admit_jobs() == []
    with session_factory()() as db:
        db.get(Job, jobs[0]).status = "failed"
        db.commit()
    assert admit_jobs() == []
    with session_factory()() as db:
        db.get(Job, jobs[1]).status = "failed"
        db.commit()
    assert admit_jobs() == [jobs[2]]
    assert claim(jobs[3], revoked) is None


def test_worker_rechecks_global_limit_lowered_after_admission(client, png):
    jobs = seed_owner(png, "user-a", 3)
    admit_jobs()
    assert claim(jobs[0], token_for(jobs[0]))
    settings().free_concurrency = 1
    assert claim(jobs[1], token_for(jobs[1])) is None
    assert admit_jobs() == []
    with session_factory()() as db:
        assert db.get(QueueAdmission, jobs[1]) is None


def test_cancel_and_recovery_rejoin_rotation_and_fence_stale_tokens(client, png):
    from app.dispatcher import recover
    from app.jobs import cancel_job
    a, b = seed_owner(png, "user-a", 3), seed_owner(png, "user-b", 3)
    admit_jobs(limit=2)
    old = token_for(a[0])
    attempt_id = claim(a[0], old)
    with session_factory()() as db:
        db.get(Attempt, attempt_id).lease_expires_at = now() - timedelta(seconds=1)
        db.commit()
        recover(db)
        db.commit()
        cancel_job(db, db.get(Job, b[0]))
        db.commit()
    assert claim(a[0], old) is None
    assert admit_jobs(limit=2) == [a[0], b[1]]
    assert token_for(a[0]) != old
    assert claim(a[0], old) is None
    assert claim(a[0], token_for(a[0]))
    assert claim(b[0]) is None


def test_unknown_call_is_not_readmitted_or_replayed(client, png):
    from app.dispatcher import recover
    jobs = seed_owner(png, "user-a", 2)
    admit_jobs(limit=1)
    old = token_for(jobs[0])
    attempt_id = claim(jobs[0], old)
    with session_factory()() as db:
        attempt = db.get(Attempt, attempt_id)
        attempt.call_started_at = now()
        attempt.lease_expires_at = now() - timedelta(seconds=1)
        db.commit()
        recover(db)
        db.commit()
    assert admit_jobs() == [jobs[1]]
    assert claim(jobs[0], old) is None
    with session_factory()() as db:
        assert db.get(Job, jobs[0]).status == "outcome_unknown"


def test_broker_failure_keeps_admission_and_republish_does_not_spend_another_turn(client, png, monkeypatch):
    import app.dispatcher as dispatcher
    jobs = seed_owner(png, "user-a", 3)
    def fail(**kwargs):
        raise ConnectionError("isolated broker failure")
    monkeypatch.setattr(dispatcher.process_job, "apply_async", fail)
    with pytest.raises(ConnectionError):
        dispatcher.dispatch_once()
    tokens = [token_for(job_id) for job_id in jobs[:2]]
    sent = []
    monkeypatch.setattr(dispatcher.process_job, "apply_async", lambda **kwargs: sent.append(kwargs))
    assert dispatcher.dispatch_once() == 2
    with session_factory()() as db:
        cursor = db.get(SchedulerState, 1).sequence
        for event in db.scalars(select(Outbox).where(Outbox.job_id.in_(jobs[:2]))):
            event.published_at = now() - timedelta(minutes=5)
        db.commit()
    assert dispatcher.dispatch_once() == 2
    assert [value["kwargs"]["admission_token"] for value in sent] == tokens * 2
    with session_factory()() as db:
        assert db.get(SchedulerState, 1).sequence == cursor == 2
        assert db.scalar(select(func.count()).select_from(Job)) == 3


def test_concurrent_sqlite_dispatchers_and_claims_share_durable_cap(client, png):
    jobs = {owner: seed_owner(png, owner, 6) for owner in ["user-a", "user-b", "user-c"]}
    barrier = threading.Barrier(6)
    def allocate(_):
        barrier.wait(timeout=10)
        return admit_jobs(limit=1)
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(allocate, range(6)))
    assert len({value[0] for value in results}) == 6
    with session_factory()() as db:
        ordered = db.scalars(select(QueueAdmission.job_id).order_by(QueueAdmission.sequence)).all()
    assert ordered == [jobs[owner][index] for index in range(2) for owner in sorted(jobs)]
    # Deliberately duplicate broker deliveries; only one attempt per slot can win.
    with ThreadPoolExecutor(max_workers=8) as pool:
        claims = list(pool.map(lambda job_id: claim(job_id, token_for(job_id)), ordered * 3))
    assert len([value for value in claims if value]) == 6


def test_plan_concurrency_is_read_only_and_admin_lookup_is_private(client):
    from conftest import login_plus
    alice, bob, admin = login(client), login_plus(client, "bob"), login(client, "admin")
    settings().free_concurrency = 1
    settings().plus_concurrency = 3
    owner = client.get("/v1/me", headers=bob).json()["user"]["id"]
    path = f"/v1/admin/users/{owner}/queue"
    assert client.get("/v1/me/queue").status_code == 401
    assert client.get("/v1/me/queue", headers=alice).json()["concurrency"] == 1
    assert client.get("/v1/me/queue", headers=bob).json()["concurrency"] == 3
    assert client.put("/v1/me/queue", headers=alice, json={"concurrency": 10}).status_code == 405
    assert client.get(path, headers=alice).status_code == 403
    assert client.put(path, headers=admin, json={"concurrency": 10}).status_code == 405
    assert client.get(path, headers=admin).json()["concurrency"] == 3
    assert client.get("/v1/admin/users/no-such-user/queue", headers=admin).status_code == 404
