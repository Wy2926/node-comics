"""Lifecycle deletion on synthetic data: no live providers, accounts or files."""
from datetime import timedelta
from sqlalchemy import func, select

from app.db import session_factory
from app.execution_retention import cleanup_execution_data
from app.models import Attempt, ClassicState, Job, Ledger, TextCall, User, now, uid
from app.queue_models import ComputeClaim, ComputeNode, ExecutionLease, JobStage
from app.system_settings import SystemSettings
from app.translation_requests import TranslationRequest


def seed(db, *, days=8, status='succeeded', active_lease=False, unknown_call=False, guest=False):
    at = now() - timedelta(days=days)
    owner, job_id, node, stage, lease, attempt = (uid() for _ in range(6))
    db.add(User(id=owner, subject=owner, name='retention fixture'))
    db.add(ComputeNode(id=node, name='fixture', capabilities=['page'], capacity=1,
        resource_id=node, engine_version='fixture', device='fixture'))
    db.flush()
    db.add(Job(id=job_id, owner_id=owner, mode='classic', workflow_kind='image',
        target_language='en', status=status, phase=status, idempotency_key=job_id,
        operation='translate', request_hash='a' * 64, cache_key='b' * 64,
        config={'font_id': 'fixture', 'prompt': 'private prompt', 'engine': {'large': 'config'}},
        quota_pages=1, quota_kind='guest_trial' if guest else 'classic', settlement='settled',
        entitlement={'plan': 'guest' if guest else 'free', 'snapshot': 'large'}, attempt_id=attempt,
        result_description={'tiles': [1, 2, 3]}, discard_output=days > (1 if guest else 7),
        created_at=at, completed_at=at if status not in ('running', 'outcome_unknown') else None,
        changed_at=at))
    db.flush()
    db.add(Attempt(id=attempt, job_id=job_id, provider_id='fixture', lease_expires_at=at,
        completed_at=at, cost_state='reported', usage={'input_tokens': 123}))
    db.add(ClassicState(job_id=job_id, analysis={'mask': 'heavy', 'raw_mask': 'heavy',
        'bubble_mask': 'heavy', 'regions': ['heavy'], 'segments': [{'id': '0', 'source': 'private'}],
        'unrecognized_regions': [{'bbox': [0, 0, 1, 1]}]}, translations={'0': 'translated'},
        timings={'total': 2.5}, artifacts={'private': 'checkpoint'}))
    db.add(JobStage(id=stage, job_id=job_id, name='page', status='succeeded',
        result={'analysis_hash': 'c' * 64, 'diagnostic': 'large'}))
    db.add(Ledger(owner_id=owner, job_id=job_id, transaction_key=job_id, kind='settle', amount=1))
    db.add(TranslationRequest(owner_id=owner, id=job_id, job_id=job_id, request_hash='a' * 64,
        descriptor={'image': {'sha256': 'd' * 64}, 'mode': 'classic', 'target_language': 'en'}))
    db.flush()
    db.add(ExecutionLease(id=lease, job_id=job_id, stage_id=stage, node_id=node, owner_id=owner,
        generation=1, resource_pool='image', mode='classic', started_at=at, expires_at=at,
        completed_at=None if active_lease else at, outcome=None if active_lease else 'succeeded',
        result_hash='e' * 64, limits={'delivery_result': {'large': 'metadata'},
            'receipt': {'lease_id': lease, 'status': 'terminal'}}))
    db.add(TextCall(job_id=job_id, attempt_id=attempt, execution_lease_id=lease, group_index=0,
        sequence=0, provider_id='fixture', model='fixture', usage={'output_tokens': 42},
        reserved_micros=100, accounted_micros=80, completed_at=at,
        cost_state='unknown' if unknown_call else 'reported'))
    db.flush()
    return job_id, node, lease


def add_claim(db, node, lease_ids, days, *, request_id=None):
    key = request_id or uid()
    db.add(ComputeClaim(node_id=node, request_id=key, request_hash='f' * 64,
        lease_ids=lease_ids, created_at=now() - timedelta(days=days)))
    db.flush()
    return (node, key)


