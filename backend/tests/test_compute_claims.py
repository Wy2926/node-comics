"""Claim receipt concurrency across the lock-free preparation boundary."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier

import pytest
from sqlalchemy import func, select, text

from app import compute_v2, scheduler
from app.db import session_factory
from app.models import Job
from app.providers import digest
from app.queue_models import ComputeClaim, ComputeNode, ExecutionLease
from test_compute_v2 import claim, v2  # noqa: F401


def capacity(v2, size):
    with session_factory()() as db:
        node = db.get(ComputeNode, v2['node']['node_id'])
        node.capacity = size
        node.desired_config = {**node.desired_config, 'execution_slots': size}
        db.commit()


def synchronized_preparation(monkeypatch, participants):
    barrier = Barrier(participants)
    original = compute_v2.prepare_claim_candidates
    def prepare(*args, **kwargs):
        snapshot = original(*args, **kwargs)
        barrier.wait(timeout=10)
        return snapshot
    monkeypatch.setattr(compute_v2, 'prepare_claim_candidates', prepare)


def test_same_claim_receipt_concurrent_retries_allocate_one_batch(v2, monkeypatch):
    v2['create'](12)
    capacity(v2, 12)
    synchronized_preparation(monkeypatch, 3)
    with ThreadPoolExecutor(max_workers=3) as pool:
        replies = list(pool.map(lambda _: claim(v2, 4, 'shared-receipt'), range(3)))
    assert all(reply.status_code == 200 for reply in replies), [reply.text for reply in replies]
    batches = [[lease['lease_id'] for lease in reply.json()['leases']] for reply in replies]
    assert len(batches[0]) == 4 and batches[0] == batches[1] == batches[2]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == 4
        receipts = db.scalars(select(ComputeClaim)).all()
        assert len(receipts) == 1 and receipts[0].lease_ids == batches[0]


def test_same_claim_id_with_concurrent_changed_count_conflicts(v2, monkeypatch):
    v2['create'](8)
    capacity(v2, 8)
    synchronized_preparation(monkeypatch, 2)
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(lambda count: claim(v2, count, 'conflicting-receipt'), [3, 4]))
    assert sorted(reply.status_code for reply in replies) == [200, 409]
    winner = next(reply.json() for reply in replies if reply.status_code == 200)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == len(winner['leases'])
        assert db.scalar(select(func.count()).select_from(ComputeClaim)) == 1


def test_legacy_count32_is_bounded_and_receipt_replays_after_configuration_change(v2):
    v2['create'](12)
    capacity(v2, 12)
    first = claim(v2, 32, 'legacy-journal')
    assert first.status_code == 200, first.text
    leases = first.json()['leases']
    assert len(leases) == 4
    with session_factory()() as db:
        node = db.get(ComputeNode, v2['node']['node_id'])
        node.config_version += 1
        node.enabled = False
        db.commit()
    replay = claim(v2, 32, 'legacy-journal')
    assert replay.status_code == 200, replay.text
    assert [lease['lease_id'] for lease in replay.json()['leases']] == [lease['lease_id'] for lease in leases]
    assert claim(v2, 4, 'legacy-journal').status_code == 409
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == 4


def test_historical_wide_claim_receipt_replays_every_lease(v2):
    v2['create'](12)
    capacity(v2, 12)
    leases = claim(v2, 4).json()['leases'] + claim(v2, 4).json()['leases']
    assert len(leases) == 8
    body = {'request_id': 'historical-wide', 'config_version': 1, 'count': 32}
    with session_factory()() as db:
        # Simulate a pre-upgrade receipt. Its exact lease set is durable, even
        # though the new scheduler grants at most four leases to a new request.
        db.add(ComputeClaim(node_id=v2['node']['node_id'], request_id=body['request_id'],
            request_hash=digest(body), lease_ids=[lease['lease_id'] for lease in leases]))
        db.commit()
    response = claim(v2, 32, body['request_id'])
    assert response.status_code == 200, response.text
    assert [lease['lease_id'] for lease in response.json()['leases']] == [lease['lease_id'] for lease in leases]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == 8


def test_empty_prepared_claim_rechecks_after_commit_and_hints_bounded_retry(v2, monkeypatch):
    v2['create'](4)
    request_sessions = []
    original_prepare = compute_v2.prepare_claim_candidates
    original_ready = compute_v2.has_claimable_work
    def stale(db, *args, **kwargs):
        request_sessions.append(db)
        return replace(original_prepare(db, *args, **kwargs), signatures={})
    def ready(db, *args, **kwargs):
        assert db is not request_sessions[0] and not request_sessions[0].in_transaction()
        saved = db.get(ComputeClaim, (v2['node']['node_id'], 'stale-empty'))
        assert saved is not None and saved.lease_ids == []
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == 0
        if db.get_bind().dialect.name == 'postgresql':
            with session_factory()() as probe:
                assert probe.scalar(text('SELECT pg_try_advisory_xact_lock(761349211)'))
                probe.rollback()
        return original_ready(db, *args, **kwargs)
    monkeypatch.setattr(compute_v2, 'prepare_claim_candidates', stale)
    monkeypatch.setattr(compute_v2, 'has_claimable_work', ready)
    reply = claim(v2, 4, 'stale-empty')
    assert reply.status_code == 200, reply.text
    assert reply.json()['leases'] == [] and .1 <= reply.json()['retry_after_seconds'] <= .3


def test_empty_receipt_retry_hint_is_dynamic_and_does_not_allocate(v2):
    empty = claim(v2, 4, 'empty-receipt')
    assert empty.status_code == 200 and empty.json()['leases'] == []
    assert 'retry_after_seconds' not in empty.json()
    v2['create'](4)
    replay = claim(v2, 4, 'empty-receipt')
    assert replay.status_code == 200 and replay.json()['leases'] == []
    assert .1 <= replay.json()['retry_after_seconds'] <= .3
    with session_factory()() as db:
        assert db.get(ComputeClaim, (v2['node']['node_id'], 'empty-receipt')).lease_ids == []
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == 0
    granted = claim(v2, 4)
    assert len(granted.json()['leases']) == 4 and 'retry_after_seconds' not in granted.json()
    full = claim(v2, 4, 'empty-receipt')
    assert full.json()['leases'] == [] and 'retry_after_seconds' not in full.json()


@pytest.mark.parametrize('mutation', ['configuration', 'cancel_and_shrink'])
def test_prepared_claim_rechecks_intervening_changes(v2, monkeypatch, mutation):
    jobs = v2['create'](8)
    capacity(v2, 8)
    original = compute_v2.prepare_claim_candidates
    def prepare(*args, **kwargs):
        snapshot = original(*args, **kwargs)
        with session_factory()() as writer:
            scheduler.lock_scheduler(writer)
            node = writer.get(ComputeNode, v2['node']['node_id'])
            node.capacity = 1
            node.desired_config = {**node.desired_config, 'execution_slots': 1}
            if mutation == 'configuration':
                node.config_version += 1
            else:
                job = writer.get(Job, jobs[0])
                job.cancel_requested = True
                scheduler.touch_job(writer, job)
            writer.commit()
        return snapshot
    monkeypatch.setattr(compute_v2, 'prepare_claim_candidates', prepare)
    reply = claim(v2, 4, 'prepared-change')
    if mutation == 'configuration':
        assert reply.status_code == 409, reply.text
        expected = 0
    else:
        assert reply.status_code == 200, reply.text
        leases = reply.json()['leases']
        assert len(leases) == 1 and leases[0]['job_id'] != jobs[0]
        expected = 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == expected
        assert db.scalar(select(func.count()).select_from(ComputeClaim)) == expected
