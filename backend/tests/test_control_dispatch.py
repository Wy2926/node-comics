"""Bounded admission and event-driven refill; no model or object-store calls."""
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import nullcontext
from datetime import timedelta
from threading import Event
from types import SimpleNamespace

from sqlalchemy import func, select

from app import scheduler, workers
from app.db import session_factory
from app.models import Job, Provider, now
from app.queue_models import ComputeNode, ExecutionLease, FairnessState, JobStage
from test_cluster_scheduler import add_job, scheduler_case  # noqa: F401
from test_classic import text_database  # noqa: F401


def set_capacity(capacity):
    with session_factory()() as db:
        db.get(ComputeNode, 'node-0').capacity = capacity
        db.commit()


def test_batch_preserves_per_page_weighted_order(scheduler_case):
    for _ in range(8):
        add_job(scheduler_case, 'free-user')
        add_job(scheduler_case, 'plus-user')
    set_capacity(8)
    with session_factory()() as db:
        expected = [scheduler.claim_stage(db, 'node-0').job_id for _ in range(4)]
        db.rollback()
    with session_factory()() as db:
        actual = scheduler.claim_batch(db, 'node-0')
        assert [lease.job_id for lease in actual] == expected
        assert len({lease.owner_id for lease in actual}) == 2
        db.rollback()


def test_batch_elects_backlog_once_and_honors_capacity(scheduler_case, monkeypatch):
    for _ in range(12):
        add_job(scheduler_case)
    set_capacity(7)
    calls = []
    election = scheduler._election_rows
    def observed(*args, **kwargs):
        calls.append(kwargs.get('stage_ids'))
        return election(*args, **kwargs)
    monkeypatch.setattr(scheduler, '_election_rows', observed)
    with session_factory()() as db:
        first = scheduler.claim_batch(db, 'node-0', limit=100)
        db.commit()
        assert len(first) == 4
        assert sum(ids is None for ids in calls) == 1
        assert all(len(ids) <= 20 for ids in calls if ids is not None)
        second = scheduler.claim_batch(db, 'node-0')
        db.commit()
        assert len(second) == 3
        assert not scheduler.claim_batch(db, 'node-0')
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == 7


def test_concurrent_batches_never_overbook_or_duplicate(scheduler_case):
    for _ in range(12):
        add_job(scheduler_case)
    set_capacity(5)
    def claim(_):
        with session_factory()() as db:
            leases = scheduler.claim_batch(db, 'node-0')
            db.commit()
            return [lease.stage_id for lease in leases]
    with ThreadPoolExecutor(max_workers=3) as pool:
        stages = [stage for batch in pool.map(claim, range(3)) for stage in batch]
    assert 4 <= len(stages) <= 5
    assert len(stages) == len(set(stages))
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == len(stages)


def test_batch_rechecks_supplier_concurrency_after_each_pick(scheduler_case):
    config = {**scheduler_case, 'provider': {'id': 'batch-redraw'}}
    for _ in range(5):
        add_job(config, stage='redraw')
    with session_factory()() as db:
        node = db.get(ComputeNode, 'node-0')
        node.capacity, node.capabilities, node.engine_version = 8, ['redraw'], 'control'
        db.add(Provider(id='batch-redraw', enabled=True, config={'concurrency': 1}))
        for job in db.scalars(select(Job)):
            job.mode = 'redraw'
        db.commit()
        leases = scheduler.claim_batch(db, node.id)
        db.commit()
        assert len(leases) == 1
        assert not scheduler.claim_batch(db, node.id)


