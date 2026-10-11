"""Inline OCR/whole-text integration; image work is a synthetic host checkpoint."""
from datetime import timedelta
import json
from types import SimpleNamespace
import pytest
from sqlalchemy import event, func, inspect, select

from app.adapters.llm import TextError, TextResponse
from app.db import engine, session_factory
from app.documents import text, worker, workflow
from app.documents.models import Document, DocumentPage
from app.entitlement_models import QuotaPeriod
from app.models import Job, TextCall, now, uid
from app.providers import digest
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from app.scheduler import lock_scheduler, release_lease, start_lease
from test_document_quota_api import document_case, create, purchase


@pytest.fixture
def flow(document_case, monkeypatch):
    case = document_case
    period_id = purchase(case, 8)
    request_id = create(case)
    assert case.client.post('/v1/documents/' + request_id + '/complete-upload', headers=case.auth).status_code == 202
    store = SimpleNamespace(config=SimpleNamespace(r2_key_prefix='documents'))
    monkeypatch.setattr(worker, 'get_document_store', lambda: store)
    with session_factory()() as db:
        lock_scheduler(db)
        node = ComputeNode(id='document-gpu-fixture', name='fixture', resource_id='document-gpu-fixture',
            capabilities=['doc_prepare', 'doc_ocr', 'doc_render', 'doc_zip'], capacity=1, engine_version='fixture', device='fixture')
        db.add(node)
        db.flush()
        job = db.scalar(select(Job).where(Job.owner_id == case.owner, Job.idempotency_key == request_id))
        document = db.get(Document, job.id)
        document.owner_node_id = node.id
        stage = workflow.stage_for(db, job.id, 'doc_prepare')
        lease = start_lease(db, node, stage, job, now(), 'fixture')
        lease.limits = {'workspace_generation': document.workspace_generation}
        ref = {'sha256': 'b' * 64, 'byte_size': 123, 'mime': 'image/png', 'width': 32, 'height': 48}
        workflow.install_pages(db, job, [{'page_index': index, 'source_name': f'{index}.png', 'input_ref': ref}
                                        for index in range(1, 4)])
        stage.status, stage.completed_at = 'succeeded', now()
        release_lease(db, lease, 'succeeded')
        workflow.on_stage_completed(db, job, stage)
        assert workflow.claim_control(db, 'fixture-bootstrap') is None
        db.commit()
    return SimpleNamespace(case=case, store=store, job_id=lease.job_id, request_id=request_id, period_id=period_id)


def gpu_done(flow, name, number, *, no_text=False):
    """Synthetic checkpoint insertion, not a claim of running a real image model."""
    with session_factory()() as db:
        lock_scheduler(db)
        job = db.get(Job, flow.job_id)
        stage = workflow.stage_for(db, job.id, name, number)
        assert stage.status == 'ready'
        lease = start_lease(db, db.get(ComputeNode, 'document-gpu-fixture'), stage, job, now(), 'fixture')
        lease.limits = {'workspace_generation': db.get(Document, job.id).workspace_generation}
        page = db.get(DocumentPage, (job.id, number))
        if name == 'doc_ocr':
            page.status = 'no_text' if no_text else 'ocr_done'
            if no_text:
                page.output_ref = page.input_ref
            else:
                page.text_ref = {'page_index': number, 'analysis_hash': digest(['analysis', number]),
                                'segments': [{'id': '0', 'source': 'A long conversation. ' * 160}]}
        elif name == 'doc_zip':
            stage.result = {'output_ref': {'key': f'documents/output/{job.id}/fixture.zip',
                'sha256': 'f' * 64, 'byte_size': 1234, 'mime': 'application/zip'}}
        else:
            page.status, page.billable, page.output_ref = 'translated', True, page.input_ref
        stage.status, stage.completed_at = 'succeeded', now()
        release_lease(db, lease, 'succeeded')
        workflow.on_stage_completed(db, job, stage)
        db.commit()
        return lease


def ocr_all(flow):
    gpu_done(flow, 'doc_ocr', 2)
    gpu_done(flow, 'doc_ocr', 3, no_text=True)
    with session_factory()() as db:
        assert workflow.stage_for(db, flow.job_id, 'doc_text').status == 'waiting'
    gpu_done(flow, 'doc_ocr', 1)


