"""Operator reconciliation and document monitoring; synthetic OCR/LLM/R2 only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from app.adapters.llm import TextError, TextResponse
from app.admin_audit import AdminAudit
from app.config import settings
from app.db import session_factory
from app.documents import text, workflow
from app.documents.models import Document, DocumentQuotaAllocation
from app.entitlement_models import QuotaPeriod
from app.models import Attempt, Job, Ledger, TextCall, User, now, uid
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from conftest import login
from test_document_quota_api import document_case  # dependency of flow
from test_document_workflow import claim, flow, gpu_done, llm_reply, ocr_all


@pytest.fixture
def unknown(flow, monkeypatch):
    invoked = []
    def interrupted(*args, **kwargs):
        invoked.append(True)
        raise TextError('TEXT_TRANSPORT_FAILED', 'isolated unknown response', retryable=True)
    monkeypatch.setattr(text, 'call_messages', interrupted)
    ocr_all(flow)
    lease = claim()
    with pytest.raises(TextError) as error:
        text.run_text_stage(flow.job_id, lease.id)
    workflow.fail_lease(lease.id, error.value)
    with session_factory()() as db:
        document = db.get(Document, flow.job_id)
        call = db.get(TextCall, document.text_call_id)
        assert db.get(Job, flow.job_id).status == 'outcome_unknown'
        assert db.get(QuotaPeriod, flow.period_id).reserved == 3
    return SimpleNamespace(flow=flow, client=flow.case.client, lease=lease, call=call, invoked=invoked,
        auth=login(flow.case.client, settings().dev_admin_username),
        path=f'/v1/admin/documents/{flow.job_id}/resolve-unknown', body={
            'call_id': call.id, 'confirmed_no_deliverable_result': True,
            'note': '已核对供应商原调用与R2留存，确认无可交付结果'})


def assert_reserved(case):
    with session_factory()() as db:
        assert db.get(Job, case.flow.job_id).status == 'outcome_unknown'
        assert db.get(QuotaPeriod, case.flow.period_id).reserved == 3
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(
            AdminAudit.action == 'document.resolve_unknown')) == 0


def test_unknown_resolution_requires_admin(unknown):
    assert unknown.client.post(unknown.path, json=unknown.body).status_code == 401
    assert unknown.client.post(unknown.path, headers=unknown.flow.case.auth, json=unknown.body).status_code == 403
    assert_reserved(unknown)


@pytest.mark.parametrize('mismatch', ['missing', 'stale', 'foreign'])
def test_unknown_resolution_matches_exact_document_call(unknown, mismatch):
    call_id = uid()
    if mismatch != 'missing':
        with session_factory()() as db:
            job_id, attempt_id = unknown.flow.job_id, unknown.call.attempt_id
            if mismatch == 'foreign':
                foreign = seed_job(db, unknown.flow.case.owner, 'document', 'outcome_unknown')
                attempt = Attempt(job_id=foreign.id, provider_id=unknown.call.provider_id, lease_expires_at=now())
                db.add(attempt)
                db.flush()
                job_id, attempt_id = foreign.id, attempt.id
            db.add(TextCall(id=call_id, job_id=job_id, attempt_id=attempt_id, group_index=0, sequence=2,
                provider_id=unknown.call.provider_id, model=unknown.call.model,
                reserved_micros=1, accounted_micros=1, cost_state='unknown'))
            db.flush()
            if mismatch == 'foreign':
                # Even a corrupted pointer cannot authorize another job's call.
                db.get(Document, unknown.flow.job_id).text_call_id = call_id
            db.commit()
    response = unknown.client.post(unknown.path, headers=unknown.auth, json={**unknown.body, 'call_id': call_id})
    assert response.status_code == 409, response.text
    assert response.json()['error']['code'] == 'DOCUMENT_CALL_MISMATCH'
    assert_reserved(unknown)


@pytest.mark.parametrize('expired', [False, True])
def test_unknown_resolution_refuses_unclosed_execution_even_after_expiry(unknown, expired):
    with session_factory()() as db:
        lease = db.get(ExecutionLease, unknown.lease.id)
        lease.completed_at = None
        lease.expires_at = now() + timedelta(minutes=-10 if expired else 10)
        db.commit()
    response = unknown.client.post(unknown.path, headers=unknown.auth, json=unknown.body)
    assert response.status_code == 409 and response.json()['error']['code'] == 'DOCUMENT_EXECUTION_ACTIVE'
    assert_reserved(unknown)


def test_unknown_resolution_requires_explicit_confirmation_and_current_unknown_state(unknown):
    response = unknown.client.post(unknown.path, headers=unknown.auth,
        json={**unknown.body, 'confirmed_no_deliverable_result': False})
    assert response.status_code == 409 and response.json()['error']['code'] == 'DOCUMENT_RECONCILIATION_REQUIRED'
    with session_factory()() as db:
        db.get(Document, unknown.flow.job_id).text_state = 'received'
        db.commit()
    assert unknown.client.post(unknown.path, headers=unknown.auth, json=unknown.body).status_code == 409
    assert_reserved(unknown)


@pytest.mark.parametrize('change', [{'note': '短'}, {'accounted_micros': -1}, {'accounted_micros': True}])
def test_unknown_resolution_rejects_invalid_operator_evidence(unknown, change):
    assert unknown.client.post(unknown.path, headers=unknown.auth, json={**unknown.body, **change}).status_code == 422
    assert_reserved(unknown)


@pytest.mark.parametrize('accounted', [None, 12345])
def test_confirmed_failure_releases_once_and_audits_without_recalling_llm(unknown, accounted):
    body = {**unknown.body, **({'accounted_micros': accounted} if accounted is not None else {})}
    response = unknown.client.post(unknown.path, headers=unknown.auth, json=body)
    assert response.status_code == 200, response.text
    assert response.json() == {'id': unknown.flow.job_id, 'status': 'failed'}
    # Replays cannot revise supplier cost or add another release/audit event.
    replay = unknown.client.post(unknown.path, headers=unknown.auth, json={**body, 'accounted_micros': 99999})
    assert replay.status_code == 200 and replay.json() == response.json()
    assert unknown.client.post(unknown.path, headers=unknown.auth, json={**body, 'call_id': uid()}).status_code == 409
    with session_factory()() as db:
        job, doc = db.get(Job, unknown.flow.job_id), db.get(Document, unknown.flow.job_id)
        assert job.settlement == 'released' and job.error_code == 'DOCUMENT_TEXT_RECONCILED_FAILED'
        assert doc.text_state == 'failed' and doc.cleanup_after and doc.text_call_id == unknown.call.id
        assert db.get(QuotaPeriod, unknown.flow.period_id).reserved == db.get(QuotaPeriod, unknown.flow.period_id).used == 0
        allocation = db.scalar(select(DocumentQuotaAllocation).where(DocumentQuotaAllocation.job_id == job.id))
        assert (allocation.reserved, allocation.used, allocation.released) == (0, 0, 3)
        releases = list(db.scalars(select(Ledger).where(Ledger.job_id == job.id, Ledger.kind == 'release')))
        assert len(releases) == 1 and releases[0].amount == 3
        call = db.get(TextCall, unknown.call.id)
        assert call.accounted_micros == (unknown.call.accounted_micros if accounted is None else accounted)
        assert call.cost_state == (unknown.call.cost_state if accounted is None else 'confirmed')
        audit = list(db.scalars(select(AdminAudit).where(AdminAudit.action == 'document.resolve_unknown')))
        assert len(audit) == 1 and audit[0].target_type == 'job' and audit[0].target_id == job.id
        assert audit[0].actor_id == db.scalar(select(User.id).where(User.subject == 'dev:' + settings().dev_admin_username))
        assert audit[0].before == {'status': 'outcome_unknown', 'accounted_micros': unknown.call.accounted_micros,
                                   'cost_state': unknown.call.cost_state}
        assert audit[0].after == {'status': 'failed', 'accounted_micros': call.accounted_micros, 'cost_state': call.cost_state}
        assert audit[0].details == {'call_id': call.id} and audit[0].note == body['note']
    assert claim() is None and unknown.invoked == [True]


def test_concurrent_operator_replays_are_exactly_once(unknown):
    barrier = Barrier(2)
    def resolve(_):
        barrier.wait()
        return unknown.client.post(unknown.path, headers=unknown.auth,
            json={**unknown.body, 'accounted_micros': 12345})
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(resolve, range(2)))
    assert [reply.status_code for reply in replies] == [200, 200]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.action == 'document.resolve_unknown')) == 1
        assert db.scalar(select(func.count()).select_from(Ledger).where(
            Ledger.job_id == unknown.flow.job_id, Ledger.kind == 'release')) == 1
        assert db.get(QuotaPeriod, unknown.flow.period_id).reserved == 0


def test_late_response_preserves_operator_confirmed_cost_and_records_usage(unknown):
    response = unknown.client.post(unknown.path, headers=unknown.auth,
        json={**unknown.body, 'accounted_micros': 12345})
    assert response.status_code == 200, response.text
    usage = {'input_tokens': 120, 'output_tokens': 80}
    late = TextResponse('{"translations":[]}', usage, 'late-original-request')
    text._record_call(unknown.call.id, response=late)
    text._record_call(unknown.call.id, response=late)  # Duplicate late delivery is also harmless.
    with session_factory()() as db:
        call = db.get(TextCall, unknown.call.id)
        assert call.usage == usage and call.request_id == 'late-original-request'
        assert call.accounted_micros == 12345 and call.cost_state == 'confirmed'
        assert db.get(Job, unknown.flow.job_id).status == 'failed'
        document = db.get(Document, unknown.flow.job_id)
        assert document.text_state == 'failed' and document.text_output_ref is None
        assert db.get(QuotaPeriod, unknown.flow.period_id).reserved == 0
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(
            AdminAudit.action == 'document.resolve_unknown')) == 1
        assert db.scalar(select(func.count()).select_from(Ledger).where(
            Ledger.job_id == unknown.flow.job_id, Ledger.kind == 'release')) == 1
    assert unknown.invoked == [True]


def seed_job(db, owner, kind, status):
    job_id = uid()
    job = Job(id=job_id, owner_id=owner, mode='classic', workflow_kind=kind, target_language='zh-Hans',
        status=status, phase=status, operation='isolated-document-admin', idempotency_key=job_id,
        request_hash='a' * 64, cache_key=job_id, config={'provider': {'id': 'fixture'}, 'secret': 'PRIVATE_MONITOR_FIXTURE'},
        quota_pages=0, quota_kind='none', settlement='none')
    db.add(job)
    db.flush()
    if kind == 'document':
        db.add(Document(job_id=job_id, filename='fixture.zip', source_type='zip', source_key=f'documents/input/{job_id}/source',
            source_size=1, source_sha256='a' * 64, expires_at=now() + timedelta(days=1)))
    return job


def test_monitor_filters_document_and_counts_awaiting_quota_as_active(flow):
    client, auth = flow.case.client, login(flow.case.client, settings().dev_admin_username)
    with session_factory()() as db:
        waiting = seed_job(db, flow.case.owner, 'document', 'awaiting_quota')
        failed = seed_job(db, flow.case.owner, 'document', 'failed')
        image = seed_job(db, flow.case.owner, 'image', 'queued')
        db.commit()
    def tasks(**query):
        response = client.get('/v1/admin/monitor/tasks', headers=auth, params=query)
        assert response.status_code == 200, response.text
        assert 'PRIVATE_MONITOR_FIXTURE' not in response.text
        return {row['id'] for row in response.json()['items']}
    assert tasks(workflow_kind='document') == {flow.job_id, waiting.id, failed.id}
    assert tasks(workflow_kind='image') == {image.id}
    assert tasks(workflow_kind='document', status='active') == {flow.job_id, waiting.id}
    assert tasks(status='awaiting_quota') == {waiting.id}
    assert client.get('/v1/admin/monitor/tasks', headers=auth, params={'workflow_kind': 'other'}).status_code == 422
    overview = client.get('/v1/admin/monitor/overview', headers=auth).json()
    waiting_queue = next(row for row in overview['queues'] if row['status'] == 'awaiting_quota')
    assert (waiting_queue['mode'], waiting_queue['workflow_kind'], waiting_queue['count']) == ('classic', 'document', 1)
    assert waiting_queue['oldest_seconds'] >= 0
    user = next(row for row in client.get('/v1/admin/monitor/users', headers=auth).json()['items'] if row['id'] == flow.case.owner)
    assert user['active_jobs'] == 3 and user['jobs']['awaiting_quota'] == 1


def test_monitor_exposes_page_stages_and_final_zip_executor_without_payloads(flow, monkeypatch):
    monkeypatch.setattr(text, 'call_messages', llm_reply)
    ocr_all(flow)
    lease = claim()
    workflow.complete_control(lease.id, text.run_text_stage(flow.job_id, lease.id))
    for number in (1, 2):
        gpu_done(flow, 'doc_render', number)
    assert claim() is None
    zip_lease = gpu_done(flow, 'doc_zip', 0)
    with session_factory()() as db:
        output = db.get(Document, flow.job_id).output_ref
    def forbidden(*args, **kwargs):
        raise AssertionError('Admin monitoring must not read R2 bytes or metadata')
    for name in ('head', 'get_json', 'open_stream'):
        monkeypatch.setattr(flow.store, name, forbidden, raising=False)
    auth = login(flow.case.client, settings().dev_admin_username)
    response = flow.case.client.get('/v1/admin/monitor/tasks/' + flow.job_id, headers=auth)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['workflow_kind'] == 'document' and data['status'] == 'succeeded'
    assert data['completed_by']['node_id'] == 'document-gpu-fixture'
    assert data['completed_by']['executor_id'] == zip_lease.executor_id
    assert [(row['name'], row['page_index']) for row in data['stages']] == [
        ('doc_prepare', 0), ('doc_ocr', 1), ('doc_ocr', 2), ('doc_ocr', 3), ('doc_text', 0),
        ('doc_render', 1), ('doc_render', 2), ('doc_render', 3), ('doc_zip', 0)]
    assert sorted(row['page_index'] for row in data['executions'] if row['stage'] == 'doc_ocr') == [1, 2, 3]
    assert [row['page_index'] for row in data['executions'] if row['stage'] == 'doc_zip'] == [0]
    assert output['key'] not in response.text and zip_lease.token not in response.text
    assert not any(f'"{name}"' in response.text for name in ('config', 'analysis', 'translations', 'input_ref', 'output_ref'))


@pytest.mark.parametrize('slots', [0, 5, True, 1.5])
def test_document_control_pool_rejects_out_of_range_or_noninteger_slots(flow, slots):
    auth = login(flow.case.client, settings().dev_admin_username)
    path = f'/v1/admin/compute-nodes/{workflow.NODE_ID}/config'
    current = flow.case.client.get(path, headers=auth).json()
    response = flow.case.client.put(path, headers=auth, json={'name': current['name'], 'enabled': True,
        'expected_version': current['version'], 'config': {'execution_slots': slots}})
    assert response.status_code == 422, response.text
    with session_factory()() as db:
        assert db.get(ComputeNode, workflow.NODE_ID).capacity == 1


@pytest.mark.parametrize('slots', [1, 4])
def test_document_pool_save_restart_and_claim_preserve_administrator_capacity(flow, monkeypatch, slots):
    from app.control_pools import initialize_pools
    from app.documents import config
    auth = login(flow.case.client, settings().dev_admin_username)
    schema = flow.case.client.get('/v1/admin/compute-nodes/config-schema', headers=auth).json()
    assert schema['pool_limits']['doc_text'] == 4 and 'doc_prepare' not in schema['pool_limits']
    path = f'/v1/admin/compute-nodes/{workflow.NODE_ID}/config'
    current = flow.case.client.get(path, headers=auth).json()
    body = {'name': '管理员文件资源池', 'enabled': True, 'expected_version': current['version'],
            'config': {'execution_slots': slots}}
    saved = flow.case.client.put(path, headers=auth, json=body)
    assert saved.status_code == 200, saved.text
    assert flow.case.client.put(path, headers=auth, json=body).status_code == 409
    with session_factory()() as db:
        for _ in range(slots + 1):
            job = seed_job(db, flow.case.owner, 'document', 'running')
            db.flush()
            db.get(Document, job.id).owner_node_id = 'document-gpu-fixture'
            db.add(JobStage(job_id=job.id, name='doc_text', status='ready'))
        db.commit()
        initialize_pools(db)  # The restart/bootstrap path must not reset admin state.
    monkeypatch.setattr(config, 'get_document_settings', lambda: SimpleNamespace(worker_slots=2))
    for number in range(slots):
        with session_factory()() as db:
            lease = workflow.claim_control(db, f'restarted-worker:{number}')
            db.commit()
            assert lease is not None
            node = db.get(ComputeNode, workflow.NODE_ID)
            assert node.capacity == slots and node.name == body['name']
            assert node.desired_config == {'execution_slots': slots}
            assert node.config_version == node.applied_config_version == saved.json()['version']
    with session_factory()() as db:
        assert workflow.claim_control(db, 'restarted-worker:full') is None
        db.commit()
    listing = flow.case.client.get('/v1/admin/monitor/nodes', headers=auth).json()['items']
    pool = next(row for row in listing if row['id'] == workflow.NODE_ID)
    assert pool['kind'] == 'control_pool' and pool['capacity'] == slots and pool['occupied'] == slots


def test_disabled_document_pool_remains_disabled_on_worker_restart_claim(flow):
    auth = login(flow.case.client, settings().dev_admin_username)
    path = f'/v1/admin/compute-nodes/{workflow.NODE_ID}/config'
    current = flow.case.client.get(path, headers=auth).json()
    response = flow.case.client.put(path, headers=auth, json={'name': current['name'], 'enabled': False,
        'expected_version': current['version'], 'config': {'execution_slots': 3}})
    assert response.status_code == 200
    with session_factory()() as db:
        job = seed_job(db, flow.case.owner, 'document', 'running')
        db.flush()
        db.get(Document, job.id).owner_node_id = 'document-gpu-fixture'
        db.add(JobStage(job_id=job.id, name='doc_text', status='ready'))
        db.commit()
        assert workflow.claim_control(db, 'restarted-disabled-worker') is None
        db.commit()
        node = db.get(ComputeNode, workflow.NODE_ID)
        assert not node.enabled and node.capacity == 3
