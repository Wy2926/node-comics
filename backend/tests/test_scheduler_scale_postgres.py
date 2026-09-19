"""Opt-in, isolated SQL election timing, without model or object-store calls."""
import json
import os
from pathlib import Path
from statistics import median
from time import perf_counter

import pytest
from sqlalchemy import event, insert, text

from app import scheduler
from app.db import engine, session_factory
from app.models import Asset, Job, User, now
from app.queue_models import JobStage, UserModeQueue
from test_classic_parallel_postgres import text_database
from test_cluster_scheduler import scheduler_case, claim, finish_quantum

pytestmark = pytest.mark.skipif(os.environ.get("RUN_SCHEDULER_SCALE") != "1",
    reason="Opt-in isolated PostgreSQL scheduling load measurement")


def test_large_queue_lock_duration(scheduler_case, monkeypatch):
    count = int(os.environ.get("SCHEDULER_SCALE_PAGES", "50000"))
    owners = (count + 499) // 500
    at = now()
    with session_factory()() as db:
        db.execute(insert(User), [{"id": f"scale-user-{i}", "subject": f"scale:{i}", "name": "scale"} for i in range(owners)])
        db.execute(insert(Asset), [{"id": f"scale-source-{i}", "owner_id": f"scale-user-{i}", "sha256": "a" * 64,
            "storage_key": f"scale/{i}", "storage_backend": "r2", "mime": "image/png", "width": 80, "height": 64, "byte_size": 100} for i in range(owners)])
        db.execute(insert(UserModeQueue), [{"owner_id": f"scale-user-{i}", "mode": "classic"} for i in range(owners)])
        for start in range(0, count, 1000):
            indexes = range(start, min(count, start + 1000))
            db.execute(insert(Job), [{"id": f"scale-job-{i}", "owner_id": f"scale-user-{i // 500}",
                "input_asset_id": f"scale-source-{i // 500}", "source_sha256": "a" * 64, "mode": "classic",
                "target_language": "zh-Hans", "status": "queued", "quota_pages": 0, "quota_kind": "unlimited",
                "settlement": "free", "config": scheduler_case, "operation": "submission", "request_hash": "a" * 64,
                "idempotency_key": str(i), "cache_key": f"{i:064x}", "created_at": at} for i in indexes])
            db.execute(insert(JobStage), [{"id": f"scale-stage-{i}", "job_id": f"scale-job-{i}", "name": "page", "status": "ready"} for i in indexes])
        db.commit()
        db.execute(text("ANALYZE"))
        db.commit()
    lock = scheduler.lock_scheduler
    acquired = []
    def measured_lock(db):
        lock(db)
        acquired.append(perf_counter())
    monkeypatch.setattr(scheduler, "lock_scheduler", measured_lock)
    durations, loads = [], []
    loaded = []
    def capture(job, context):
        loaded.append(job.id)
    event.listen(Job, "load", capture)
    try:
        for _ in range(12):
            acquired.clear()
            loaded.clear()
            lease = claim()
            durations.append(perf_counter() - acquired[0])
            loads.append(len(loaded))
            assert lease is not None
            finish_quantum(lease.id, rearm=False)
    finally:
        event.remove(Job, "load", capture)
    report = {"pages": count, "owners": owners, "claims": len(durations), "lock_median_seconds": round(median(durations), 4),
        "lock_max_seconds": round(max(durations), 4), "max_loaded_jobs": max(loads), "database": "isolated PostgreSQL"}
    print(json.dumps(report))
    if os.environ.get("SCHEDULER_SCALE_REPORT"):
        Path(os.environ["SCHEDULER_SCALE_REPORT"]).write_text(json.dumps(report, indent=2), encoding="utf-8")
    assert max(loads) <= 2