def test_prepared_batch_revalidates_and_does_not_repeat_full_election(scheduler_case, monkeypatch):
    jobs = [add_job(scheduler_case) for _ in range(5)]
    set_capacity(4)
    with session_factory()() as db:
        prepared = scheduler.prepare_claim_candidates(db, 'node-0')
        with session_factory()() as writer:
            writer.get(Job, jobs[0]).cancel_requested = True
            writer.get(ComputeNode, 'node-0').capacity = 2
            writer.commit()
        original = scheduler._election_rows
        def bounded(*args, **kwargs):
            assert kwargs.get('stage_ids') is not None
            return original(*args, **kwargs)
        monkeypatch.setattr(scheduler, '_election_rows', bounded)
        leases = scheduler.claim_batch(db, 'node-0', prepared=prepared)
        db.commit()
        assert len(leases) == 2
        assert jobs[0] not in {lease.job_id for lease in leases}


def test_claimability_check_does_not_create_leases_or_fairness(scheduler_case):
    job_id = add_job(scheduler_case)
    with session_factory()() as db:
        heartbeat = db.get(ComputeNode, 'node-0').heartbeat_at
        assert scheduler.has_claimable_work(db, 'node-0', ['page'])
        assert not scheduler.has_claimable_work(db, 'node-0', ['page'], config_version=99)
        assert not scheduler.has_claimable_work(db, 'node-0', ['text'])
        assert not db.new and not db.dirty
        assert db.scalar(select(func.count()).select_from(ExecutionLease)) == 0
        assert db.scalar(select(func.count()).select_from(FairnessState)) == 0
        assert db.get(Job, job_id).status == 'queued'
        assert db.get(ComputeNode, 'node-0').heartbeat_at == heartbeat
        scheduler.claim_stage(db, 'node-0')
        db.commit()
        assert not scheduler.has_claimable_work(db, 'node-0', ['page'])


def test_claimability_uses_latest_allowed_runtime_languages(scheduler_case):
    add_job(scheduler_case)
    with session_factory()() as db:
        node = db.get(ComputeNode, 'node-0')
        node.supported_languages = ['en']
        node.runtime_report = {'protocol_version': 3, 'languages': ['en', 'zh-Hans']}
        node.desired_config = {**node.desired_config, 'allowed_languages': ['en', 'zh-Hans']}
        db.commit()
        assert scheduler.has_claimable_work(db, 'node-0', ['page'])
        assert node.supported_languages == ['en'] and not db.dirty
        node.desired_config = {**node.desired_config, 'allowed_languages': ['en']}
        db.commit()
        assert not scheduler.has_claimable_work(db, 'node-0', ['page'])


def test_dispatch_refills_without_prefetch_and_rotates_pools(monkeypatch):
    pending, order = [], []
    class Executor:
        def submit(self, function, lease_id):
            future = Future()
            pending.append(future)
            return future
    def claim(db, node_id, stages, *, limit, executor_id):
        order.append(stages[0])
        return [SimpleNamespace(id=f'{node_id}-{len(pending)}-{index}') for index in range(limit)]
    monkeypatch.setattr(workers, 'session_factory', lambda: lambda: nullcontext(SimpleNamespace(commit=lambda: None)))
    monkeypatch.setattr(workers, 'claim_batch', claim)
    wake, stopping = Event(), Event()
    dispatch = workers.ControlDispatcher(Executor(), 'test-worker', {'text': 8, 'redraw': 8, 'validate_upload': 4}, wake)
    assert dispatch.dispatch(stopping) == 12
    assert order == ['text', 'redraw', 'validate_upload']
    assert dispatch.dispatch(stopping) == 8
    assert order[3:] == ['redraw', 'validate_upload']
    assert dispatch.dispatch(stopping) == 0
    assert len(pending) == len(dispatch.futures) == 20
    pending[0].set_result(None)
    assert wake.is_set()
    dispatch.reap()
    assert dispatch.dispatch(stopping) == 1
    assert len(dispatch.futures) == 20


def test_idle_delay_tracks_retry_deadline(scheduler_case):
    job_id = add_job(scheduler_case, stage='text')
    with session_factory()() as db:
        stage = db.scalar(select(JobStage).where(JobStage.job_id == job_id))
        stage.available_at = now() + timedelta(seconds=.4)
        db.commit()
        assert 0 < scheduler.next_control_delay(db) <= .4
        stage.available_at = now() + timedelta(seconds=30)
        db.commit()
        assert scheduler.next_control_delay(db) == 5