def claim():
    with session_factory()() as db:
        lease = workflow.claim_control(db, 'fixture')
        db.commit()
        return lease


def llm_reply(prompt, profile, *, json_schema, limits):
    pages = json.loads(prompt[1]['content'])['pages']
    assert [row['page'] for row in pages] == [1, 2]
    assert all(len(row['segments'][0]['source']) > 1800 for row in pages)
    assert limits.max_output_tokens == 32000 and limits.timeout_seconds == 600
    assert len(json_schema['schema']['properties']) == 1
    content = json.dumps({'translations': [{'id': row['segments'][0]['id'], 'text': '译文' * 1200} for row in pages]})
    return TextResponse(content, {'input_tokens': 1000, 'output_tokens': 3000}, 'test-document-request')


def test_one_call_inline_delivery_and_exact_once_settlement(flow, monkeypatch):
    from app.documents import storage
    monkeypatch.setattr(storage, 'get_document_store', lambda: pytest.fail('Whole-text execution must not access R2'))
    calls = []
    def invoke(*args, **kwargs):
        with session_factory()() as db:
            doc = db.get(Document, flow.job_id)
            assert doc.text_state == 'sending' and db.get(TextCall, doc.text_call_id).completed_at is None
            assert doc.text_input_payload['messages'] == args[0]
            assert doc.text_input_ref == text.payload_ref(doc.text_input_payload) and 'key' not in doc.text_input_ref
        calls.append(1)
        return llm_reply(*args, **kwargs)
    monkeypatch.setattr(text, 'call_messages', invoke)
    ocr_all(flow)
    lease = claim()
    source_queries = []
    def record_source_query(connection, cursor, statement, parameters, context, many):
        if statement.lstrip().upper().startswith('SELECT') and 'document_pages.text_ref' in statement:
            source_queries.append(statement)
    event.listen(engine(), 'before_cursor_execute', record_source_query)
    try:
        result = text.run_text_stage(flow.job_id, lease.id)
    finally:
        event.remove(engine(), 'before_cursor_execute', record_source_query)
    assert len(source_queries) == 1  # Deferred OCR columns do not turn into N+1 loads.
    workflow.complete_control(lease.id, result)
    workflow.complete_control(lease.id, result)
    for number in (1, 2):
        gpu_done(flow, 'doc_render', number)
    assert claim() is None  # Packaging is only eligible on the document host.
    gpu_done(flow, 'doc_zip', 0)
    with session_factory()() as db:
        assert db.get(Job, flow.job_id).status == 'succeeded'
        assert db.get(QuotaPeriod, flow.period_id).used == 2
        assert db.get(QuotaPeriod, flow.period_id).reserved == 0
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
        document = db.get(Document, flow.job_id)
        assert document.text_output_payload['call_id'] == document.text_call_id
        assert document.text_output_ref == text.payload_ref(document.text_output_payload)
        page = db.get(DocumentPage, (flow.job_id, 1))
        assert len(page.translations_ref['translations']['0']) == 2400 and 'key' not in page.translations_ref
    assert len(calls) == 1
    assert flow.case.client.post('/v1/documents/' + flow.request_id + '/cancel', headers=flow.case.auth).status_code == 409


def test_unknown_call_is_not_retried_and_keeps_page_reservation(flow, monkeypatch):
    calls = []
    def interrupted(*args, **kwargs):
        calls.append(1)
        raise TextError('TEXT_TRANSPORT_FAILED', 'fixture interrupted', retryable=True)
    monkeypatch.setattr(text, 'call_messages', interrupted)
    ocr_all(flow)
    lease = claim()
    with pytest.raises(TextError) as exc:
        text.run_text_stage(flow.job_id, lease.id)
    workflow.fail_lease(lease.id, exc.value)
    assert claim() is None
    assert not text.reconcile_saved_response(flow.job_id)
    with session_factory()() as db:
        assert db.get(Job, flow.job_id).status == 'outcome_unknown'
        assert db.get(QuotaPeriod, flow.period_id).reserved == 3
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
    assert len(calls) == 1


