"""Fast claim paths skip election without weakening durable receipts or fencing."""
from sqlalchemy import select

from app import compute_v3, scheduler
from app.db import session_factory
from app.models import Job
from app.queue_models import ComputeClaim, ComputeNode
from test_compute_v3 import claim, v3
from test_compute_multinode import peer, exhaust_first_snapshot


def no_election(*args, **kwargs):
    raise AssertionError('This path must not rank the task queue')


def test_full_node_and_replay_do_not_rank_the_queue(v3, monkeypatch):
    v3['create'](8)
    first = claim(v3, 4, 'saved').json()['leases']
    assert len(first) == 4
    lease_ids = [lease['lease_id'] for lease in first]
    monkeypatch.setattr(scheduler, '_election_rows', no_election)
    assert [lease['lease_id'] for lease in claim(v3, 4, 'saved').json()['leases']] == lease_ids
    assert claim(v3, 3, 'saved').status_code == 409
    assert claim(v3, 4, 'full').json()['leases'] == []
    with session_factory()() as db:
        assert db.get(ComputeClaim, (v3['node']['node_id'], 'full')).lease_ids == []
        node = db.get(ComputeNode, v3['node']['node_id'])
        node.enabled, node.config_version = False, 2
        db.commit()
    assert [lease['lease_id'] for lease in claim(v3, 4, 'saved').json()['leases']] == lease_ids
    assert claim(v3, 4, 'old-version').status_code == 409


def test_empty_replay_only_probes_existence_and_retry_hint_is_jittered(v3, monkeypatch):
    assert claim(v3, 4, 'empty').json()['leases'] == []
    v3['create'](4)
    monkeypatch.setattr(scheduler, '_election_rows', no_election)
    def jitter(lower, upper):
        assert (lower, upper) == (.1, .3)
        return .237
    monkeypatch.setattr(compute_v3.random, 'uniform', jitter)
    reply = claim(v3, 4, 'empty').json()
    assert reply['leases'] == [] and reply['retry_after_seconds'] == .237


def test_capacity_shrink_after_preparation_does_not_trigger_reselection(v3, monkeypatch):
    v3['create'](6)
    assert len(claim(v3).json()['leases']) == 1
    calls = []
    original = compute_v3.prepare_claim_candidates
    def prepare(*args, **kwargs):
        prepared = original(*args, **kwargs)
        assert prepared.signatures
        calls.append(prepared)
        with session_factory()() as db:
            db.get(ComputeNode, v3['node']['node_id']).capacity = 1
            db.commit()
        return prepared
    monkeypatch.setattr(compute_v3, 'prepare_claim_candidates', prepare)
    assert claim(v3, 4, 'shrunk').json()['leases'] == []
    assert len(calls) == 1


def test_exhausted_queue_does_not_run_a_second_election(v3, monkeypatch):
    other = peer(v3)
    v3['create'](2)
    calls = exhaust_first_snapshot(v3, other, monkeypatch)
    response = claim(v3, 1, 'retry')
    assert response.status_code == 200, response.text
    assert response.json()['leases'] == [] and 'retry_after_seconds' not in response.json()
    assert len(calls) == 1
    with session_factory()() as db:
        assert db.get(ComputeClaim, (v3['node']['node_id'], 'retry')).lease_ids == []
        assert all(job.status == 'no_text' for job in db.scalars(select(Job)))
