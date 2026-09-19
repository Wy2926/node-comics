"""Durable fair scheduling and node races; virtual stage times, no model calls."""
import base64
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import hashlib
from io import BytesIO
from threading import Barrier, Event

import pytest
from PIL import Image
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session

from app import dispatcher, scheduler, workers
from app.assets import create_asset
from app.config import settings
from app.db import engine, session_factory
from app.errors import ProcessingError
from app.models import Asset, ClassicState, Job, User, now, uid
from app.queue_models import ComputeNode, ExecutionLease, FairnessState, JobStage
from app.scheduler import claim_stage, current_lease, lock_scheduler, release_lease
from app.storage import LocalStore
from test_classic import encoded, text_database


@pytest.fixture
def scheduler_case(text_database):
    from app.classic_config import snapshot
    with session_factory()() as db:
        config = snapshot(db)
        free = User(id='free-user', subject='isolated-free', name='free')
        plus = User(id='plus-user', subject='isolated-plus', name='plus', membership_id=uid(),
                    plus_started_at=now() - timedelta(days=1), plus_expires_at=now() + timedelta(days=30),
                    plus_timezone='Asia/Shanghai', plus_monthly_pages=300)
        db.add_all([free, plus])
        db.flush()
        for owner in (free, plus):
            db.add(Asset(id=owner.id + '-image', owner_id=owner.id, sha256='a' * 64,
                         storage_key='isolated/' + owner.id, storage_backend='r2', mime='image/png',
                         width=80, height=64, byte_size=100, expires_at=now() + timedelta(days=1)))
        for index in range(4):
            db.add(ComputeNode(applied_config_version=1, supported_languages=['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko'], id='node-' + str(index), name='device', capabilities=['page'],
                               capacity=1, resource_id='physical-' + str(index), engine_version=config['engine']['version'], device='cpu'))
        db.commit()
    return config


def add_job(config, owner='free-user', *, realtime=False, stage='page', suffix=None):
    job_id = suffix or uid()
    with session_factory()() as db:
        job = Job(id=job_id, owner_id=owner, input_asset_id=owner + '-image', source_sha256='a' * 64,
                  mode='classic', target_language='zh-Hans', status='queued', quota_pages=0, quota_kind='unlimited',
                  settlement='free', config=config, operation='translate', request_hash='r' * 64,
                  idempotency_key=uid(), cache_key=hashlib.sha256(job_id.encode()).hexdigest(),
                  realtime_until=now() + timedelta(hours=1) if realtime else None)
        db.add(job)
        db.flush()
        db.add(JobStage(job_id=job_id, name=stage, status='ready'))
        db.add(ClassicState(job_id=job_id, analysis={'segments': [], 'quality_flags': []}))
        db.commit()
    return job_id


def claim(node='node-0'):
    with session_factory()() as db:
        lease = claim_stage(db, node)
        db.commit()
        return lease


def finish_quantum(lease_id, actual_seconds=1, *, rearm=True):
    """Measure known virtual work rather than wall-clock database test overhead."""
    with session_factory()() as db:
        lock_scheduler(db)
        lease = db.get(ExecutionLease, lease_id)
        lease.started_at = now() - timedelta(seconds=actual_seconds)
        lease.expires_at = now() + timedelta(minutes=5)
        release_lease(db, lease, 'succeeded')
        stage, job = db.get(JobStage, lease.stage_id), db.get(Job, lease.job_id)
        stage.status = 'ready' if rearm else 'succeeded'
        job.status = 'queued' if rearm else 'succeeded'
        db.commit()


def test_free_realtime_precedes_member_preload(scheduler_case):
    add_job(scheduler_case, 'plus-user')
    realtime = add_job(scheduler_case, 'free-user', realtime=True)
    assert claim().job_id == realtime


def test_server_slot_reduction_and_pending_configuration_preserve_current_leases(scheduler_case):
    for _ in range(4):
        add_job(scheduler_case)
    with session_factory()() as db:
        db.get(ComputeNode, 'node-0').capacity = 2
        db.commit()
    first, second = claim(), claim()
    assert first and second and claim() is None
    with session_factory()() as db:
        node = db.get(ComputeNode, 'node-0')
        node.capacity, node.config_version = 1, 2
        db.commit()
        assert current_lease(db, first.id, first.token)[0].id == first.id
    assert claim() is None
    finish_quantum(first.id, rearm=False)
    finish_quantum(second.id, rearm=False)
    assert claim() is not None and claim() is None