@pytest.mark.parametrize('prompt_change', [None, 'SYSTEM', 'PROMPT_VERSION'])
def test_saved_text_recovery_never_calls_model_twice(flow, monkeypatch, prompt_change):
    from app.errors import ProcessingError
    calls = []
    def invoke(*args, **kwargs):
        calls.append(1)
        return llm_reply(*args, **kwargs)
    monkeypatch.setattr(text, 'call_messages', invoke)
    ocr_all(flow)
    lease = claim()
    def lost_after_response():
        with session_factory()() as db:
            if db.get(Document, flow.job_id).text_output_ref:
                raise ProcessingError('WORKER_LEASE_EXPIRED', 'fixture lost after response commit')
    with pytest.raises(ProcessingError) as exc:
        text.run_text_stage(flow.job_id, lease.id, lost_after_response)
    workflow.fail_lease(lease.id, exc.value)
    with session_factory()() as db:
        workflow.stage_for(db, flow.job_id, 'doc_text').available_at = now() - timedelta(seconds=1)
        db.commit()
    lease = claim()
    if prompt_change:
        monkeypatch.setattr(text, prompt_change, getattr(text, prompt_change) + '\nchanged')
        with pytest.raises(ProcessingError, match='DOCUMENT_TEXT_CONFLICT'):
            text.run_text_stage(flow.job_id, lease.id)
    else:
        workflow.complete_control(lease.id, text.run_text_stage(flow.job_id, lease.id))
    assert len(calls) == 1


@pytest.mark.parametrize('mismatch', ['job', 'workspace_generation'])
def test_text_lease_is_bound_to_job_and_workspace_before_any_model_call(flow, monkeypatch, mismatch):
    from app.errors import ProcessingError
    ocr_all(flow)
    lease = claim()
    job_id = uid() if mismatch == 'job' else flow.job_id
    if mismatch == 'workspace_generation':
        with session_factory()() as db:
            db.get(Document, flow.job_id).workspace_generation += 1
            db.commit()
    monkeypatch.setattr(text, 'call_messages', lambda *a, **k: pytest.fail('Stale identity cannot send'))
    with pytest.raises(ProcessingError, match='LEASE_EXPIRED'):
        text.run_text_stage(job_id, lease.id)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 0
        assert db.get(Document, flow.job_id).text_input_payload is None


def test_committed_page_delivery_survives_worker_loss_without_a_second_call(flow, monkeypatch):
    calls = []
    def invoke(*args, **kwargs):
        calls.append(1)
        return llm_reply(*args, **kwargs)
    monkeypatch.setattr(text, 'call_messages', invoke)
    ocr_all(flow)
    lease = claim()
    expected_result = text.run_text_stage(flow.job_id, lease.id)
    # Simulate process loss after both DB checkpoints, before stage completion.
    with session_factory()() as db:
        assert db.get(Document, flow.job_id).text_state == 'received'
        assert db.get(DocumentPage, (flow.job_id, 1)).translations_ref
        db.get(ExecutionLease, lease.id).expires_at = now() - timedelta(seconds=1)
        db.commit()
    workflow.fail_lease(lease.id, TextError('WORKER_LEASE_EXPIRED', 'synthetic process loss'), recovering=True)
    with session_factory()() as db:
        workflow.stage_for(db, flow.job_id, 'doc_text').available_at = now() - timedelta(seconds=1)
        db.commit()
    replacement = claim()
    result = text.run_text_stage(flow.job_id, replacement.id)
    assert result == expected_result
    workflow.complete_control(replacement.id, result)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
        assert db.get(QuotaPeriod, flow.period_id).reserved == 3
        assert db.get(QuotaPeriod, flow.period_id).used == 0
    assert calls == [1]