def test_worker_rechecks_crossed_deadline_before_sleep_without_local_overbooking(scheduler_case, monkeypatch):
    at = now()
    monkeypatch.setattr(scheduler, 'now', lambda: at)
    job_id = add_job(scheduler_case, stage='text')
    with session_factory()() as db:
        db.add(ComputeNode(id='control-text', name='text', resource_id='control-text', capabilities=['text'],
            capacity=1, engine_version='control', device='network'))
        stage = db.scalar(select(JobStage).where(JobStage.job_id == job_id))
        stage.available_at = at + timedelta(seconds=1)
        db.commit()
    class Executor:
        def submit(self, function, lease_id):
            return Future()
    dispatch = workers.ControlDispatcher(Executor(), 'test-worker', {'text': 1}, Event())
    assert dispatch.dispatch(Event()) == 0
    at += timedelta(seconds=2)
    assert dispatch.idle_delay(5) == 0
    # Completed durable work may still be draining its local thread. No spare
    # local executor thread means waiting for its done event, not a busy loop.
    placeholder = Future()
    dispatch.futures[placeholder] = 'finishing-local-thread'
    assert dispatch.idle_delay(5) == 5
    del dispatch.futures[placeholder]
    assert dispatch.dispatch(Event()) == 1
    assert dispatch.idle_delay(5) == 5


def test_idle_delay_tracks_supplier_limit_without_reserving(scheduler_case, monkeypatch):
    from admission_test_utils import freeze_clock, window_count
    from app.redis_state import window
    from app.translation_models import TranslationProvider
    add_job(scheduler_case, stage='text')
    clock = [now()]
    freeze_clock(monkeypatch, clock)
    with session_factory()() as db:
        provider = db.get(TranslationProvider, scheduler_case['text']['provider_id'])
        provider.requests_per_minute = 1
        db.commit()
        window('provider', provider.id, 1, member='existing-call')
        clock[0] += timedelta(seconds=59)
        assert scheduler.next_control_delay(db) == 1
        assert window_count('provider', provider.id) == 1


def test_thread_wakeup_requires_commit(scheduler_case):
    from app.notifications import close_hub, hub, publish
    notices = hub()
    notices.start()
    if notices.bind.dialect.name == 'postgresql':
        assert notices.ready.wait(5)
    with notices.subscribe_thread('compute') as wake:
        with session_factory()() as db:
            publish(db, 'compute')
            assert not wake.is_set()
            db.rollback()
            assert not wake.is_set()
            publish(db, 'compute')
            assert not wake.is_set()
            db.commit()
            assert wake.wait(.5)
        wake.clear()
        notices.emit('user:unrelated')
        assert not wake.is_set()
        notices.emit('policy')
        assert wake.is_set()
    close_hub()


def test_capacity_and_supplier_changes_wake_only_after_commit(scheduler_case):
    from app.notifications import close_hub, hub
    from app.translation_models import TranslationProvider
    notices = hub()
    notices.start()
    if notices.bind.dialect.name == 'postgresql':
        assert notices.ready.wait(5)
    with notices.subscribe_thread('compute') as wake:
        with session_factory()() as db:
            db.get(ComputeNode, 'node-0').capacity += 1
            db.flush()
            assert not wake.is_set()
            db.rollback()
            assert not wake.is_set()
            db.get(ComputeNode, 'node-0').capacity += 1
            db.commit()
            assert wake.wait(1)
            wake.clear()
            provider = db.get(TranslationProvider, scheduler_case['text']['provider_id'])
            provider.requests_per_minute += 1
            db.flush()
            assert not wake.is_set()
            db.commit()
            assert wake.wait(1)
    close_hub()