def test_terminal_masks_removed_but_valid_details_and_timing_remain(client):
    with session_factory()() as db:
        job, _, _ = seed(db, days=2)
        changed = db.get(Job, job).changed_at
        counts = cleanup_execution_data(db)
        db.commit()
        state = db.get(ClassicState, job)
        assert counts['checkpoints'] == 1 and counts['image_details'] == 0
        assert state.retention_stage == 1
        assert set(state.analysis) == {'segments', 'unrecognized_regions'}
        assert state.translations == {'0': 'translated'} and state.timings == {'total': 2.5}
        assert state.artifacts == {} and db.get(Job, job).changed_at == changed
        assert not any(cleanup_execution_data(db).values())


def test_expired_image_details_follow_registered_and_guest_policy(client):
    with session_factory()() as db:
        registered, _, _ = seed(db, days=8)
        guest, _, _ = seed(db, days=2, guest=True)
        young, _, _ = seed(db, days=.5, guest=True)
        counts = cleanup_execution_data(db)
        db.commit()
        assert counts['image_details'] == 2
        for job in (registered, guest):
            state = db.get(ClassicState, job)
            assert state.analysis is None and state.translations == {} and state.retention_stage == 2
            assert state.timings and db.get(Job, job).result_description == {}
        assert db.get(ClassicState, young).translations


def test_running_unsettled_and_unknown_calls_keep_their_checkpoints(client):
    with session_factory()() as db:
        jobs = [seed(db, days=150, status=status)[0] for status in ('running', 'outcome_unknown', 'unknown_released')]
        jobs += [seed(db, days=150, active_lease=True)[0], seed(db, days=150, unknown_call=True)[0]]
        unsettled = seed(db, days=150)[0]
        db.get(Job, unsettled).settlement = 'reserved'
        jobs.append(unsettled)
        cleanup_execution_data(db)
        db.commit()
        for job in jobs:
            assert db.get(ClassicState, job).analysis['raw_mask'] == 'heavy'
            assert db.get(Job, job).details_compacted_at is None


def test_claim_ttl_uses_all_lease_and_job_end_times_and_bounded_batches(client):
    with session_factory()() as db:
        _, node, lease = seed(db, days=8)
        old = add_claim(db, node, [lease], 8)
        fresh = add_claim(db, node, [], .5)
        empties = [add_claim(db, node, [], 2) for _ in range(5)]
        _, _, active = seed(db, days=20, active_lease=True)
        active_key = add_claim(db, node, [active, lease], 20)
        _, _, recent = seed(db, days=1)
        recent_key = add_claim(db, node, [recent], 20)
        _, _, unknown = seed(db, days=20, status='outcome_unknown')
        unknown_key = add_claim(db, node, [unknown], 20)
        _, _, uncertain = seed(db, days=20, unknown_call=True)
        uncertain_key = add_claim(db, node, [uncertain], 20)
        assert cleanup_execution_data(db, claim_batch=2)['claims'] == 2
        assert cleanup_execution_data(db, claim_batch=2)['claims'] == 2
        assert cleanup_execution_data(db, claim_batch=2)['claims'] == 2
        assert cleanup_execution_data(db, claim_batch=2)['claims'] == 0
        db.commit()
        for key in [old, *empties]:
            assert db.get(ComputeClaim, key) is None
        for key in (fresh, active_key, recent_key, unknown_key, uncertain_key):
            assert db.get(ComputeClaim, key) is not None