def test_node_language_routing_does_not_consume_unsupported_work(scheduler_case):
    job = add_job(scheduler_case)
    with session_factory()() as db:
        db.get(ComputeNode, 'node-0').supported_languages = ['en']
        db.commit()
    assert claim() is None
    assert claim('node-1').job_id == job


def test_realtime_continuous_load_preserves_preload_service(scheduler_case):
    add_job(scheduler_case, 'plus-user', realtime=True)
    add_job(scheduler_case, 'free-user')
    counts = Counter()
    for _ in range(100):
        lease = claim()
        assert lease is not None
        counts[lease.priority_class] += 1
        finish_quantum(lease.id)
    assert 7 <= counts['preload'] <= 13, counts
    assert counts['realtime'] >= 87, counts


def test_plus_weight_two_gets_twice_service_without_preload_promotion(scheduler_case):
    add_job(scheduler_case, 'free-user')
    add_job(scheduler_case, 'plus-user')
    counts = Counter()
    for _ in range(120):
        lease = claim()
        counts[lease.owner_id] += 1
        assert lease.priority_class == 'preload'
        finish_quantum(lease.id)
    ratio = counts['plus-user'] / counts['free-user']
    assert 1.8 <= ratio <= 2.2, counts


def test_one_user_can_borrow_all_real_device_slots(scheduler_case):
    jobs = {add_job(scheduler_case) for _ in range(5)}
    leases = [claim('node-' + str(index)) for index in range(4)]
    assert len({lease.job_id for lease in leases}) == 4
    assert all(lease.job_id in jobs for lease in leases)
    assert claim('node-0') is None
    finish_quantum(leases[0].id, rearm=False)
    assert claim('node-0') is not None


def test_election_queries_do_not_grow_per_page_in_a_500_page_preload(scheduler_case):
    add_job(scheduler_case, 'plus-user')
    def measured_claim():
        statements = []
        def record(connection, cursor, statement, parameters, context, many):
            if statement.lstrip().upper().startswith('SELECT'):
                statements.append(statement)
        event.listen(engine(), 'before_cursor_execute', record)
        try:
            lease = claim()
        finally:
            event.remove(engine(), 'before_cursor_execute', record)
        return lease, len(statements)
    first, small = measured_claim()
    finish_quantum(first.id, rearm=False)
    for _ in range(500):
        add_job(scheduler_case, 'plus-user')
    second, large = measured_claim()
    assert second is not None
    assert large <= small + 3, {'one_page_selects': small, '500_page_selects': large}
    assert large < 25


def test_concurrent_nodes_never_lease_same_stage_twice(scheduler_case):
    job = add_job(scheduler_case)
    with ThreadPoolExecutor(max_workers=4) as pool:
        leases = list(pool.map(claim, ['node-0', 'node-1', 'node-2', 'node-3']))
    accepted = [lease for lease in leases if lease]
    assert len(accepted) == 1 and accepted[0].job_id == job


def test_default_pool_concurrent_claims_do_not_checkout_nested_connections(scheduler_case, monkeypatch):
    job = add_job(scheduler_case)
    pool = engine().pool
    assert pool.size() == 5 and pool._max_overflow == 10
    # Keep the actual default 15-connection ceiling; shorten only the failure
    # timeout so the previous nested-checkout deadlock fails promptly.
    monkeypatch.setattr(pool, '_timeout', .5)
    synchronized = Barrier(15)
    original = scheduler._preselect

    def preselect(db, node, stages):
        # Every claimant already holds its initial node-query connection.
        synchronized.wait(timeout=10)
        return original(db, node, stages)

    monkeypatch.setattr(scheduler, '_preselect', preselect)
    with ThreadPoolExecutor(max_workers=15) as executor:
        leases = list(executor.map(lambda _: claim(), range(15)))
    accepted = [lease for lease in leases if lease]
    assert len(accepted) == 1 and accepted[0].job_id == job


