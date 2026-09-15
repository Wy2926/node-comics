"""Durable fair scheduling and node races; virtual stage times, no model calls."""
import base64
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import hashlib
from io import BytesIO
from threading import Event

import pytest
from PIL import Image
from sqlalchemy import event, func, select

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
    config = snapshot()
    with session_factory()() as db:
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
            db.add(ComputeNode(id='node-' + str(index), name='device', capabilities=['analyze', 'inpaint', 'render'],
                               capacity=1, resource_id='physical-' + str(index), engine_version=config['engine']['version'], device='cpu'))
        db.commit()
    return config


def add_job(config, owner='free-user', *, realtime=False, stage='analyze', suffix=None):
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


def test_late_render_upload_cannot_overwrite_new_generation_output(scheduler_case, monkeypatch):
    config = scheduler_case
    original, old_reply = render_reply(config['engine']['version'], 10)
    _, new_reply = render_reply(config['engine']['version'], 20)
    monkeypatch.setenv('RESULT_STORAGE_BACKEND', 'local')
    settings.cache_clear()
    with session_factory()() as db:
        asset = create_asset(db, 'free-user', original)
        db.commit()
        source_id = asset.id
    job_id = add_job(config, stage='render')
    with session_factory()() as db:
        job = db.get(Job, job_id)
        job.input_asset_id, job.source_sha256 = source_id, hashlib.sha256(original).hexdigest()
        db.commit()
    old = claim()
    started, allow_old_put = Event(), Event()
    put = LocalStore.put
    def delayed(store, key, data, *args, **kwargs):
        if key.endswith('/' + old.id):
            started.set()
            assert allow_old_put.wait(5)
        return put(store, key, data, *args, **kwargs)
    monkeypatch.setattr(LocalStore, 'put', delayed)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(workers.complete_stage, old.id, old_reply, token=old.token, node_id='node-0')
        try:
            assert started.wait(5)
            with session_factory()() as db:
                db.get(ExecutionLease, old.id).expires_at = now() - timedelta(seconds=1)
                db.commit()
            dispatcher.recover_lease(old.id)
            with session_factory()() as db:
                db.get(JobStage, old.stage_id).available_at = now() - timedelta(seconds=1)
                db.commit()
            replacement = claim('node-1')
            assert replacement is not None
            workers.complete_stage(replacement.id, new_reply, token=replacement.token, node_id='node-1')
        finally:
            allow_old_put.set()
        with pytest.raises(ProcessingError, match='LEASE_EXPIRED'):
            future.result(timeout=5)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        assert job.status == 'succeeded' and job.output_asset_id == replacement.id
        asset = db.get(Asset, job.output_asset_id)
        assert LocalStore().read(asset.storage_key) == base64.b64decode(new_reply['image'])


def test_conflicting_completion_of_one_lease_cannot_replace_delivered_bytes(scheduler_case, monkeypatch):
    config = scheduler_case
    original, first_reply = render_reply(config['engine']['version'], 10)
    _, second_reply = render_reply(config['engine']['version'], 20)
    monkeypatch.setenv('RESULT_STORAGE_BACKEND', 'local')
    settings.cache_clear()
    with session_factory()() as db:
        source = create_asset(db, 'free-user', original)
        db.commit()
        source_id = source.id
    job_id = add_job(config, stage='render')
    with session_factory()() as db:
        db.get(Job, job_id).input_asset_id = source_id
        db.commit()
    lease = claim()
    first_started, release_first = Event(), Event()
    put = LocalStore.put
    first_bytes = base64.b64decode(first_reply['image'])
    def delayed(store, key, data, *args, **kwargs):
        if data == first_bytes:
            first_started.set()
            assert release_first.wait(5)
        return put(store, key, data, *args, **kwargs)
    monkeypatch.setattr(LocalStore, 'put', delayed)
    second_accepted = False
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(workers.complete_stage, lease.id, first_reply, token=lease.token, node_id='node-0')
        try:
            assert first_started.wait(5)
            try:
                workers.complete_stage(lease.id, second_reply, token=lease.token, node_id='node-0')
                second_accepted = True
            except ProcessingError:
                pass  # Rejecting conflicting in-flight completion is valid.
        finally:
            release_first.set()
        try:
            future.result(timeout=5)
        except ProcessingError:
            assert second_accepted
    with session_factory()() as db:
        output = db.get(Asset, db.get(Job, job_id).output_asset_id)
        assert output is not None
        data = LocalStore().read(output.storage_key)
        assert hashlib.sha256(data).hexdigest() == output.sha256


def test_saved_late_output_recovery_preserves_existing_terminal_failure(scheduler_case, monkeypatch):
    monkeypatch.setenv('RESULT_STORAGE_BACKEND', 'local')
    settings.cache_clear()
    job_id = add_job(scheduler_case, stage='render')
    lease = claim()
    _, reply = render_reply(scheduler_case['engine']['version'], 10)
    LocalStore().put('free-user/' + lease.id, base64.b64decode(reply['image']), 'image/png', kind='classic')
    with session_factory()() as db:
        job = db.get(Job, job_id)
        job.status, job.error_code, job.error_message = 'failed', 'TEXT_AUTH_FAILED', 'original failure'
        db.get(ExecutionLease, lease.id).expires_at = now() - timedelta(seconds=1)
        db.commit()
    dispatcher.recover_lease(lease.id)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        assert (job.status, job.error_code, job.error_message) == ('failed', 'TEXT_AUTH_FAILED', 'original failure')
        assert job.output_asset_id is None
        assert db.get(ExecutionLease, lease.id).completed_at is not None