def test_history_compacts_once_preserving_billing_identity_and_terminal_receipts(client):
    with session_factory()() as db:
        job_id, _, lease_id = seed(db, days=91)
        job = db.get(Job, job_id)
        changed, request_hash = job.changed_at, job.request_hash
        counts = cleanup_execution_data(db)
        db.commit()
        db.expire_all()
        job = db.get(Job, job_id)
        assert counts['history'] == 1 and db.get(ClassicState, job_id) is None
        assert job.config == {'font_id': 'fixture'} and job.entitlement == {'plan': 'free', 'snapshot': 'large'}
        assert job.request_hash == request_hash and job.changed_at == changed and job.details_compacted_at
        lease = db.get(ExecutionLease, lease_id)
        assert lease.limits == {'receipt': {'lease_id': lease_id, 'status': 'terminal'}}
        assert lease.result_hash == 'e' * 64
        assert db.scalar(select(JobStage)).result == {'analysis_hash': 'c' * 64}
        assert db.scalar(select(TextCall)).accounted_micros == 80
        assert db.scalar(select(TextCall)).usage == {'output_tokens': 42}
        assert db.scalar(select(Attempt)).usage == {'input_tokens': 123}
        assert db.scalar(select(func.sum(Ledger.amount))) == 1
        assert db.get(TranslationRequest, (job.owner_id, job.id)).request_hash == 'a' * 64
        from app.translation_api import resolved_execution_ids
        assert resolved_execution_ids(db, {job.id: job}) == {job.id}
        assert not any(cleanup_execution_data(db).values())


def test_database_retention_changes_apply_without_restart(client):
    with session_factory()() as db:
        job, node, lease = seed(db, days=8)
        empty = add_claim(db, node, [], 2)
        done = add_claim(db, node, [lease], 8)
        row = db.get(SystemSettings, 1)
        row.values = {**row.values, 'image_result_retention_days': 14, 'empty_claim_retention_days': 3,
            'completed_claim_retention_days': 12, 'execution_detail_retention_days': 120}
        cleanup_execution_data(db)
        db.commit()
        assert db.get(ClassicState, job).translations
        assert db.get(ComputeClaim, empty) and db.get(ComputeClaim, done)


def test_document_text_expires_without_changing_page_accounting_or_result(client):
    from app.documents.models import Document, DocumentPage
    with session_factory()() as db:
        job, _, lease = seed(db, days=8)
        db.get(Job, job).workflow_kind = 'document'
        db.get(Job, job).config = {'text': {'provider_id': 'fixture', 'prompt': 'private'},
            'document': {'model_name': 'fixture model'}}
        db.get(Job, job).entitlement = {'document_unlimited_gift': {'used': 1, 'reserved': 0, 'released': 0}}
        db.scalar(select(TextCall).where(TextCall.job_id == job)).cost_state = 'confirmed'
        db.get(ExecutionLease, lease).limits = {'document_protocol': 2, 'workspace_generation': 1}
        db.add(Document(job_id=job, filename='fixture.zip', source_type='zip', source_key=job,
            source_size=100, source_sha256='a' * 64, expires_at=now() - timedelta(days=1),
            output_ref={'key': 'immutable-result'}, text_input_payload={'ocr': 'private'},
            text_output_payload={'translation': 'private'}, text_input_ref={'sha': 'hash'}))
        db.flush()
        db.add(DocumentPage(job_id=job, page_index=1, source_name='page.png',
            text_ref={'segments': [{'source': 'private'}]}, translations_ref={'0': 'translated'},
            status='succeeded', billable=True))
        assert cleanup_execution_data(db)['document_text'] == 1
        db.commit()
        document, page = db.get(Document, job), db.get(DocumentPage, (job, 1))
        assert document.text_input_payload is None and document.text_output_payload is None
        assert page.text_ref is None and page.translations_ref is None
        assert page.billable and document.output_ref == {'key': 'immutable-result'}
        assert cleanup_execution_data(db)['document_text'] == 0
        db.get(Job, job).completed_at = now() - timedelta(days=91)
        assert cleanup_execution_data(db)['history'] == 1
        db.commit()
        assert db.get(ExecutionLease, lease).limits == {'document_protocol': 2, 'workspace_generation': 1}
        from app.documents.api import document_json
        summary = document_json(db, db.get(Job, job), db.get(Document, job))
        assert summary['model'] == {'id': 'fixture', 'name': 'fixture model'}
        assert summary['quota']['used'] == 1


def test_checkpoint_batches_are_bounded_and_resume(client):
    with session_factory()() as db:
        for _ in range(5):
            seed(db, days=2)
        assert cleanup_execution_data(db, batch=2)['checkpoints'] == 2
        db.commit()
        assert cleanup_execution_data(db, batch=2)['checkpoints'] == 2
        db.commit()
        assert cleanup_execution_data(db, batch=2)['checkpoints'] == 1
