"""Real PostgreSQL scheduler races in the isolated concurrency-test database."""
from concurrent.futures import ThreadPoolExecutor
import os
import threading

import pytest
from sqlalchemy import func, select
from test_postgres_concurrency import pg_scope, pg  # shared isolated-schema fixtures
from test_queue import seed_owner, token_for
from app.db import session_factory
from app.models import Attempt, Job, Outbox
from app.queue_models import QueueAdmission
from app.scheduler import admit_jobs
from app.workers import claim

pytestmark = pytest.mark.skipif(os.environ.get("RUN_POSTGRES_CONCURRENCY") != "1",
                                reason="Requires the dedicated PostgreSQL concurrency-test database")


def test_postgres_competing_dispatchers_preserve_global_round_robin_and_owner_caps(pg):
    jobs = {owner: seed_owner(pg["png"], owner, 8) for owner in ["user-a", "user-b", "user-c"]}
    barrier = threading.Barrier(8)
    def dispatch(_):
        barrier.wait(timeout=10)
        return admit_jobs(limit=1)
    with ThreadPoolExecutor(max_workers=8) as pool:
        batches = list(pool.map(dispatch, range(8)))
    assert sum(map(len, batches)) == 6
    with session_factory()() as db:
        ordered = db.scalars(select(QueueAdmission.job_id).order_by(QueueAdmission.sequence)).all()
    assert ordered == [jobs[owner][index] for index in range(2) for owner in sorted(jobs)]


def test_postgres_duplicate_workers_enforce_shared_limit_across_modes(pg):
    jobs = seed_owner(pg["png"], "user-a", 4)
    admit_jobs()
    tokens = {job_id: token_for(job_id) for job_id in jobs[:2]}
    barrier = threading.Barrier(8)
    def receive(index):
        job_id = jobs[index % len(jobs)]
        barrier.wait(timeout=10)
        return claim(job_id, tokens.get(job_id, "unadmitted-token"))
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(receive, range(8)))
    assert sum(value is not None for value in results) == 2
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Attempt)) == 2
        assert set(db.scalars(select(Job.mode).where(Job.status == "running"))) == {"redraw", "classic"}


def test_postgres_lowering_limit_races_with_worker_claims_without_deadlock(pg):
    from app.queue_api import set_queue
    jobs = seed_owner(pg["png"], "user-a", 5)
    with session_factory()() as db:
        set_queue(db, "user-a", 4)
    admit_jobs()
    tokens = {job_id: token_for(job_id) for job_id in jobs[:4]}
    barrier = threading.Barrier(5)
    def receive(job_id):
        barrier.wait(timeout=10)
        return claim(job_id, tokens[job_id])
    def lower():
        barrier.wait(timeout=10)
        with session_factory()() as db:
            return set_queue(db, "user-a", 1)
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(receive, job_id) for job_id in jobs[:4]]
        changed = pool.submit(lower)
        snapshot = changed.result(timeout=15)
        for future in futures:
            future.result(timeout=15)
    with session_factory()() as db:
        running = db.scalar(select(func.count()).select_from(Job).where(Job.status == "running"))
        pending = db.scalar(select(func.count()).select_from(QueueAdmission).join(Job, Job.id == QueueAdmission.job_id).where(Job.status == "queued"))
        assert running <= max(1, snapshot["running"])
        assert pending <= max(0, 1 - running)
    for job_id in jobs[:4]:
        assert claim(job_id, tokens[job_id]) is None


def test_postgres_competing_publishers_do_not_duplicate_same_admission(pg, monkeypatch):
    from app.dispatcher import publish_one
    import app.dispatcher as dispatcher
    seed_owner(pg["png"], "user-a", 3)
    seed_owner(pg["png"], "user-b", 3)
    admit_jobs()
    published, guard = [], threading.Lock()
    def send(**kwargs):
        with guard:
            published.append(kwargs["kwargs"]["admission_token"])
    monkeypatch.setattr(dispatcher.process_job, "apply_async", send)
    barrier = threading.Barrier(8)
    def publish(_):
        barrier.wait(timeout=10)
        return publish_one()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(publish, range(8)))
    assert sum(results) == 4
    assert len(published) == len(set(published)) == 4
    with session_factory()() as db:
        assert db.scalar(select(func.sum(Outbox.publish_attempts))) == 4