def test_reply_after_expiry_before_maintenance_replays_db_response_without_releasing(flow, monkeypatch):
    from contextlib import nullcontext
    calls = []
    ocr_all(flow)
    lease = claim()
    def invoke(*args, **kwargs):
        calls.append(1)
        with session_factory()() as db:
            db.get(ExecutionLease, lease.id).expires_at = now() - timedelta(seconds=1)
            db.commit()
        return llm_reply(*args, **kwargs)
    monkeypatch.setattr(text, 'call_messages', invoke)
    # Neither a heartbeat failure nor maintenance has observed expiry yet.
    monkeypatch.setattr(worker, 'lease_guard', lambda _: nullcontext(lambda: None))
    worker.execute(lease)
    with session_factory()() as db:
        document = db.get(Document, flow.job_id)
        assert document.text_state == 'received' and document.text_output_payload
        assert db.get(Job, flow.job_id).status == 'running'
        assert db.get(QuotaPeriod, flow.period_id).reserved == 3
        stage = workflow.stage_for(db, flow.job_id, 'doc_text')
        assert stage.status == 'ready'
        stage.available_at = now() - timedelta(seconds=1)
        db.commit()
    monkeypatch.setattr(text, 'call_messages', lambda *a, **k: pytest.fail('Saved reply cannot resend'))
    replacement = claim()
    assert replacement.generation == lease.generation + 1
    worker.execute(replacement)
    with session_factory()() as db:
        assert workflow.stage_for(db, flow.job_id, 'doc_text').status == 'succeeded'
        assert workflow.stage_for(db, flow.job_id, 'doc_render', 1).status == 'ready'
        assert db.get(QuotaPeriod, flow.period_id).reserved == 3
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
    assert calls == [1]


@pytest.mark.parametrize('payload', [None, {'call_id': 'another-call'}])
def test_expired_text_without_matching_response_cannot_reopen(flow, monkeypatch, payload):
    ocr_all(flow)
    lease = claim()
    monkeypatch.setattr(text, 'call_messages', llm_reply)
    text.run_text_stage(flow.job_id, lease.id)
    with session_factory()() as db:
        db.get(Document, flow.job_id).text_output_payload = payload
        db.get(ExecutionLease, lease.id).expires_at = now() - timedelta(seconds=1)
        db.commit()
    workflow.fail_lease(lease.id, TextError('LEASE_EXPIRED', 'synthetic expiry'), token=lease.token)
    assert claim() is None
    with session_factory()() as db:
        assert db.get(Job, flow.job_id).status == 'failed'


@pytest.mark.parametrize('changed', ['stage', 'workspace'])
def test_saved_response_does_not_allow_stale_generation_failure_to_mutate_job(flow, monkeypatch, changed):
    from app.errors import ProcessingError
    ocr_all(flow)
    lease = claim()
    monkeypatch.setattr(text, 'call_messages', llm_reply)
    text.run_text_stage(flow.job_id, lease.id)
    with session_factory()() as db:
        if changed == 'stage':
            workflow.stage_for(db, flow.job_id, 'doc_text').generation += 1
        else:
            db.get(Document, flow.job_id).workspace_generation += 1
        db.get(ExecutionLease, lease.id).expires_at = now() - timedelta(seconds=1)
        db.commit()
    with pytest.raises(ProcessingError, match='LEASE_EXPIRED'):
        workflow.fail_lease(lease.id, TextError('LEASE_EXPIRED', 'synthetic stale expiry'), token=lease.token)
    with session_factory()() as db:
        assert db.get(Job, flow.job_id).status == 'running'
        assert db.get(QuotaPeriod, flow.period_id).reserved == 3
        assert db.get(ExecutionLease, lease.id).completed_at is None


@pytest.mark.parametrize('error_code', ['TEXT_INCOMPLETE', 'TEXT_REFUSED'])
def test_known_incomplete_response_fails_without_partial_delivery(flow, monkeypatch, error_code):
    def failed(*args, **kwargs):
        raise TextError(error_code, 'fixture incomplete', usage={'input_tokens': 10, 'output_tokens': 10}, retryable=True)
    monkeypatch.setattr(text, 'call_messages', failed)
    ocr_all(flow)
    lease = claim()
    with pytest.raises(TextError) as exc:
        text.run_text_stage(flow.job_id, lease.id)
    workflow.fail_lease(lease.id, exc.value)
    with session_factory()() as db:
        assert db.get(Job, flow.job_id).status == 'failed'
        assert db.get(QuotaPeriod, flow.period_id).reserved == 0
        assert db.get(QuotaPeriod, flow.period_id).used == 0
        assert workflow.stage_for(db, flow.job_id, 'doc_render', 1).status == 'cancelled'