@pytest.mark.parametrize('flush_first', [False, True])
def test_claim_uses_one_connection_and_preserves_caller_uncommitted_writes(scheduler_case, flush_first):
    # One connection cannot support a hidden snapshot Session. The pending
    # node/page must be visible to the election without committing its caller.
    options = {'connect_args': {'check_same_thread': False, 'timeout': 30}} if engine().dialect.name == 'sqlite' else {}
    single = create_engine(engine().url, pool_size=1, max_overflow=0, pool_timeout=.5, **options)
    if single.dialect.name == 'sqlite':
        @event.listens_for(single, 'connect')
        def foreign_keys(connection, _):
            connection.execute('PRAGMA foreign_keys=ON')
    node_id, job_id, stage_id = uid(), uid(), uid()
    try:
        with Session(bind=single) as db:
            lock_scheduler(db)
            db.add(Job(id=job_id, owner_id='free-user', input_asset_id='free-user-image',
                source_sha256='a' * 64, mode='classic', target_language='zh-Hans',
                status='queued', quota_pages=0, quota_kind='unlimited', settlement='free',
                config=scheduler_case, operation='pending-claim-test', request_hash='r' * 64,
                idempotency_key=uid(), cache_key=hashlib.sha256(job_id.encode()).hexdigest()))
            # The schema has no ORM relationships: insert the parent before its
            # stage, as create_job does, while keeping the whole transaction open.
            db.flush()
            db.add(ComputeNode(id=node_id, name='pending node', resource_id=node_id,
                capabilities=['page'], capacity=1, engine_version=scheduler_case['engine']['version'],
                device='cpu', supported_languages=['zh-Hans'], applied_config_version=1))
            db.add(JobStage(id=stage_id, job_id=job_id, name='page', status='ready'))
            db.add(ClassicState(job_id=job_id, analysis={'segments': [], 'quality_flags': []}))
            if flush_first:
                db.flush()
            lease = claim_stage(db, node_id)
            assert lease is not None and lease.job_id == job_id
            lease_id = lease.id
            db.rollback()
        with Session(bind=single) as db:
            assert db.get(ComputeNode, node_id) is None
            assert db.get(Job, job_id) is None
            assert db.get(JobStage, stage_id) is None
            assert db.get(ExecutionLease, lease_id) is None
    finally:
        single.dispose()


def test_claim_locks_scheduler_before_autoflushing_caller_job_changes(scheduler_case):
    job_id = add_job(scheduler_case)
    statements = []

    def record(connection, cursor, statement, parameters, context, many):
        statements.append(statement.lower())

    with session_factory()() as db:
        # Cache the node first: db.get must not accidentally mask the election's
        # own autoflush behavior by issuing another node query.
        node = db.get(ComputeNode, 'node-0')
        job = db.get(Job, job_id)
        job.priority_rank = 7
        event.listen(engine(), 'before_cursor_execute', record)
        try:
            assert claim_stage(db, node.id).job_id == job_id
            assert job.priority_rank == 7
        finally:
            event.remove(engine(), 'before_cursor_execute', record)
            db.rollback()
    lock = next(index for index, statement in enumerate(statements)
        if 'pg_advisory_xact_lock' in statement or statement.startswith('update scheduler_mutex'))
    write = next(index for index, statement in enumerate(statements) if statement.startswith('update jobs'))
    assert lock < write, statements


def test_deep_queue_is_ranked_in_database_without_loading_each_job(scheduler_case):
    """A recently arriving low-service user is visible behind a large backlog."""
    for index in range(80):
        add_job(scheduler_case, 'plus-user', suffix=f'backlog-{index:04}')
    expected = add_job(scheduler_case, 'free-user')
    loaded = []
    def capture(job, context):
        loaded.append(job.id)
    event.listen(Job, 'load', capture)
    try:
        winner = claim()
    finally:
        event.remove(Job, 'load', capture)
    assert winner.job_id == expected
    assert len(loaded) <= 2, len(loaded)


def test_ineligible_heads_do_not_hide_later_runnable_pages(scheduler_case):
    from app.queue_models import UserModeQueue
    for index in range(20):
        job_id = add_job(scheduler_case, 'free-user')
        with session_factory()() as db:
            job = db.get(Job, job_id)
            job.target_language = 'unavailable-language'
            db.commit()
    for _ in range(20):
        add_job(scheduler_case, 'plus-user')
    with session_factory()() as db:
        db.add(UserModeQueue(owner_id='plus-user', mode='classic', paused=True))
        db.commit()
    expected = add_job(scheduler_case, 'free-user')
    assert claim().job_id == expected


@pytest.mark.parametrize('mutation', ['pause', 'delete_source', 'cancel', 'node_language', 'node_capacity'])
def test_snapshot_candidates_are_revalidated_after_queue_or_node_changes(scheduler_case, monkeypatch, mutation):
    from app.queue_models import UserModeQueue
    job_id = add_job(scheduler_case)
    original = scheduler._preselect
    def changed(db, node, stages):
        result = original(db, node, stages)
        assert result
        with session_factory()() as writer:
            if mutation == 'pause':
                writer.add(UserModeQueue(owner_id='free-user', mode='classic', paused=True, version=1))
            elif mutation == 'delete_source':
                writer.get(Asset, 'free-user-image').deleted_at = now()
            elif mutation == 'cancel':
                writer.get(Job, job_id).cancel_requested = True
            elif mutation == 'node_language':
                writer.get(ComputeNode, 'node-0').supported_languages = ['en']
            else:
                writer.get(ComputeNode, 'node-0').capacity = 0
            writer.commit()
        return result
    monkeypatch.setattr(scheduler, '_preselect', changed)
    assert claim() is None


