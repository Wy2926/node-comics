"""Withdrawn UUIDs expose a private terminal verdict, never historical artifacts."""
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import event

from app.db import engine, session_factory
from app.models import Attempt, Job, Ledger, TextCall, now
from app.translation_requests import TranslationRequest
from conftest import login


def withdrawn(client, auth, *, status='succeeded', cost='reported', called=True,
              attempt=True, complete=True, settlement='settled', revoked=True):
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    key = str(uuid4())
    with session_factory()() as db:
        job = Job(id=str(uuid4()), owner_id=owner, source_sha256='a' * 64, mode='redraw',
            target_language='en', status=status, phase=status, idempotency_key=key,
            operation='translation', request_hash='b' * 64, cache_key=key, config={},
            quota_pages=1, quota_kind='redraw', settlement=settlement,
            completed_at=now() if complete else None)
        db.add(job)
        db.flush()
        if attempt:
            call = Attempt(job_id=job.id, provider_id='test', lease_expires_at=now(),
                call_started_at=now() if called else None, completed_at=now() if complete else None,
                cost_state=cost)
            db.add(call)
            db.flush()
            job.attempt_id = call.id
        row = TranslationRequest(owner_id=owner, id=key, job_id=job.id,
            request_hash='b' * 64, revoked_at=now() if revoked else None,
            descriptor={'mode': 'redraw', 'target_language': 'en', 'image': {'sha256': 'a' * 64}})
        db.add(row)
        db.commit()
        return key, job.id, owner


@pytest.mark.parametrize('values,resolved', [
    ({'status': 'succeeded'}, True),
    ({'status': 'failed', 'settlement': 'released'}, True),
    ({'status': 'cancelled', 'called': False, 'cost': 'unknown', 'settlement': 'released'}, True),
    ({'status': 'cancelled', 'attempt': False, 'settlement': 'released'}, True),
    ({'status': 'no_text', 'attempt': False, 'settlement': 'released'}, True),
    ({'status': 'outcome_unknown', 'cost': 'unknown'}, False),
    ({'status': 'unknown_released', 'settlement': 'released'}, False),
    ({'status': 'running'}, False),
    ({'cost': 'unknown'}, False),
    ({'status': 'cancelled', 'cost': 'unknown', 'settlement': 'released'}, False),
    ({'attempt': False}, False),
    ({'complete': False}, False),
    ({'settlement': 'reserved'}, False),
])
def test_withdrawn_verdict_requires_terminal_verified_execution(client, values, resolved):
    auth = login(client)
    key, _, _ = withdrawn(client, auth, **values)
    path = '/v1/translations/' + key
    response = client.get(path, headers=auth)
    assert response.status_code == 200
    body = response.json()
    assert body['state'] == 'failed' and body['error']['code'] == 'TRANSLATION_UNAVAILABLE'
    assert body['execution_resolved'] is resolved and body['result'] is None
    assert client.get(path + '/result', headers=auth).status_code == 410
    assert client.get(path, headers=login(client, 'other')).status_code == 404


@pytest.mark.parametrize('cost,completed,resolved', [('estimated', True, True),
    ('unknown', True, False), ('estimated', False, False)])
def test_text_call_evidence_is_checked_even_for_terminal_jobs(client, cost, completed, resolved):
    auth = login(client)
    key, job_id, _ = withdrawn(client, auth, called=False)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        db.add(TextCall(job_id=job_id, attempt_id=job.attempt_id, provider_id='text', model='test',
            group_index=0, sequence=1, reserved_micros=1, accounted_micros=1, cost_state=cost,
            completed_at=now() if completed else None))
        db.commit()
    assert client.get('/v1/translations/' + key, headers=auth).json()['execution_resolved'] is resolved


@pytest.mark.parametrize('key_suffix,kind,resolved', [('reconcile', 'reconcile', True),
    ('unrelated', 'reconcile', False), ('reconcile', 'release', False)])
def test_only_exact_reconciliation_receipt_confirms_unknown_image_call(client, key_suffix, kind, resolved):
    auth = login(client)
    key, job_id, owner = withdrawn(client, auth, status='failed', cost='unknown', settlement='released')
    with session_factory()() as db:
        db.add(Ledger(owner_id=owner, job_id=job_id, transaction_key=job_id + ':' + key_suffix,
            kind=kind, amount=0, note='verified provider outcome'))
        db.commit()
    assert client.get('/v1/translations/' + key, headers=auth).json()['execution_resolved'] is resolved


def test_live_execution_is_not_resolved_by_terminal_status_or_reconciliation(client):
    from app.queue_models import ExecutionLease, JobStage
    from conftest import control_node
    auth = login(client)
    key, job_id, owner = withdrawn(client, auth, status='cancelled', settlement='released')
    with session_factory()() as db:
        node_id = control_node(db)
        stage = JobStage(job_id=job_id, name='redraw', status='running')
        db.add(stage)
        db.flush()
        db.add(ExecutionLease(stage_id=stage.id, job_id=job_id, node_id=node_id, owner_id=owner,
            generation=0, resource_pool='redraw', mode='redraw',
            expires_at=now() + timedelta(seconds=60)))
        db.add(Ledger(owner_id=owner, job_id=job_id, transaction_key=job_id + ':reconcile',
            kind='reconcile', amount=0))
        db.commit()
    assert client.get('/v1/translations/' + key, headers=auth).json()['execution_resolved'] is False


def test_batch_history_and_events_share_one_bounded_evidence_query(client):
    auth = login(client)
    keys = [withdrawn(client, auth, status='failed', settlement='released')[0] for _ in range(8)]
    statements = []
    def capture(conn, cursor, statement, *args):
        statements.append(statement.lower())
    event.listen(engine(), 'before_cursor_execute', capture)
    try:
        batch = client.get('/v1/translations', headers=auth, params={'ids': ','.join(keys)})
    finally:
        event.remove(engine(), 'before_cursor_execute', capture)
    assert all(item['execution_resolved'] for item in batch.json()['items'])
    assert len([sql for sql in statements if 'from attempts' in sql]) == 1
    history = client.get('/v1/translations', headers=auth).json()
    assert all(item['execution_resolved'] for item in history['items'])
    events = client.get('/v1/translations/events', headers=auth, params={'ids': ','.join(keys)})
    assert events.status_code == 200 and events.text.count('"execution_resolved":true') == len(keys)


def test_live_snapshots_skip_evidence_queries_and_tombstones_do_not_read_other_jobs(client):
    auth = login(client)
    key, job_id, owner = withdrawn(client, auth, revoked=False)
    statements = []
    def capture(conn, cursor, statement, *args):
        statements.append(statement.lower())
    event.listen(engine(), 'before_cursor_execute', capture)
    try:
        assert client.get('/v1/translations/' + key, headers=auth).json()['execution_resolved'] is False
        with session_factory()() as db:
            row = db.get(TranslationRequest, (owner, key))
            row.revoked_at, row.job_id, row.legacy_execution_resolved = now(), None, True
            db.commit()
        assert client.get('/v1/translations/' + key, headers=auth).json()['execution_resolved'] is True
    finally:
        event.remove(engine(), 'before_cursor_execute', capture)
    assert not any('from attempts' in sql or 'from text_calls' in sql or 'from usage_ledger' in sql for sql in statements)
    with session_factory()() as db:
        assert db.get(Job, job_id).owner_id == owner