def test_constant_schema_and_no_per_translation_truncation():
    expected = {f'p1:{index}' for index in range(6000)}
    content = json.dumps({'translations': [{'id': key, 'text': '译' * 2100 if key == 'p1:0' else '译'} for key in expected]})
    result = text.parse_translations(content, expected)
    assert len(result) == 6000 and len(result['p1:0']) == 2100
    assert len(json.dumps(text.response_schema())) < 500


def expire_text_lease(lease):
    with session_factory()() as db:
        db.get(ExecutionLease, lease.id).expires_at = now() - timedelta(seconds=1)
        db.commit()
    workflow.fail_lease(lease.id, TextError('WORKER_LEASE_EXPIRED', 'fixture expired'), recovering=True)
    with session_factory()() as db:
        assert db.get(Job, lease.job_id).status == 'outcome_unknown'


@pytest.mark.parametrize('error_code', ['TEXT_INCOMPLETE', 'TEXT_REFUSED', 'TEXT_AUTH_FAILED'])
def test_definitive_failure_after_lease_recovery_resolves_unknown_and_releases_quota(flow, monkeypatch, error_code):
    calls = []
    ocr_all(flow)
    lease = claim()
    def failed(*args, **kwargs):
        calls.append(1)
        expire_text_lease(lease)
        raise TextError(error_code, 'fixture known late failure', usage={'input_tokens': 10, 'output_tokens': 12})
    monkeypatch.setattr(text, 'call_messages', failed)
    with pytest.raises(TextError) as exc:
        text.run_text_stage(flow.job_id, lease.id)
    workflow.fail_lease(lease.id, exc.value)  # Released lease is an idempotent no-op.
    with session_factory()() as db:
        job = db.get(Job, flow.job_id)
        assert job.status == 'failed' and job.error_code == error_code
        assert db.get(QuotaPeriod, flow.period_id).reserved == 0
        assert workflow.stage_for(db, flow.job_id, 'doc_text').status == 'failed'
        assert db.scalar(select(func.count()).select_from(TextCall)) == 1
    assert claim() is None and calls == [1]


def test_confirmed_unstarted_reply_after_recovery_can_reopen_without_duplicate_llm(flow, monkeypatch):
    ocr_all(flow)
    lease = claim()
    def unavailable(*args, **kwargs):
        expire_text_lease(lease)
        raise TextError('TEXT_PROVIDER_DISABLED', 'fixture rejected before HTTP send')
    monkeypatch.setattr(text, 'call_messages', unavailable)
    with pytest.raises(TextError) as exc:
        text.run_text_stage(flow.job_id, lease.id)
    workflow.fail_lease(lease.id, exc.value)
    with session_factory()() as db:
        job, document = db.get(Job, flow.job_id), db.get(Document, flow.job_id)
        assert job.status == 'running' and job.unknown_since is None and job.error_code is None
        assert document.text_state == 'pending' and document.text_call_id is None
        assert db.get(QuotaPeriod, flow.period_id).reserved == 3
        old_call = db.scalar(select(TextCall))
        assert old_call.cost_state == 'confirmed' and old_call.accounted_micros == 0
    actual_calls = []
    def invoke(*args, **kwargs):
        actual_calls.append(1)
        return llm_reply(*args, **kwargs)
    monkeypatch.setattr(text, 'call_messages', invoke)
    replacement = claim()
    assert replacement.generation == lease.generation + 1
    workflow.complete_control(replacement.id, text.run_text_stage(flow.job_id, replacement.id))
    assert actual_calls == [1]


def test_late_success_is_reconciled_from_database_without_a_second_call(flow, monkeypatch):
    from app.errors import ProcessingError
    ocr_all(flow)
    lease = claim()
    calls = []
    def invoke(*args, **kwargs):
        calls.append(1)
        expire_text_lease(lease)
        return llm_reply(*args, **kwargs)
    monkeypatch.setattr(text, 'call_messages', invoke)
    with pytest.raises(ProcessingError, match='LEASE_EXPIRED'):
        text.run_text_stage(flow.job_id, lease.id)
    assert text.reconcile_saved_response(flow.job_id)
    replacement = claim()
    assert replacement.generation == lease.generation + 1
    workflow.complete_control(replacement.id, text.run_text_stage(flow.job_id, replacement.id))
    assert calls == [1]