def test_realtime_reorder_between_snapshot_and_lock_retries_fresh_election(scheduler_case, monkeypatch):
    from app.queue_models import UserModeQueue
    add_job(scheduler_case)
    promoted = add_job(scheduler_case)
    original = scheduler._preselect
    def changed(db, node, stages):
        result = original(db, node, stages)
        with session_factory()() as writer:
            writer.add(UserModeQueue(owner_id='free-user', mode='classic', version=1))
            job = writer.get(Job, promoted)
            job.realtime_until, job.priority_rank = now() + timedelta(minutes=1), 0
            writer.commit()
        return result
    monkeypatch.setattr(scheduler, '_preselect', changed)
    assert claim() is None
    monkeypatch.setattr(scheduler, '_preselect', original)
    assert claim().job_id == promoted


def test_local_missing_source_is_not_dispatched_and_pinned_source_survives_expiry(scheduler_case):
    job_id = add_job(scheduler_case)
    with session_factory()() as db:
        source = db.get(Asset, 'free-user-image')
        source.expires_at, source.active_references = now() - timedelta(days=1), 1
        db.commit()
    lease = claim()
    assert lease and lease.job_id == job_id
    finish_quantum(lease.id)
    with session_factory()() as db:
        db.get(Asset, 'free-user-image').storage_backend = 'local'
        db.commit()
    assert claim() is None


def test_missing_local_head_releases_reservation_once_and_unblocks_later_page(scheduler_case):
    from app.entitlements import reserve
    from app.entitlement_models import QuotaPeriod
    from app.models import Ledger
    missing = add_job(scheduler_case)
    valid = add_job(scheduler_case)
    with session_factory()() as db:
        source = db.get(Asset, 'free-user-image')
        source.storage_backend, source.active_references = 'local', 1
        source.expires_at = None
        first = db.get(Job, missing)
        first.quota_kind, first.input_pinned = 'classic_daily', True
        reserve(db, db.get(User, 'free-user'), first, now())
        db.add(Asset(id='later-valid-source', owner_id='free-user', sha256='b' * 64,
            storage_backend='r2', storage_key='isolated/valid-later', mime='image/png',
            width=80, height=64, byte_size=100))
        db.get(Job, valid).input_asset_id = 'later-valid-source'
        db.commit()
    assert claim() is None  # This bounded election retires only the missing head.
    with session_factory()() as db:
        first = db.get(Job, missing)
        assert first.status == 'failed' and first.error_code == 'LOCAL_SOURCE_MISSING'
        assert first.settlement == 'released' and not first.input_pinned
        assert db.get(Asset, 'free-user-image').active_references == 0
        assert db.scalar(select(QuotaPeriod)).reserved == 0
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'release')) == 1
    assert claim().job_id == valid
    assert claim('node-1') is None
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'release')) == 1


@pytest.mark.parametrize('mutation', ['disabled', 'unknown_slot'])
def test_provider_capacity_is_rechecked_after_snapshot(scheduler_case, monkeypatch, mutation):
    from app.models import Provider
    config = {**scheduler_case, 'provider': {'id': 'isolated-redraw'}}
    add_job(config, stage='redraw')
    occupied = add_job(config, 'plus-user', stage='redraw')
    with session_factory()() as db:
        for job in db.scalars(select(Job)):
            job.mode = 'redraw'
        db.add(Provider(id='isolated-redraw', config={'concurrency': 1}, enabled=True))
        node = db.get(ComputeNode, 'node-0')
        node.capabilities, node.engine_version = ['redraw'], 'control'
        db.commit()
    original = scheduler._preselect
    def changed(db, node, stages):
        result = original(db, node, stages)
        assert result
        with session_factory()() as writer:
            if mutation == 'disabled':
                writer.get(Provider, 'isolated-redraw').enabled = False
            else:
                writer.get(Job, occupied).status = 'outcome_unknown'
            writer.commit()
        return result
    monkeypatch.setattr(scheduler, '_preselect', changed)
    assert claim() is None


def test_concurrent_claims_cannot_exceed_one_node_capacity(scheduler_case):
    for _ in range(4):
        add_job(scheduler_case)
    with ThreadPoolExecutor(max_workers=4) as pool:
        leases = list(pool.map(lambda _: claim(), range(4)))
    assert sum(lease is not None for lease in leases) == 1


