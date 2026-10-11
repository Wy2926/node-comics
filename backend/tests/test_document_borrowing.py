"""Idle page borrowing: real SQL/HTTP, synthetic document/R2 metadata only."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import timedelta
from threading import Barrier, Event

import pytest
from sqlalchemy import event, func, select

from app.db import engine, session_factory
from app.documents import workflow
from app.documents.models import DocumentPage
from app.entitlement_models import QuotaPeriod
from app.models import Job, now
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from app.scheduler import lock_scheduler, release_lease
from conftest import configure_system_limits
from test_compute_v3 import v3, analyze, claim as image_claim
from test_document_compute import documents, create, claim, complete, other_node
from test_document_quota_api import document_case


def configure(case, *, capacity=4, baseline=1):
    with session_factory()() as db:
        node = db.get(ComputeNode, case.v3['node']['node_id'])
        node.capacity = capacity
        node.desired_config = {**node.desired_config, 'execution_slots': capacity, 'document_slots': baseline}
        db.commit()


def ready_render(case, count):
    job_id = create(case, count)
    with session_factory()() as db:
        # Seed the already-persisted OCR/LLM checkpoints, never call a provider.
        for page in db.scalars(select(DocumentPage).where(DocumentPage.job_id == job_id)):
            page.status = 'ocr_done'
            page.analysis_ref = {'sha256': 'd' * 64, 'byte_size': 30, 'mime': 'application/json'}
            page.translations_ref = {'analysis_hash': 'e' * 64, 'language': 'zh-Hans',
                'translations': {'0': 'translated'}, 'revision': 'f' * 64}
            stage = workflow.stage_for(db, job_id, 'doc_ocr', page.page_index)
            stage.status, stage.completed_at = 'succeeded', now()
        stage = workflow.stage_for(db, job_id, 'doc_text')
        stage.status, stage.completed_at = 'succeeded', now()
        workflow.on_stage_completed(db, db.get(Job, job_id), stage)
        db.commit()
    return job_id


def leases(case, request_id=None):
    response = claim(case, request_id)
    assert response.status_code == 200, response.text
    return response.json()['leases']


@contextmanager
def statements():
    values = []
    def record(_connection, _cursor, statement, *_args):
        values.append(' '.join(statement.lower().split()))
    connection = engine()
    event.listen(connection, 'before_cursor_execute', record)
    try:
        yield values
    finally:
        event.remove(connection, 'before_cursor_execute', record)


@pytest.mark.parametrize('action', ['doc_ocr', 'doc_render'])
@pytest.mark.parametrize('capacity', [1, 2, 4])
def test_idle_pages_borrow_total_capacity_with_fifo_and_one_lease_receipts(documents, action, capacity):
    configure(documents, capacity=capacity)
    job_id = (create if action == 'doc_ocr' else ready_render)(documents, 6)
    with session_factory()() as db:
        expected = list(db.scalars(select(JobStage.page_index).where(JobStage.job_id == job_id,
            JobStage.name == action).order_by(JobStage.available_at, JobStage.id).limit(capacity)))
    claimed = [leases(documents)[0] for _ in range(capacity)]
    assert [item['page_index'] for item in claimed] == expected
    assert all(item['action'] == action for item in claimed)
    assert len({item['lease_id'] for item in claimed}) == capacity
    assert leases(documents) == []
    assert not documents.store.puts and not documents.store.verified


def test_disabled_document_slots_preserve_active_and_empty_receipts(documents):
    create(documents, 5)
    active = leases(documents, 'active-before-disable')
    configure(documents, baseline=0)
    with statements() as disabled_sql:
        assert leases(documents, 'disabled-empty') == []
    assert not any('from execution_leases' in sql and 'count(' in sql for sql in disabled_sql)
    assert leases(documents, 'active-before-disable') == active
    configure(documents, baseline=1)
    assert leases(documents, 'disabled-empty') == []
    assert leases(documents)
    assert claim(documents, 'disabled-empty', count=2).status_code == 422


@pytest.mark.parametrize('stage_name', ['doc_prepare', 'doc_zip'])
@pytest.mark.parametrize('baseline', [1, 2])
def test_prepare_and_zip_do_not_borrow_but_ready_pages_can(documents, stage_name, baseline):
    configure(documents, baseline=baseline)
    if stage_name == 'doc_prepare':
        for _ in range(baseline + 1):
            create(documents, prepared=False)
    else:
        # Finish each synthetic OCR before admitting the second file's ZIP.
        for _ in range(baseline + 1):
            job_id = create(documents)
            with session_factory()() as db:
                page = db.get(DocumentPage, (job_id, 1))
                page.status, page.output_ref = 'no_text', page.input_ref
                stage = workflow.stage_for(db, job_id, 'doc_ocr', 1)
                stage.status, stage.completed_at = 'succeeded', now()
                workflow.on_stage_completed(db, db.get(Job, job_id), stage)
                db.commit()
    conservative = [leases(documents)[0] for _ in range(baseline)]
    assert all(item['action'] == stage_name for item in conservative)
    assert leases(documents) == []
    create(documents, 4)
    borrowed = [leases(documents)[0] for _ in range(4 - baseline)]
    assert all(item['action'] == 'doc_ocr' for item in borrowed)
    assert leases(documents) == []


def test_ordinary_arrival_stops_new_document_claims_without_preemption(documents):
    configure(documents, capacity=2)
    create(documents, 5)
    first, second = leases(documents)[0], leases(documents)[0]
    configure_system_limits(free_daily_pages=20)
    documents.v3['create']()
    assert complete(documents, first).status_code == 200
    assert leases(documents, 'ordinary-ready-empty') == []
    ordinary = image_claim(documents.v3).json()['leases'][0]
    assert complete(documents, second).status_code == 200
    conservative = leases(documents)[0]
    assert leases(documents) == []
    with session_factory()() as db:
        assert db.get(ExecutionLease, ordinary['lease_id']).completed_at is None
        assert db.get(ExecutionLease, conservative['lease_id']).completed_at is None
        assert db.get(QuotaPeriod, documents.period_id).reserved == 5
    analyze(documents.v3, ordinary, empty=True)
    # A recorded empty reply never allocates after the queue changes.
    assert leases(documents, 'ordinary-ready-empty') == []
    assert leases(documents)[0]['action'] == 'doc_ocr'


@pytest.mark.parametrize('expired', [False, True])
@pytest.mark.parametrize('baseline', [1, 2])
def test_active_ordinary_keeps_baseline_even_with_spare_capacity(documents, expired, baseline):
    configure(documents, baseline=baseline)
    create(documents, 8)
    configure_system_limits(free_daily_pages=20)
    documents.v3['create']()
    ordinary = image_claim(documents.v3).json()['leases'][0]
    if expired:
        with session_factory()() as db:
            db.get(ExecutionLease, ordinary['lease_id']).expires_at = now() - timedelta(seconds=1)
            db.commit()
    for _ in range(baseline):
        assert leases(documents)
    assert leases(documents) == []
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ExecutionLease).where(
            ExecutionLease.node_id == documents.v3['node']['node_id'],
            ExecutionLease.completed_at.is_(None))) == baseline + 1


def test_capacity_shrink_does_not_revoke_borrowed_pages(documents):
    create(documents, 6)
    borrowed = [leases(documents)[0] for _ in range(4)]
    configure(documents, capacity=2)
    for lease in borrowed[:3]:
        assert leases(documents) == []
        assert complete(documents, lease).status_code == 200
    assert leases(documents)
    assert leases(documents) == []
    with session_factory()() as db:
        assert db.get(ExecutionLease, borrowed[3]['lease_id']).completed_at is None


def test_unrecovered_expired_document_still_occupies_total_capacity(documents):
    configure(documents, capacity=2)
    create(documents, 5)
    first, second = leases(documents)[0], leases(documents)[0]
    with session_factory()() as db:
        db.get(ExecutionLease, first['lease_id']).expires_at = now() - timedelta(seconds=1)
        db.commit()
    assert leases(documents) == []
    with session_factory()() as db:
        release_lease(db, db.get(ExecutionLease, first['lease_id']), 'failed')
        db.commit()
    assert leases(documents)
    with session_factory()() as db:
        assert db.get(ExecutionLease, second['lease_id']).completed_at is None


@pytest.mark.parametrize('ineligible', ['language', 'protocol', 'delayed', 'cancelled', 'capability'])
def test_only_this_nodes_eligible_ordinary_queue_blocks_borrowing(documents, ineligible):
    configure(documents, capacity=2)
    create(documents, 3)
    configure_system_limits(free_daily_pages=20)
    job_id = documents.v3['create']()[0]
    with session_factory()() as db:
        job = db.get(Job, job_id)
        if ineligible == 'language':
            job.target_language = 'ja'
        elif ineligible == 'protocol':
            job.config = {**job.config, 'engine': {**job.config['engine'], 'protocol_version': 2}}
        elif ineligible == 'delayed':
            db.scalar(select(JobStage).where(JobStage.job_id == job_id,
                JobStage.name == 'page')).available_at = now() + timedelta(minutes=1)
        elif ineligible == 'cancelled':
            job.cancel_requested = True
        else:
            node = db.get(ComputeNode, documents.v3['node']['node_id'])
            node.capabilities = [name for name in node.capabilities if name != 'page']
        db.commit()
    assert len(leases(documents)) == len(leases(documents)) == 1


def test_ordinary_active_on_another_resource_does_not_block_borrowing(documents):
    configure(documents, capacity=2)
    create(documents, 3)
    configure_system_limits(free_daily_pages=20)
    documents.v3['create']()
    peer = other_node(documents)
    assert len(image_claim(peer.v3).json()['leases']) == 1
    assert len(leases(documents)) == len(leases(documents)) == 1


def test_parallel_document_claims_share_total_capacity(documents):
    configure(documents, capacity=2)
    create(documents, 20)
    barrier = Barrier(6)
    def attempt(_):
        barrier.wait(timeout=10)
        return leases(documents)
    with ThreadPoolExecutor(6) as pool:
        replies = list(pool.map(attempt, range(6)))
    ids = [lease['lease_id'] for reply in replies for lease in reply]
    assert len(ids) == len(set(ids)) == 2


def test_parallel_mixed_claims_prioritize_ordinary_and_keep_baseline(documents):
    create(documents, 20)
    configure_system_limits(free_daily_pages=20)
    documents.v3['create'](2)
    barrier = Barrier(6)
    def attempt(index):
        barrier.wait(timeout=10)
        response = image_claim(documents.v3) if index < 3 else claim(documents)
        assert response.status_code == 200, response.text
        return response.json()['leases']
    with ThreadPoolExecutor(6) as pool:
        replies = list(pool.map(attempt, range(6)))
    assert sum(map(len, replies[:3])) == 2
    assert sum(map(len, replies[3:])) <= 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ExecutionLease).where(
            ExecutionLease.node_id == documents.v3['node']['node_id'],
            ExecutionLease.completed_at.is_(None))) <= 3


def test_document_claim_rechecks_ordinary_ready_after_scheduler_lock(documents, monkeypatch):
    from app.documents import compute
    create(documents, 3)
    configure_system_limits(free_daily_pages=20)
    job_id = documents.v3['create']()[0]
    with session_factory()() as db:
        stage = db.scalar(select(JobStage).where(JobStage.job_id == job_id, JobStage.name == 'page'))
        stage.status = 'waiting'
        stage_id = stage.id
        db.commit()
    entered = Event()
    def observed_lock(db):
        entered.set()
        lock_scheduler(db)
    monkeypatch.setattr(compute, 'lock_scheduler', observed_lock)
    with session_factory()() as db:
        lock_scheduler(db)
        db.get(JobStage, stage_id).status = 'ready'
        with ThreadPoolExecutor(1) as pool:
            pending = pool.submit(leases, documents, 'intervening-ordinary')
            try:
                assert entered.wait(timeout=10)
            finally:
                db.commit()
            assert pending.result(timeout=10) == []
    assert image_claim(documents.v3).json()['leases']


def test_claim_query_budget_is_one_aggregate_one_exists_independent_of_backlog(documents):
    configure(documents, capacity=2)
    create(documents)
    def sample():
        with statements() as sql:
            claimed = leases(documents)[0]
        aggregates = [value for value in sql if 'from execution_leases' in value and 'count(' in value]
        probes = [value for value in sql if 'select exists' in value and 'from job_stages' in value]
        assert len(aggregates) == len(probes) == 1
        assert 'filter (where job_stages.name in' in aggregates[0]
        assert 'order by' not in probes[0] and 'count(' not in probes[0]
        candidates = [value for value in sql if 'join documents on' in value and 'order by' in value]
        assert len(candidates) == 1 and 'limit' in candidates[0]
        with session_factory()() as db:
            lease = db.get(ExecutionLease, claimed['lease_id'])
            release_lease(db, lease, 'failed')
            db.get(JobStage, lease.stage_id).status = 'ready'
            db.commit()
        return len(sql)
    sample()  # First claim also creates the Job attempt; compare warmed claims.
    baseline = sample()
    create(documents, 200)
    assert sample() == baseline
    leases(documents)
    leases(documents)
    with statements() as full_sql:
        assert leases(documents, 'full-empty') == []
    assert sum('from execution_leases' in sql and 'count(' in sql for sql in full_sql) == 1
    assert not any('select exists' in sql for sql in full_sql)
    with statements() as replay_sql:
        assert leases(documents, 'full-empty') == []
    assert not any('count(' in sql or 'select exists' in sql for sql in replay_sql)
