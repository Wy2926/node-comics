"""First-come multi-node claims, bounded contention recovery and identity fencing."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Lock

import pytest
from sqlalchemy import func, select, text

from app import compute_v3, dispatcher
from app.db import session_factory
from app.models import Job, now
from app.queue_models import ComputeClaim, ComputeNode, ExecutionLease, JobStage
from test_compute_v3 import PREFIX, analyze, claim, heartbeat, request, read_input, v3
from test_node_management import provision


def peer(v3, resource='peer:gpu:0', *, language='en'):
    node, auth, admin = provision(v3['client'], resource)
    registration = {**v3['registration'], 'resource_id': resource, 'supported_languages': [language]}
    response = v3['client'].post(PREFIX + '/nodes/register', headers=auth, json=registration)
    assert response.status_code == 200, response.text
    return {**v3, 'node': node, 'auth': auth, 'admin': admin, 'registration': registration}


def test_nodes_claim_first_come_with_independent_capacity_and_receipts(v3):
    other = peer(v3)
    jobs = set(v3['create'](6))
    # Both nodes may use the same local request ID; each owns its own receipt.
    first = claim(v3, 32, 'same-local-id').json()['leases']
    second = claim(other, 32, 'same-local-id').json()['leases']
    assert len(first) == 4 and len(second) == 1
    assert len({item['job_id'] for item in first + second}) == 5
    assert {item['job_id'] for item in first + second} < jobs
    assert claim(v3).json()['leases'] == [] and claim(other).json()['leases'] == []
    analyze(other, second[0], empty=True)
    assert len(claim(other).json()['leases']) == 1
    assert [item['lease_id'] for item in claim(v3, 32, 'same-local-id').json()['leases']] == [item['lease_id'] for item in first]
    assert claim(other, 32, 'same-local-id').json()['leases'][0]['status'] == 'terminal'


def test_three_simultaneous_nodes_fill_slots_despite_shared_candidates(v3, monkeypatch):
    nodes = [v3, peer(v3), peer(v3, 'third:gpu:0')]
    jobs = set(v3['create'](6))
    barrier, guard = Barrier(3), Lock()
    calls = {}
    original = compute_v3.prepare_claim_candidates
    def prepare(db, node_id, *args, **kwargs):
        prepared = original(db, node_id, *args, **kwargs)
        with guard:
            calls[node_id] = calls.get(node_id, 0) + 1
            first = calls[node_id] == 1
        if first:
            barrier.wait(timeout=10)
        return prepared
    monkeypatch.setattr(compute_v3, 'prepare_claim_candidates', prepare)
    with ThreadPoolExecutor(max_workers=3) as pool:
        replies = list(pool.map(lambda node: claim(node, 1, 'race'), nodes))
    assert all(reply.status_code == 200 for reply in replies), [reply.text for reply in replies]
    leases = [item for reply in replies for item in reply.json()['leases']]
    assert len(leases) == len({item['job_id'] for item in leases}) == 3
    assert {item['job_id'] for item in leases} < jobs
    assert sorted(calls.values()) == [1, 1, 2]


def test_idle_queue_has_one_election_and_repeated_invalidations_are_bounded(v3, monkeypatch):
    calls = []
    original = compute_v3.prepare_claim_candidates
    def prepare(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(compute_v3, 'prepare_claim_candidates', prepare)
    assert claim(v3).json()['leases'] == []
    assert len(calls) == 1
    calls.clear()
    v3['create'](3)
    def stale(*args, **kwargs):
        prepared = prepare(*args, **kwargs)
        with session_factory()() as db:
            for stage in db.scalars(select(JobStage).where(JobStage.id.in_(prepared.signatures))):
                stage.generation += 1
            db.commit()
        return prepared
    monkeypatch.setattr(compute_v3, 'prepare_claim_candidates', stale)
    response = claim(v3, 1, 'retry')
    assert response.status_code == 200, response.text
    assert response.json()['leases'] == [] and .1 <= response.json()['retry_after_seconds'] <= .3
    assert len(calls) == 2
    with session_factory()() as db:
        assert db.get(ComputeClaim, (v3['node']['node_id'], 'retry')).lease_ids == []


def test_retry_preserves_missing_source_cleanup_and_releases_quota_once(v3):
    from app.models import Asset, Ledger
    from app.storage import LocalStore
    from app.upload_models import UploadReservation
    from app.uploads import expire_uploads
    missing, valid = v3['create'](2)
    with session_factory()() as db:
        source = db.get(Asset, db.get(Job, missing).input_asset_id)
        LocalStore().delete(source.storage_key)
    response = claim(v3, 1, 'retire-missing')
    assert response.status_code == 200, response.text
    assert [item['job_id'] for item in response.json()['leases']] == [valid]
    assert claim(v3, 1, 'retire-missing').json()['leases'][0]['lease_id'] == response.json()['leases'][0]['lease_id']
    with session_factory()() as db:
        assert db.get(Job, missing).status == 'awaiting_upload'
        assert db.scalar(select(func.count()).select_from(Ledger).where(
            Ledger.job_id == missing, Ledger.kind == 'release')) == 0
        pending = db.scalar(select(UploadReservation).where(UploadReservation.job_id == missing))
        pending.expires_at = now() - timedelta(seconds=1)
        db.commit()
    for _ in range(2):
        with session_factory()() as db:
            expire_uploads(db)
            db.commit()
    with session_factory()() as db:
        assert db.get(Job, missing).status == 'failed'
        assert db.scalar(select(func.count()).select_from(Ledger).where(
            Ledger.job_id == missing, Ledger.kind == 'release')) == 1


def exhaust_first_snapshot(v3, other, monkeypatch, before_retry=None):
    original = compute_v3.prepare_claim_candidates
    calls = []
    def prepare(db, node_id, *args, **kwargs):
        prepared = original(db, node_id, *args, **kwargs)
        if node_id != v3['node']['node_id']:
            return prepared
        calls.append(prepared)
        if len(calls) == 1:
            # Count 1 elects one head per owner plus one fairness-floor owner.
            for _ in range(2):
                lease = claim(other).json()['leases'][0]
                analyze(other, lease, empty=True)
        elif len(calls) == 2:
            assert db.get(ComputeClaim, (node_id, 'retry')) is None
            assert db.scalar(select(func.count()).select_from(ExecutionLease).where(ExecutionLease.node_id == node_id)) == 0
            if db.get_bind().dialect.name == 'postgresql':
                with session_factory()() as probe:
                    assert probe.scalar(text('SELECT pg_try_advisory_xact_lock(761349211)'))
                    probe.rollback()
            if before_retry:
                before_retry()
        return prepared
    monkeypatch.setattr(compute_v3, 'prepare_claim_candidates', prepare)
    return calls


@pytest.mark.parametrize('mutation', ['none', 'disabled', 'configuration', 'cancelled', 'duplicate', 'conflict'])
def test_retry_releases_lock_and_rechecks_current_receipt_and_policy(v3, monkeypatch, mutation):
    other = peer(v3)
    v3['create'](6)
    competing = []
    def change():
        if mutation in {'duplicate', 'conflict'}:
            competing.append(claim(v3, 1 if mutation == 'duplicate' else 2, 'retry'))
            assert competing[0].status_code == 200
            return
        with session_factory()() as db:
            if mutation == 'disabled':
                db.get(ComputeNode, v3['node']['node_id']).enabled = False
            elif mutation == 'configuration':
                db.get(ComputeNode, v3['node']['node_id']).config_version += 1
            elif mutation == 'cancelled':
                for job in db.scalars(select(Job).where(Job.status == 'queued')):
                    job.cancel_requested = True
            db.commit()
    calls = exhaust_first_snapshot(v3, other, monkeypatch, change)
    response = claim(v3, 1, 'retry')
    if mutation in {'configuration', 'conflict'}:
        assert response.status_code == 409, response.text
    else:
        assert response.status_code == 200, response.text
        leases = response.json()['leases']
        assert len(leases) == (0 if mutation in {'disabled', 'cancelled'} else 1)
        if mutation == 'duplicate':
            assert leases[0]['lease_id'] == competing[0].json()['leases'][0]['lease_id']
    assert len(calls) == (3 if competing else 2)
    with session_factory()() as db:
        saved = db.get(ComputeClaim, (v3['node']['node_id'], 'retry'))
        if mutation == 'configuration':
            assert saved is None
        else:
            expected = competing[0].json()['leases'] if competing else response.json()['leases']
            assert saved.lease_ids == [item['lease_id'] for item in expected]
            assert db.scalar(select(func.count()).select_from(ExecutionLease)
                .where(ExecutionLease.node_id == v3['node']['node_id'])) == len(expected)


def test_idle_or_incompatible_peer_never_reserves_work(v3):
    other = peer(v3, language='ja')
    v3['create'](3)
    assert claim(other).json()['leases'] == []
    leases = claim(v3, 4).json()['leases']
    assert len(leases) == 3
    assert read_input(other, leases[0]).status_code == 403


def test_lost_node_work_recovers_on_peer_and_old_lease_cannot_publish(v3):
    other = peer(v3)
    v3['create']()
    first = claim(v3).json()['leases'][0]
    with session_factory()() as db:
        db.get(ExecutionLease, first['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.get(ComputeNode, v3['node']['node_id']).heartbeat_at = now() - timedelta(hours=1)
        db.commit()
    dispatcher.recover_lease(first['lease_id'])
    dispatcher.recover_lease(first['lease_id'])
    with session_factory()() as db:
        stage = db.get(JobStage, db.get(ExecutionLease, first['lease_id']).stage_id)
        stage.available_at = now() - timedelta(seconds=1)
        db.commit()
    second = claim(other).json()['leases'][0]
    assert second['job_id'] == first['job_id'] and second['generation'] == first['generation'] + 1
    assert heartbeat(v3, [first]).json()['leases'][0]['status'] == 'terminal'
    response = read_input(v3, first)
    assert response.status_code == 409
    analyze(other, second, empty=True)
    with session_factory()() as db:
        from app.models import Ledger
        assert db.get(Job, first['job_id']).status == 'no_text'
        assert db.scalar(select(func.count()).select_from(Ledger).where(
            Ledger.job_id == first['job_id'], Ledger.kind == 'release')) == 1