def test_wrong_engine_or_disabled_device_does_not_take_work(scheduler_case):
    add_job(scheduler_case)
    with session_factory()() as db:
        db.get(ComputeNode, 'node-0').engine_version = 'wrong'
        db.get(ComputeNode, 'node-1').enabled = False
        db.commit()
    assert claim('node-0') is None
    assert claim('node-1') is None
    assert claim('node-2') is not None


def test_expired_image_lease_recovers_once_and_fences_old_generation(scheduler_case):
    job = add_job(scheduler_case)
    first = claim()
    with session_factory()() as db:
        db.get(ExecutionLease, first.id).expires_at = now() - timedelta(seconds=1)
        db.commit()
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(dispatcher.recover_lease, [first.id, first.id]))
    with session_factory()() as db:
        stage = db.get(JobStage, first.stage_id)
        assert stage.status == 'ready'
        stage.available_at = now() - timedelta(seconds=1)
        db.commit()
    second = claim('node-1')
    assert second.job_id == job and second.generation == first.generation + 1
    with session_factory()() as db:
        with pytest.raises(ProcessingError, match='LEASE_EXPIRED'):
            current_lease(db, first.id, first.token)
        assert current_lease(db, second.id, second.token)[2].id == job


def test_actual_work_correction_preserves_fair_resource_time(scheduler_case, monkeypatch):
    monkeypatch.setenv('PLUS_SCHEDULER_WEIGHT', '1')
    settings.cache_clear()
    add_job(scheduler_case, 'free-user')
    add_job(scheduler_case, 'plus-user')
    served = Counter()
    counts = Counter()
    for _ in range(220):
        lease = claim()
        duration = .1 if lease.owner_id == 'free-user' else 10
        served[lease.owner_id] += duration
        counts[lease.owner_id] += 1
        finish_quantum(lease.id, actual_seconds=duration)
    # Equal-weight accounts get comparable resource time, not comparable page
    # counts; permit one indivisible 10-second heavy stage of discrepancy.
    assert abs(served['free-user'] - served['plus-user']) <= 11, (counts, served)


def test_stale_recovery_observation_cannot_end_renewed_lease(scheduler_case):
    add_job(scheduler_case)
    lease = claim()
    # Maintenance already observed an expired row, but a previously admitted
    # heartbeat committed before maintenance took its final transaction lock.
    with session_factory()() as db:
        db.get(ExecutionLease, lease.id).expires_at = now() + timedelta(minutes=5)
        db.commit()
    workers.fail_stage(lease.id, ProcessingError('WORKER_LEASE_EXPIRED', 'stale observation'), recovering=True)
    with session_factory()() as db:
        assert db.get(ExecutionLease, lease.id).completed_at is None
        assert db.get(JobStage, lease.stage_id).status == 'running'


def render_reply(version, value):
    source = Image.new('RGB', (80, 64), (255, 255, 255))
    target = source.copy()
    target.putpixel((10, 10), (value, value, value))
    mask = Image.new('L', source.size, 0)
    mask.putpixel((10, 10), 255)
    original = base64.b64decode(encoded(source))
    return original, {'image': encoded(target), 'mask': encoded(mask), 'glyph_mask': encoded(mask),
                      'version': version, 'width': 80, 'height': 64, 'input_hash': hashlib.sha256(original).hexdigest()}


def test_saved_late_output_recovery_preserves_existing_terminal_failure(scheduler_case, monkeypatch):
    monkeypatch.setenv('RESULT_STORAGE_BACKEND', 'local')
    settings.cache_clear()
    job_id = add_job(scheduler_case, stage='page')
    lease = claim()
    _, reply = render_reply(scheduler_case['engine']['version'], 10)
    from app.assets import content_storage_key
    image = base64.b64decode(reply['image'])
    output_key = content_storage_key(hashlib.sha256(image).hexdigest())
    LocalStore().put(output_key, image, 'image/png', kind='classic')
    with session_factory()() as db:
        job = db.get(Job, job_id)
        job.status, job.error_code, job.error_message = 'failed', 'TEXT_AUTH_FAILED', 'original failure'
        db.get(ExecutionLease, lease.id).expires_at = now() - timedelta(seconds=1)
        db.get(ExecutionLease, lease.id).output_key = output_key
        db.commit()
    dispatcher.recover_lease(lease.id)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        assert (job.status, job.error_code, job.error_message) == ('failed', 'TEXT_AUTH_FAILED', 'original failure')
        assert job.output_asset_id is None
        assert db.get(ExecutionLease, lease.id).completed_at is not None
