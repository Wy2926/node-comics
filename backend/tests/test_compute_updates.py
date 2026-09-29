"""Long polls deliver scoped changes without renewing or claiming any lease."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app.db import session_factory
from app.models import Job, now
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from app.scheduler import touch_job
from test_compute_v3 import v3, analyze, claim, request, text as complete_text  # noqa: F401
from test_notifications import wait_for_idle_subscriptions


def updates(v3, leases=(), *, can_claim=False, config_version=1, wait_seconds=0, revision=0,
            translations_revision=None):
    return request(v3, f'/nodes/{v3["node"]["node_id"]}/updates', {
        'revision': revision, 'wait_seconds': wait_seconds, 'config_version': config_version,
        'can_claim': can_claim, 'leases': [
            {'lease_id': lease['lease_id'], 'lease_token': lease['lease_token'],
             'translations_revision': translations_revision} for lease in leases]})


def translated_page(v3):
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    complete_text(lease)
    return lease


def test_updates_deliver_only_changed_text_without_renewing(v3):
    lease = translated_page(v3)
    with session_factory()() as db:
        expires = db.get(ExecutionLease, lease['lease_id']).expires_at
        heartbeat = db.get(ComputeNode, v3['node']['node_id']).heartbeat_at
        count = db.scalar(select(func.count()).select_from(ExecutionLease))
    response = updates(v3, [lease])
    assert response.status_code == 200, response.text
    reply = response.json()
    assert set(reply) == {'revision', 'claim_ready', 'leases'} and not reply['claim_ready']
    item = reply['leases'][0]
    assert set(item) == {'lease_id', 'status', 'translations'}
    assert item['status'] == 'active' and item['translations']['translations'] == {'0': 'Hello'}
    repeated = updates(v3, [lease], translations_revision=item['translations']['revision']).json()
    assert repeated['leases'] == []
    with session_factory()() as db:
        assert db.get(ExecutionLease, lease['lease_id']).expires_at == expires
        assert db.get(ComputeNode, v3['node']['node_id']).heartbeat_at == heartbeat
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == count


def test_updates_wake_for_text_without_a_heartbeat(v3):
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    with ThreadPoolExecutor(1) as executor:
        pending = executor.submit(updates, v3, [lease], wait_seconds=2)
        wait_for_idle_subscriptions(1)
        complete_text(lease)
        response = pending.result(timeout=1)
    assert response.status_code == 200, response.text
    assert response.json()['leases'][0]['translations']['translations'] == {'0': 'Hello'}


def test_updates_recheck_durable_text_after_notification_loss(v3, monkeypatch):
    from app import notifications
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    analyze(v3, lease)
    with ThreadPoolExecutor(1) as executor:
        pending = executor.submit(updates, v3, [lease], wait_seconds=1)
        wait_for_idle_subscriptions(1)
        monkeypatch.setattr(notifications, 'publish', lambda *_: None)
        complete_text(lease)
        response = pending.result(timeout=2)
    assert response.status_code == 200, response.text
    assert response.json()['leases'][0]['translations']['translations'] == {'0': 'Hello'}


def test_unrelated_queue_changes_keep_poll_waiting_and_release_connections(v3):
    jobs = v3['create'](2)
    lease = claim(v3).json()['leases'][0]
    unrelated = next(job for job in jobs if job != lease['job_id'])
    with ThreadPoolExecutor(1) as executor:
        pending = executor.submit(updates, v3, [lease], wait_seconds=1)
        wait_for_idle_subscriptions(1)
        with session_factory()() as db:
            touch_job(db, db.get(Job, unrelated))
            db.commit()
        wait_for_idle_subscriptions(1)
        assert not pending.done()
        response = pending.result(timeout=2)
    assert response.status_code == 200, response.text
    assert response.json()['leases'] == [] and not response.json()['claim_ready']


def test_concurrent_claim_reopens_poll_with_new_lease_snapshot(v3):
    v3['create']()
    with ThreadPoolExecutor(1) as executor:
        pending = executor.submit(updates, v3, wait_seconds=2)
        wait_for_idle_subscriptions(1)
        lease = claim(v3).json()['leases'][0]
        response = pending.result(timeout=1)
    assert response.status_code == 200, response.text
    assert response.json()['leases'] == [] and not response.json()['claim_ready']
    analyze(v3, lease)
    complete_text(lease)
    assert updates(v3, [lease]).json()['leases'][0]['translations']['translations'] == {'0': 'Hello'}


def test_queue_edge_refreshes_stale_backpressure_without_spinning_on_backlog(v3):
    with ThreadPoolExecutor(1) as executor:
        pending = executor.submit(updates, v3, can_claim=False, wait_seconds=2)
        wait_for_idle_subscriptions(1)
        # Local buffers can free after the subscription snapshot. Its immediate
        # claim sees no work; a subsequently ready page must refresh the poll.
        assert claim(v3).json()['leases'] == []
        jobs = v3['create']()
        response = pending.result(timeout=1)
        assert response.json()['leases'] == [] and not response.json()['claim_ready']
        # Backpressure may still apply. A stable ready queue must not cause an
        # immediate response on every resubscription or unrelated notification.
        pending = executor.submit(updates, v3, can_claim=False, wait_seconds=1)
        wait_for_idle_subscriptions(1)
        with session_factory()() as db:
            touch_job(db, db.get(Job, jobs[0]))
            db.commit()
        wait_for_idle_subscriptions(1)
        assert not pending.done()
        assert not pending.result(timeout=2).json()['claim_ready']
    assert updates(v3, can_claim=True).json()['claim_ready']
    assert len(claim(v3).json()['leases']) == 1


@pytest.mark.parametrize('stopped,code', [
    ('cancelled', 'LEASE_EXPIRED'), ('expired', 'LEASE_EXPIRED'),
    ('generation', 'LEASE_EXPIRED'), ('deadline', 'PAGE_DEADLINE_EXCEEDED')])
def test_updates_never_return_text_for_stopped_page(v3, stopped, code):
    lease = translated_page(v3)
    with session_factory()() as db:
        row = db.get(ExecutionLease, lease['lease_id'])
        if stopped == 'cancelled':
            db.get(Job, row.job_id).cancel_requested = True
        elif stopped == 'expired':
            row.expires_at = now() - timedelta(seconds=1)
        elif stopped == 'generation':
            db.get(JobStage, row.stage_id).generation += 1
        else:
            row.limits = {**row.limits, 'deadline_at': (now() - timedelta(seconds=1)).isoformat() + 'Z'}
        db.commit()
    response = updates(v3, [lease])
    assert response.status_code == 200, response.text
    assert response.json()['leases'] == [{'lease_id': lease['lease_id'], 'status': 'stop', 'code': code}]


def test_updates_reject_foreign_or_invalid_tokens_without_leaking_text(v3):
    lease = translated_page(v3)
    invalid = {**lease, 'lease_token': 'invalid'}
    reply = updates(v3, [invalid, lease]).json()['leases']
    assert reply[0] == {'lease_id': lease['lease_id'], 'status': 'stop', 'code': 'NODE_SCOPE_MISMATCH'}
    assert reply[1]['translations']['translations'] == {'0': 'Hello'}
    with session_factory()() as db:
        db.get(ExecutionLease, lease['lease_id']).node_id = 'control-text'
        db.commit()
    assert updates(v3, [lease]).json()['leases'] == [reply[0]]
    assert request(v3, '/nodes/another-node/updates', {
        'revision': 0, 'wait_seconds': 0, 'config_version': 1, 'can_claim': False, 'leases': []}).status_code == 403


def test_updates_replay_no_text_terminal_receipt(v3):
    v3['create']()
    lease = claim(v3).json()['leases'][0]
    _, accepted = analyze(v3, lease, empty=True)
    reply = updates(v3, [lease]).json()
    assert reply['leases'] == [accepted['receipt']]
    assert reply['leases'][0]['job_status'] == 'no_text'


def test_claim_hint_is_read_only_and_respects_capacity_config_and_local_backpressure(v3):
    v3['create'](5)
    with session_factory()() as db:
        before = db.scalar(select(func.count()).select_from(ExecutionLease))
    assert not updates(v3).json()['claim_ready']
    assert updates(v3, can_claim=True).json()['claim_ready']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == before
    leases = claim(v3, 4).json()['leases']
    assert len(leases) == 4
    assert not updates(v3, leases, can_claim=True).json()['claim_ready']
    with session_factory()() as db:
        node = db.get(ComputeNode, v3['node']['node_id'])
        node.config_version += 1
        node.enabled = False
        db.commit()
    reply = updates(v3, can_claim=True).json()
    assert reply['config']['version'] == 2 and not reply['config']['enabled']
    assert not reply['claim_ready']
    assert 'config' not in updates(v3, config_version=2).json()


def test_updates_lease_snapshot_is_bounded(v3):
    lease = {'lease_id': 'unknown', 'lease_token': 'unknown'}
    assert updates(v3, [lease] * 33).status_code == 422