def test_late_transport_failure_remains_unknown_and_is_never_reopened(flow, monkeypatch):
    ocr_all(flow)
    lease = claim()
    calls = []
    def interrupted(*args, **kwargs):
        calls.append(1)
        expire_text_lease(lease)
        raise TextError('TEXT_TRANSPORT_FAILED', 'fixture unknown late reply')
    monkeypatch.setattr(text, 'call_messages', interrupted)
    with pytest.raises(TextError) as exc:
        text.run_text_stage(flow.job_id, lease.id)
    workflow.fail_lease(lease.id, exc.value)
    with session_factory()() as db:
        assert db.get(Job, flow.job_id).status == 'outcome_unknown'
        assert db.get(Document, flow.job_id).text_state == 'unknown'
        assert db.get(QuotaPeriod, flow.period_id).reserved == 3
    assert claim() is None and calls == [1]


def test_single_page_translation_larger_than_ocr_checkpoint_budget_is_preserved(flow, monkeypatch):
    ocr_all(flow)
    lease = claim()
    large = 'x' * (4 * 1024 * 1024 + 1)
    calls = []
    def invoke(*args, **kwargs):
        calls.append(1)
        content = json.dumps({'translations': [{'id': 'p1:0', 'text': large}, {'id': 'p2:0', 'text': 'Second page'}]})
        return TextResponse(content, {'input_tokens': 1000, 'output_tokens': 3000}, 'large-fixture')
    monkeypatch.setattr(text, 'call_messages', invoke)
    workflow.complete_control(lease.id, text.run_text_stage(flow.job_id, lease.id))
    with session_factory()() as db:
        page = db.get(DocumentPage, (flow.job_id, 1))
        assert page.translations_ref['translations']['0'] == large
        assert workflow.stage_for(db, flow.job_id, 'doc_render', 1).status == 'ready'
    assert calls == [1]


@pytest.mark.parametrize('content', [
    '{"translations":[{"id":"p1:0","text":"a"},{"id":"p1:0","text":"b"}]}',
    '{"translations":[]}', '{"translations":[{"id":"p1:1","text":"a"}]}',
    '{"translations":[{"id":"p1:0","text":""}]}',
    '{"translations":[{"id":"p1:0","text":"  \\n\\t"}]}',
    '{"translations":[{"id":"p1:0","text":"a","text":"b"}]}'])
def test_missing_empty_extra_duplicate_translations_are_not_accepted(content):
    with pytest.raises(TextError):
        text.parse_translations(content, {'p1:0'})


def test_document_payloads_are_deferred_from_metadata_queries(flow):
    with session_factory()() as db:
        document = db.scalar(select(Document).where(Document.job_id == flow.job_id))
        assert {'text_input_payload', 'text_output_payload'} <= inspect(document).unloaded
        assert document.text_output_ref is None
        assert {'text_input_payload', 'text_output_payload'} <= inspect(document).unloaded
        page = db.get(DocumentPage, (flow.job_id, 1))
        assert {'text_ref', 'translations_ref'} <= inspect(page).unloaded
        assert page.input_ref and page.status == 'pending'
        assert {'text_ref', 'translations_ref'} <= inspect(page).unloaded


def test_response_commit_failure_keeps_atomic_unknown_intent_without_resending(flow, monkeypatch):
    from sqlalchemy.orm import Session
    calls = []
    ocr_all(flow)
    lease = claim()
    def invoke(*args, **kwargs):
        calls.append(1)
        return llm_reply(*args, **kwargs)
    monkeypatch.setattr(text, 'call_messages', invoke)
    def interrupt(db):
        if any(isinstance(row, Document) and row.text_state == 'received' for row in db.dirty):
            raise RuntimeError('synthetic response transaction interrupted')
    event.listen(Session, 'before_commit', interrupt)
    try:
        with pytest.raises(RuntimeError):
            text.run_text_stage(flow.job_id, lease.id)
    finally:
        event.remove(Session, 'before_commit', interrupt)
    with session_factory()() as db:
        document = db.get(Document, flow.job_id)
        assert document.text_state == 'sending' and document.text_input_payload
        assert document.text_output_payload is None and document.text_output_ref is None
        assert db.get(TextCall, document.text_call_id).completed_at is None
    workflow.fail_lease(lease.id, TextError('DOCUMENT_CALL_INTERRUPTED', 'synthetic DB failure', unknown=True))
    assert not text.reconcile_saved_response(flow.job_id) and claim() is None
    with session_factory()() as db:
        assert db.get(Job, flow.job_id).status == 'outcome_unknown'
        assert db.get(QuotaPeriod, flow.period_id).reserved == 3
    assert calls == [1]


