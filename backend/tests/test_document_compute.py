"""Real SQL/API fencing and quota; only source/final R2 metadata are simulated."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import json
import logging
from statistics import median
from time import perf_counter
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import event, func, select

from app.db import engine, session_factory
from app.documents.models import Document, DocumentPage, DocumentQuotaAllocation
from app.documents import workflow
from app.entitlement_models import QuotaPeriod
from app.models import Job, Ledger, now
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from test_compute_v3 import v3, claim as image_claim, request as image_request
from test_document_quota_api import document_case, create as create_upload, purchase
from test_node_management import provision

PREFIX = '/internal/documents/compute/v2'
INPUT = {'sha256': 'c' * 64, 'byte_size': 123, 'mime': 'image/png', 'width': 40, 'height': 50}


class MetadataStore:
    def __init__(self):
        self.verified, self.gets, self.puts = [], [], []

    def key(self, category, job_id, *parts):
        return '/'.join(('isolated-documents', category, job_id, *parts))

    def presign_get(self, ref):
        self.gets.append(ref)
        return {'url': 'https://fixture.r2.cloudflarestorage.com/' + ref['key'], 'headers': {}, 'expires_in': 300}

    def presign_put(self, ref):
        self.puts.append(ref)
        return {'url': 'https://fixture.r2.cloudflarestorage.com/' + ref['key'],
                'headers': {'If-None-Match': '*'}, 'expires_in': 300}

    def verify(self, ref):
        self.verified.append(ref)
        return {**ref, 'etag': 'immutable-fixture'}


@pytest.fixture
def documents(v3, document_case, monkeypatch):
    from app.documents import compute
    store = MetadataStore()
    monkeypatch.setattr(compute, 'get_document_store', lambda: store)
    response = image_request(v3, '/nodes/register', {**v3['registration'], 'document_protocol': 2})
    assert response.status_code == 200, response.text
    period_id = purchase(document_case, 1000)
    return SimpleNamespace(v3=v3, account=document_case, owner=document_case.owner, store=store, period_id=period_id)


def manifest(count):
    return [{'page_index': index, 'source_name': f'{index}.png', 'input_ref': INPUT.copy()} for index in range(1, count + 1)]


def create(case, count=1, *, prepared=True):
    request_id = create_upload(case.account)
    response = case.account.client.post('/v1/documents/' + request_id + '/complete-upload', headers=case.account.auth)
    assert response.status_code == 202, response.text
    with session_factory()() as db:
        job = db.scalar(select(Job).where(Job.owner_id == case.owner, Job.idempotency_key == request_id))
        if prepared:
            # Most cases start after a synthetic parser, without image/model IO.
            document = db.get(Document, job.id)
            document.owner_node_id = case.v3['node']['node_id']
            workflow.install_pages(db, job, manifest(count))
            stage = workflow.stage_for(db, job.id, 'doc_prepare')
            stage.status, stage.completed_at = 'succeeded', now()
            workflow.on_stage_completed(db, job, stage)
            db.commit()
        return job.id


def request(case, path, body):
    return case.v3['client'].post(PREFIX + path, headers=case.v3['auth'], json=body)


def claim(case, request_id=None, **changes):
    return request(case, f'/nodes/{case.v3["node"]["node_id"]}/claim',
        {'request_id': request_id or uuid4().hex, 'config_version': 1, 'count': 1, **changes})


def auth(lease):
    return {key: lease[key] for key in ('lease_token', 'workspace_generation')}


def result(lease, *, no_text=False):
    if lease['action'] == 'doc_prepare':
        return {'pages': manifest(1)}
    if lease['action'] == 'doc_ocr':
        return {'analysis_ref': {'sha256': 'd' * 64, 'byte_size': 30, 'mime': 'application/json'},
                'text': {'page_index': lease['page_index'], 'analysis_hash': 'e' * 64,
                         'segments': [] if no_text else [{'id': '0', 'source': 'Private synthetic text'}]},
                'no_text': no_text}
    if lease['action'] == 'doc_zip':
        return {'output_ref': {'key': lease['output_key'], 'sha256': 'f' * 64, 'byte_size': 100, 'mime': 'application/zip'}}
    return {'output_ref': {**INPUT, 'sha256': 'f' * 64}}


def complete(case, lease, *, no_text=False, values=None):
    return request(case, f'/leases/{lease["lease_id"]}/complete',
                   {**auth(lease), **(result(lease, no_text=no_text) if values is None else values)})


def freeze(case, lease, ref=None):
    return request(case, f'/leases/{lease["lease_id"]}/uploads',
                   {**auth(lease), 'output_ref': ref or result(lease)['output_ref']})


def zip_lease(case):
    create(case)
    lease = claim(case).json()['leases'][0]
    assert complete(case, lease, no_text=True).status_code == 200
    lease = claim(case).json()['leases'][0]
    assert lease['action'] == 'doc_zip'
    return lease


def other_node(case):
    node, credentials, admin = provision(case.v3['client'], 'other:cuda:0')
    value = {**case.v3, 'node': node, 'auth': credentials, 'admin': admin,
             'registration': {**case.v3['registration'], 'resource_id': 'other:cuda:0'}}
    assert image_request(value, '/nodes/register', {**value['registration'], 'document_protocol': 2}).status_code == 200
    return SimpleNamespace(v3=value)


@pytest.mark.parametrize('protocol', [None, 1])
def test_v1_and_image_only_nodes_cannot_claim_documents(documents, protocol):
    create(documents)
    response = image_request(documents.v3, '/nodes/register', {**documents.v3['registration'], 'document_protocol': protocol})
    assert response.status_code == 200
    assert claim(documents).json()['error']['code'] == 'PROTOCOL_MISMATCH'
    with session_factory()() as db:
        assert db.get(ComputeNode, documents.v3['node']['node_id']).capabilities == ['page']
    assert documents.v3['client'].post('/internal/documents/compute/v1/nodes/anything/claim',
        headers=documents.v3['auth'], json={}).status_code == 404


def test_prepare_pins_owner_and_reserves_only_after_bounded_manifest(documents):
    job_id = create(documents, prepared=False)
    lease = claim(documents).json()['leases'][0]
    assert lease['action'] == 'doc_prepare' and lease['workspace_generation'] == 1
    assert lease['source']['ref']['mime'] == 'application/zip'
    assert lease['file_limits']['max_page_pixels'] > 0 and lease['limits']['max_spool_bytes'] > 0
    assert lease['limits']['max_output_bytes'] <= 4 * 1024 ** 3
    with session_factory()() as db:
        doc = db.get(Document, job_id)
        assert doc.owner_node_id == documents.v3['node']['node_id'] and doc.reserved_at is None
        assert db.get(QuotaPeriod, documents.period_id).reserved == 0
        assert workflow.claim_control(db, 'fixture') is None
    assert claim(other_node(documents)).json()['leases'] == []
    assert complete(documents, lease, values={'pages': manifest(2)[::-1]}).status_code == 422
    accepted = complete(documents, lease, values={'pages': manifest(2)})
    assert accepted.status_code == 200, accepted.text
    assert complete(documents, lease, values={'pages': manifest(2)}).json() == accepted.json()
    with session_factory()() as db:
        assert db.get(QuotaPeriod, documents.period_id).reserved == 2
        assert db.get(Document, job_id).page_count == 2
        assert workflow.stage_for(db, job_id, 'doc_ocr', 1).status == 'ready'
    assert not documents.store.puts and not documents.store.verified


def test_every_node_stage_and_sync_preserve_configured_file_limits(documents, monkeypatch):
    from app.documents import compute
    from app.documents.config import DocumentSettings

    cfg = DocumentSettings(_env_file=None, enabled=False, max_page_dimension=30000,
        max_page_pixels=32_000_000, max_page_bytes=256 * 1024 ** 2,
        max_expanded_bytes=3 * 1024 ** 3, max_output_bytes=3 * 1024 ** 3,
        max_spool_bytes=8 * 1024 ** 3, parser_memory_bytes=2 * 1024 ** 3,
        parser_timeout_seconds=120, pdf_dpi=216)
    monkeypatch.setattr(compute, 'get_document_settings', lambda: cfg)
    expected = {name: getattr(cfg, name) for name in compute.FILE_LIMITS}
    job_id = create(documents, prepared=False)

    def next_stage(action):
        response = claim(documents)
        assert response.status_code == 200, response.text
        lease = response.json()['leases'][0]
        assert lease['action'] == action
        assert lease['file_limits'] == lease['limits']['file_limits'] == expected
        synced = request(documents, f'/nodes/{documents.v3["node"]["node_id"]}/sync',
                         {'workspace_ids': [job_id]}).json()['leases'][0]
        assert synced['lease_id'] == lease['lease_id'] and synced['file_limits'] == expected
        return lease

    prepare = next_stage('doc_prepare')
    page_ref = {**INPUT, 'width': 25000, 'height': 1}
    pages = [{'page_index': 1, 'source_name': '1.png', 'input_ref': page_ref}]
    assert complete(documents, prepare, values={'pages': pages}).status_code == 200
    ocr = next_stage('doc_ocr')
    assert ocr['input'] == page_ref
    assert complete(documents, ocr).status_code == 200
    with session_factory()() as db:
        # Synthetic central text checkpoint; this is a wire/SQL fixture, not LLM work.
        db.get(DocumentPage, (job_id, 1)).translations_ref = {
            'analysis_hash': 'e' * 64, 'language': 'zh-Hans',
            'translations': {'0': 'translated'}, 'revision': 'f' * 64}
        text_stage = workflow.stage_for(db, job_id, 'doc_text')
        text_stage.status = 'succeeded'
        workflow.on_stage_completed(db, db.get(Job, job_id), text_stage)
        db.commit()
    render = next_stage('doc_render')
    assert complete(documents, render, values={'output_ref': {**page_ref, 'sha256': 'f' * 64}}).status_code == 200
    zipped = next_stage('doc_zip')
    assert freeze(documents, zipped).status_code == 200
    assert complete(documents, zipped).status_code == 200


def test_unreserved_pages_and_other_owners_never_claim(documents):
    job_id = create(documents)
    assert claim(other_node(documents)).json()['leases'] == []
    with session_factory()() as db:
        db.get(Document, job_id).reserved_at = None
        db.commit()
    assert claim(documents).json()['leases'] == []


def test_document_backlog_never_hides_interactive_work_and_capacity_is_shared(documents):
    from conftest import configure_system_limits
    create(documents, 200)
    configure_system_limits(free_daily_pages=20)
    documents.v3['create']()
    assert claim(documents).json()['leases'] == []
    interactive = image_claim(documents.v3).json()['leases']
    background = claim(documents).json()['leases']
    assert len(interactive) == len(background) == 1
    assert claim(documents).json()['leases'] == []
    with session_factory()() as db:
        node = db.get(ComputeNode, documents.v3['node']['node_id'])
        node.capacity = 2
        node.desired_config = {**node.desired_config, 'document_slots': 2}
        db.commit()
    assert claim(documents).json()['leases'] == []
    response = image_request(documents.v3, '/nodes/register', {**documents.v3['registration'], 'document_protocol': 2})
    assert [item['lease_id'] for item in response.json()['leases']] == [interactive[0]['lease_id']]


def test_concurrent_claim_receipt_and_configuration_replay(documents):
    create(documents, 10)
    with ThreadPoolExecutor(4) as pool:
        replies = list(pool.map(lambda _: claim(documents, 'lost-response'), range(4)))
    assert all(reply.status_code == 200 for reply in replies)
    ids = [reply.json()['leases'][0]['lease_id'] for reply in replies]
    assert len(set(ids)) == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ExecutionLease).where(
            ExecutionLease.node_id == documents.v3['node']['node_id'],
            ExecutionLease.completed_at.is_(None))) == 1
    with session_factory()() as db:
        node = db.get(ComputeNode, documents.v3['node']['node_id'])
        node.enabled, node.config_version = False, 2
        db.commit()
    assert claim(documents, 'lost-response').json()['leases'][0]['lease_id'] == ids[0]
    assert claim(documents, 'lost-response', config_version=2).status_code == 409


def test_local_ocr_completion_replay_has_no_transfer_and_releases_before_text(documents):
    job_id = create(documents)
    lease = claim(documents).json()['leases'][0]
    assert lease['input'] == INPUT and 'inputs' not in lease
    accepted = complete(documents, lease)
    assert accepted.status_code == 200, accepted.text
    assert complete(documents, lease).json() == accepted.json()
    assert complete(documents, lease, no_text=True).status_code == 409
    assert not documents.store.verified and not documents.store.puts and not documents.store.gets
    with session_factory()() as db:
        assert db.get(ExecutionLease, lease['lease_id']).completed_at
        assert workflow.stage_for(db, job_id, 'doc_text').status == 'ready'
        assert workflow.stage_for(db, job_id, 'doc_render', 1).status == 'waiting'
        page = db.get(DocumentPage, (job_id, 1))
        assert page.text_ref == result(lease)['text'] and page.analysis_ref['sha256'] != page.text_ref['analysis_hash']
        assert workflow.stage_for(db, job_id, 'doc_ocr', 1).result == {}
        central = workflow.claim_control(db, 'fixture')
        assert central and central.node_id == 'control-document'
        assert central.limits['workspace_generation'] == 1
        db.commit()
    assert claim(documents).json()['leases'] == []


@pytest.mark.parametrize('change', [
    lambda value: value['analysis_ref'].update(key='documents/work/forbidden'),
    lambda value: value['analysis_ref'].update(byte_size=4 * 1024 * 1024 + 1),
    lambda value: value['text'].update(page_index=2),
    lambda value: value['text']['segments'].append(value['text']['segments'][0]),
    lambda value: value.update(no_text=True),
])
def test_local_checkpoint_shape_and_scope_are_bounded(documents, change):
    create(documents)
    lease = claim(documents).json()['leases'][0]
    value = result(lease)
    change(value)
    assert complete(documents, lease, values=value).status_code == 422
    assert not documents.store.verified


def test_no_text_uses_original_and_skips_text_and_render(documents):
    job_id = create(documents)
    lease = claim(documents).json()['leases'][0]
    assert complete(documents, lease, no_text=True).status_code == 200
    with session_factory()() as db:
        page = db.get(DocumentPage, (job_id, 1))
        assert page.status == 'no_text' and page.output_ref == page.input_ref and not page.billable
        assert workflow.stage_for(db, job_id, 'doc_render', 1).status == 'succeeded'
        assert workflow.stage_for(db, job_id, 'doc_zip').status == 'ready'
        assert db.get(Document, job_id).text_state == 'skipped'


def test_render_has_inline_translations_and_same_dimension_local_output(documents):
    job_id = create(documents)
    lease = claim(documents).json()['leases'][0]
    assert complete(documents, lease).status_code == 200
    translations = {'analysis_hash': 'e' * 64, 'language': 'zh-Hans', 'translations': {'0': 'translated'}, 'revision': 'f' * 64}
    with session_factory()() as db:
        db.get(DocumentPage, (job_id, 1)).translations_ref = translations
        stage = workflow.stage_for(db, job_id, 'doc_text')
        stage.status = 'succeeded'
        workflow.on_stage_completed(db, db.get(Job, job_id), stage)
        db.commit()
    lease = claim(documents).json()['leases'][0]
    assert lease['action'] == 'doc_render' and lease['translations'] == translations
    bad = result(lease)
    bad['output_ref']['width'] += 1
    assert complete(documents, lease, values=bad).status_code == 422
    assert complete(documents, lease).status_code == 200
    with session_factory()() as db:
        page = db.get(DocumentPage, (job_id, 1))
        assert page.status == 'translated' and page.billable and 'key' not in page.output_ref
        assert workflow.stage_for(db, job_id, 'doc_zip').status == 'ready'
    assert not documents.store.gets and not documents.store.verified


def test_only_zip_can_get_upload_authorization_and_final_receipt_settles_once(documents):
    create(documents)
    ocr = claim(documents).json()['leases'][0]
    fake_zip = {'key': 'isolated-documents/output/forbidden.zip', 'sha256': 'f' * 64, 'byte_size': 100, 'mime': 'application/zip'}
    assert freeze(documents, ocr, fake_zip).status_code == 422
    assert request(documents, f'/leases/{ocr["lease_id"]}/inputs', auth(ocr)).status_code == 422
    assert complete(documents, ocr, no_text=True).status_code == 200
    lease = claim(documents).json()['leases'][0]
    assert lease['action'] == 'doc_zip' and lease['pages'] == [{'page_index': 1, 'output_ref': INPUT}]
    assert complete(documents, lease).status_code == 409
    assert freeze(documents, lease).status_code == 200
    bad = {**result(lease)['output_ref'], 'sha256': 'a' * 64}
    assert freeze(documents, lease, bad).status_code == 409
    accepted = complete(documents, lease)
    assert accepted.status_code == 200, accepted.text
    assert complete(documents, lease).json() == accepted.json()
    assert freeze(documents, lease).json()['receipt'] == accepted.json()
    with session_factory()() as db:
        job = db.get(Job, lease['job_id'])
        assert job.status == 'succeeded' and job.settlement == 'settled'
        assert db.get(QuotaPeriod, documents.period_id).reserved == 0
        assert db.get(Document, job.id).output_ref['key'] == lease['output_key']
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.job_id == job.id, Ledger.kind == 'release')) == 1
    assert len(documents.store.verified) == len(documents.store.puts) == 1


def test_zip_upload_maximum_is_four_gib_not_legacy_image_limit(documents):
    lease = zip_lease(documents)
    ref = {**result(lease)['output_ref'], 'byte_size': 4 * 1024 ** 3}
    assert freeze(documents, lease, ref).status_code == 200
    assert freeze(documents, lease, {**ref, 'byte_size': ref['byte_size'] + 1}).status_code == 422


def test_expired_stage_generation_and_wrong_workspace_cannot_publish(documents):
    from app.errors import ProcessingError
    job_id = create(documents)
    old = claim(documents).json()['leases'][0]
    assert complete(documents, {**old, 'workspace_generation': 2}).status_code == 409
    assert complete(documents, {**old, 'lease_token': 'other'}).status_code == 403
    with session_factory()() as db:
        db.get(ExecutionLease, old['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.commit()
    workflow.fail_lease(old['lease_id'], ProcessingError('WORKER_LEASE_EXPIRED', 'fixture'), recovering=True)
    with session_factory()() as db:
        workflow.stage_for(db, job_id, 'doc_ocr', 1).available_at = now()
        db.commit()
    replacement = claim(documents).json()['leases'][0]
    assert replacement['generation'] == old['generation'] + 1
    assert complete(documents, old).status_code == 409
    assert complete(documents, replacement).status_code == 200


def test_missing_workspace_before_llm_rebuilds_without_double_reservation(documents):
    job_id = create(documents, 2)
    lease = claim(documents).json()['leases'][0]
    assert complete(documents, lease, values={'error': 'DOCUMENT_WORKSPACE_MISSING'}).status_code == 200
    with session_factory()() as db:
        document = db.get(Document, job_id)
        assert document.workspace_generation == 2 and document.reserved_at
        assert db.get(QuotaPeriod, documents.period_id).reserved == 2
        assert workflow.stage_for(db, job_id, 'doc_prepare').status == 'ready'
        assert workflow.stage_for(db, job_id, 'doc_ocr', 1).status == 'waiting'
    assert complete(documents, lease).status_code == 409
    preparation = claim(documents).json()['leases'][0]
    assert preparation['action'] == 'doc_prepare' and preparation['workspace_generation'] == 2
    assert complete(documents, preparation, values={'pages': manifest(2)}).status_code == 200
    with session_factory()() as db:
        assert db.get(QuotaPeriod, documents.period_id).reserved == 2
        assert db.scalar(select(func.count()).select_from(DocumentQuotaAllocation).where(DocumentQuotaAllocation.job_id == job_id)) == 1
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.job_id == job_id, Ledger.kind == 'reserve')) == 1


def test_workspace_reset_fences_other_inflight_pages_and_preserves_frozen_manifest(documents):
    job_id = create(documents, 2)
    with session_factory()() as db:
        node = db.get(ComputeNode, documents.v3['node']['node_id'])
        node.desired_config = {**node.desired_config, 'document_slots': 2}
        db.commit()
    first, second = claim(documents).json()['leases'][0], claim(documents).json()['leases'][0]
    assert complete(documents, first, values={'error': 'DOCUMENT_WORKSPACE_MISSING'}).status_code == 200
    assert complete(documents, second).status_code == 409
    heartbeat = request(documents, f'/nodes/{documents.v3["node"]["node_id"]}/heartbeat',
        {'leases': [{'lease_id': second['lease_id'], **auth(second)}]}).json()
    assert heartbeat['leases'][0]['status'] == 'terminal'
    preparation = claim(documents).json()['leases'][0]
    changed = manifest(2)
    changed[0]['input_ref']['sha256'] = 'a' * 64
    rejected = complete(documents, preparation, values={'pages': changed})
    assert rejected.json()['error']['code'] == 'DOCUMENT_MANIFEST_CONFLICT'
    with session_factory()() as db:
        assert db.get(Document, job_id).workspace_generation == 2
        assert db.get(DocumentPage, (job_id, 1)).input_ref == INPUT
        assert db.get(QuotaPeriod, documents.period_id).reserved == 2


@pytest.mark.parametrize(('state', 'expected'), [('sending', 'outcome_unknown'), ('unknown', 'outcome_unknown'), ('received', 'failed')])
def test_missing_workspace_after_llm_never_rebuilds_or_resends(documents, state, expected):
    job_id = create(documents)
    lease = claim(documents).json()['leases'][0]
    with session_factory()() as db:
        db.get(Document, job_id).text_state = state
        db.commit()
    assert complete(documents, lease, values={'error': 'DOCUMENT_WORKSPACE_MISSING'}).status_code == 200
    with session_factory()() as db:
        assert db.get(Job, job_id).status == expected
        assert db.get(Document, job_id).workspace_generation == 1
        assert workflow.claim_control(db, 'fixture') is None
        assert db.get(QuotaPeriod, documents.period_id).reserved == (0 if expected == 'failed' else 1)
    assert claim(documents).json()['leases'] == []


def test_sync_reports_owned_idle_workspaces_terminal_cleanup_and_explicit_revocation(documents):
    lease = zip_lease(documents)
    assert freeze(documents, lease).status_code == 200 and complete(documents, lease).status_code == 200
    job_id, absent = lease['job_id'], str(uuid4())
    reply = request(documents, f'/nodes/{documents.v3["node"]["node_id"]}/sync', {'workspace_ids': [job_id, absent]}).json()
    rows = {row['job_id']: row for row in reply['workspaces']}
    assert rows[job_id]['status'] == 'succeeded' and rows[job_id]['workspace_generation'] == 1
    assert rows[absent] == {'job_id': absent, 'workspace_generation': None, 'status': 'revoked', 'phase': 'revoked'}
    other = other_node(documents)
    reply = request(other, f'/nodes/{other.v3["node"]["node_id"]}/sync', {'workspace_ids': [job_id]}).json()
    assert reply['workspaces'][0]['status'] == 'revoked' and reply['workspaces'][0]['workspace_generation'] is None
    assert request(documents, f'/nodes/{documents.v3["node"]["node_id"]}/sync', {'workspace_ids': [absent] * 201}).status_code == 422


@pytest.mark.parametrize(('state', 'expected'), [('pending', 'failed'), ('received', 'failed'),
                                               ('sending', 'outcome_unknown'), ('unknown', 'outcome_unknown')])
def test_offline_owner_has_finite_recovery_grace_without_resending_text(documents, state, expected):
    from app.documents.config import get_document_settings
    job_id = create(documents)
    assert workflow.expire_offline_workspaces() == 0
    with session_factory()() as db:
        db.get(Document, job_id).text_state = state
        db.get(ComputeNode, documents.v3['node']['node_id']).heartbeat_at = now() - timedelta(
            hours=get_document_settings().waiting_retention_hours, seconds=1)
        db.commit()
    assert workflow.expire_offline_workspaces() == 1
    assert workflow.expire_offline_workspaces() == 0
    with session_factory()() as db:
        assert db.get(Job, job_id).status == expected
        assert db.get(Document, job_id).workspace_generation == 1
        assert db.get(QuotaPeriod, documents.period_id).reserved == (1 if expected == 'outcome_unknown' else 0)
        assert workflow.claim_control(db, 'fixture') is None


def test_offline_expiry_skips_active_lease_and_rechecks_reconnected_owner(documents, monkeypatch):
    from app.documents.config import get_document_settings
    job_id = create(documents)
    lease = claim(documents).json()['leases'][0]
    with session_factory()() as db:
        node = db.get(ComputeNode, documents.v3['node']['node_id'])
        node.heartbeat_at = now() - timedelta(hours=get_document_settings().waiting_retention_hours, seconds=1)
        db.commit()
    assert workflow.expire_offline_workspaces() == 0
    assert complete(documents, lease).status_code == 200
    original_lock = workflow.lock_scheduler
    def reconnect(db):
        with session_factory()() as other:
            other.get(ComputeNode, documents.v3['node']['node_id']).heartbeat_at = now()
            other.commit()
        original_lock(db)
    monkeypatch.setattr(workflow, 'lock_scheduler', reconnect)
    assert workflow.expire_offline_workspaces() == 0
    with session_factory()() as db:
        assert db.get(Job, job_id).status == 'running'
        assert db.get(QuotaPeriod, documents.period_id).reserved == 1


def completion_metrics(caplog):
    return [json.loads(record.getMessage().removeprefix('document_compute_complete '))
            for record in caplog.records if record.name == 'uvicorn.error.documents']


def test_zip_head_outside_transaction_and_receipt_short_circuit_with_timings(documents, monkeypatch, caplog):
    from app.documents import compute
    lease = zip_lease(documents)
    assert freeze(documents, lease).status_code == 200
    caplog.clear()
    caplog.set_level(logging.INFO, logger='uvicorn.error.documents')
    clock = iter((10, 10.01, 10.06, 10.06, 10.08, 10.10, 11, 11.005))
    monkeypatch.setattr(compute, 'perf_counter', lambda: next(clock))
    real_scoped, real_verify = compute.scoped, documents.store.verify
    current = {}
    def scoped(db, *args):
        current['db'] = db
        return real_scoped(db, *args)
    def verify(ref):
        assert not current['db'].in_transaction()
        return real_verify(ref)
    monkeypatch.setattr(compute, 'scoped', scoped)
    monkeypatch.setattr(documents.store, 'verify', verify)
    accepted = complete(documents, lease)
    assert accepted.status_code == 200 and complete(documents, lease).json() == accepted.json()
    first, replay = completion_metrics(caplog)
    assert first['head_ms'] == 50 and first['lock_wait_ms'] == 20 and first['total_ms'] == 100
    assert replay['outcome'] == 'replayed' and replay['total_ms'] == 5
    assert replay['head_ms'] == replay['lock_wait_ms'] == replay['artifact_count'] == 0
    assert len(documents.store.verified) == 1
    assert lease['lease_token'] not in caplog.text and lease['output_key'] not in caplog.text


def test_zip_head_failure_and_expiry_are_fenced(documents, monkeypatch, caplog):
    from app.documents.storage import DocumentStoreError
    lease = zip_lease(documents)
    assert freeze(documents, lease).status_code == 200
    caplog.set_level(logging.INFO, logger='uvicorn.error.documents')
    def failure(ref):
        raise DocumentStoreError() from RuntimeError('https://private/?credential=secret')
    monkeypatch.setattr(documents.store, 'verify', failure)
    assert complete(documents, lease).status_code == 503
    assert completion_metrics(caplog)[-1]['outcome'] == 'storage_error'
    assert 'credential=secret' not in caplog.text
    def expire(ref):
        with session_factory()() as db:
            db.get(ExecutionLease, lease['lease_id']).expires_at = now() - timedelta(seconds=1)
            db.commit()
        return ref
    monkeypatch.setattr(documents.store, 'verify', expire)
    assert complete(documents, lease).status_code == 409
    with session_factory()() as db:
        assert db.get(Document, lease['job_id']).output_ref is None
        assert db.get(QuotaPeriod, documents.period_id).reserved == 1


def test_interactive_claim_has_constant_query_count_with_200_document_pages(documents):
    """Local metadata fixture, not a production latency/throughput benchmark."""
    from app.scheduler import release_lease
    from conftest import configure_system_limits
    configure_system_limits(free_daily_pages=20)
    documents.v3['create']()
    def sample():
        statements = []
        def record(_connection, _cursor, statement, *_args):
            statements.append(statement)
        event.listen(engine(), 'before_cursor_execute', record)
        started = perf_counter()
        try:
            response = image_claim(documents.v3)
            elapsed = perf_counter() - started
        finally:
            event.remove(engine(), 'before_cursor_execute', record)
        assert response.status_code == 200 and len(response.json()['leases']) == 1
        with session_factory()() as db:
            lease = db.get(ExecutionLease, response.json()['leases'][0]['lease_id'])
            release_lease(db, lease, 'failed')
            db.get(JobStage, lease.stage_id).status = 'ready'
            db.commit()
        return elapsed, len(statements)
    sample()
    baseline = [sample() for _ in range(5)]
    create(documents, 200)
    backlog = [sample() for _ in range(5)]
    assert {count for _, count in baseline} == {count for _, count in backlog}
    print({'interactive_claim_local_fixture': {
        'no_document_median_ms': round(median(value for value, _ in baseline) * 1000, 2),
        '200_document_pages_median_ms': round(median(value for value, _ in backlog) * 1000, 2)}})