def test_intent_commit_failure_sends_nothing_and_does_not_persist_half_a_call(flow, monkeypatch):
    from sqlalchemy.orm import Session
    ocr_all(flow)
    lease = claim()
    monkeypatch.setattr(text, 'call_messages', lambda *a, **k: pytest.fail('Uncommitted intent cannot send'))
    def interrupt(db):
        if any(isinstance(row, Document) and row.text_state == 'sending' for row in db.dirty):
            raise RuntimeError('synthetic intent transaction interrupted')
    event.listen(Session, 'before_commit', interrupt)
    try:
        with pytest.raises(RuntimeError):
            text.run_text_stage(flow.job_id, lease.id)
    finally:
        event.remove(Session, 'before_commit', interrupt)
    with session_factory()() as db:
        document = db.get(Document, flow.job_id)
        assert document.text_state == 'pending' and document.text_call_id is None
        assert document.text_input_payload is None and document.text_input_ref is None
        assert db.scalar(select(func.count()).select_from(TextCall)) == 0


def test_received_invalid_translation_is_preserved_as_evidence_but_never_replayed(flow, monkeypatch):
    ocr_all(flow)
    lease = claim()
    monkeypatch.setattr(text, 'call_messages', lambda *a, **k:
        TextResponse('{"translations":[]}', {'input_tokens': 10, 'output_tokens': 5}, 'invalid-fixture'))
    with pytest.raises(TextError, match='DOCUMENT_TEXT_INCOMPLETE') as error:
        text.run_text_stage(flow.job_id, lease.id)
    workflow.fail_lease(lease.id, error.value)
    with session_factory()() as db:
        document = db.get(Document, flow.job_id)
        assert document.text_output_payload['content'] == '{"translations":[]}'
        assert document.text_state == 'failed' and db.get(Job, flow.job_id).status == 'failed'
        assert db.get(DocumentPage, (flow.job_id, 1)).translations_ref is None
    assert not text.reconcile_saved_response(flow.job_id)


@pytest.mark.parametrize('changes', [
    {'page_index': True}, {'page_index': 2}, {'analysis_hash': 'g' * 64},
    {'segments': []}, {'segments': ['not-a-row']}, {'extra': 'not a schema field'},
    {'segments': [{'id': '0', 'source': 'a'}, {'id': '0', 'source': 'b'}]},
    {'segments': [{'id': '0', 'source': '   '}]},
    {'segments': [{'id': '0', 'source': '\ud800'}]},
    {'segments': [{'id': '0', 'source': 'a', 'extra': 'not a schema field'}]},
])
def test_inline_ocr_schema_is_validated_before_llm(changes):
    from app.errors import ProcessingError
    data = {'page_index': 1, 'analysis_hash': 'a' * 64, 'segments': [{'id': '0', 'source': 'complete source'}], **changes}
    with pytest.raises(ProcessingError, match='DOCUMENT_OCR_INVALID'):
        text.load_sources([SimpleNamespace(page_index=1, status='ocr_done', text_ref=data)], 96000, lambda: None)


def test_inline_ocr_context_budget_rejects_without_slicing():
    page = SimpleNamespace(page_index=1, status='ocr_done', text_ref={
        'page_index': 1, 'analysis_hash': 'a' * 64, 'segments': [{'id': '0', 'source': 'complete source'}]})
    with pytest.raises(TextError, match='DOCUMENT_CONTEXT_EXCEEDED'):
        text.load_sources([page], 10, lambda: None)
