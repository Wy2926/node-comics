"""Unsorted readiness uses the same eligibility rules as the actual election."""
from datetime import timedelta

import pytest
from sqlalchemy import event, select

from app import scheduler
from app.db import engine, session_factory
from app.models import Asset, Job, now
from app.queue_models import ComputeNode, JobStage
from app.storage import LocalStore
from test_classic import text_database
from test_cluster_scheduler import add_job, scheduler_case


@pytest.mark.parametrize('mutation', ['ready', 'future', 'waiting', 'cancelled', 'discarded', 'terminal',
    'engine', 'language', 'deleted', 'purged', 'expired', 'pinned', 'missing', 'disabled'])
def test_readiness_filters_without_sorting_or_materializing_jobs(scheduler_case, mutation):
    key = add_job(scheduler_case)
    with session_factory()() as db:
        job, asset = db.get(Job, key), db.get(Asset, 'free-user-image')
        stage = db.scalar(select(JobStage).where(JobStage.job_id == key))
        if mutation == 'future':
            stage.available_at = now() + timedelta(hours=1)
        elif mutation == 'waiting':
            stage.status = 'waiting'
        elif mutation == 'cancelled':
            job.cancel_requested = True
        elif mutation == 'discarded':
            job.discard_output = True
        elif mutation == 'terminal':
            job.status = 'failed'
        elif mutation == 'engine':
            job.config = {**job.config, 'engine': {'protocol_version': 99}}
        elif mutation == 'language':
            job.target_language = 'fr'
        elif mutation == 'deleted':
            asset.deleted_at = now()
        elif mutation == 'purged':
            asset.purged_at = now()
        elif mutation in {'expired', 'pinned'}:
            asset.expires_at = now() - timedelta(hours=1)
            asset.active_references = int(mutation == 'pinned')
        elif mutation == 'missing':
            job.input_asset_id = None
        elif mutation == 'disabled':
            db.get(ComputeNode, 'node-0').enabled = False
        db.commit()
    statements, loaded = [], []
    def sql(connection, cursor, statement, *args):
        statements.append(statement.lower())
    def materialized(job, context):
        loaded.append(job.id)
    event.listen(engine(), 'before_cursor_execute', sql)
    event.listen(Job, 'load', materialized)
    try:
        with session_factory()() as db:
            assert scheduler.has_claimable_work(db, 'node-0', ['page']) == (mutation in {'ready', 'pinned'})
            assert not db.new and not db.dirty
    finally:
        event.remove(engine(), 'before_cursor_execute', sql)
        event.remove(Job, 'load', materialized)
    assert not loaded
    assert not any('row_number' in statement or 'order by' in statement or 'fairness_states' in statement for statement in statements)


def test_readiness_is_advisory_without_scanning_local_files(scheduler_case):
    for _ in range(35):
        add_job(scheduler_case)
    valid = add_job(scheduler_case)
    with session_factory()() as db:
        missing = db.get(Asset, 'free-user-image')
        LocalStore().delete(missing.storage_key)
        source = db.get(Asset, 'plus-user-image')
        assert LocalStore().exists(source.storage_key)
        db.get(Job, valid).input_asset_id = source.id
        db.commit()
        assert scheduler.has_claimable_work(db, 'node-0', ['page'])
        LocalStore().delete(source.storage_key)
        assert scheduler.has_claimable_work(db, 'node-0', ['page'])
        assert all(job.status == 'queued' for job in db.scalars(select(Job)))


def test_control_readiness_respects_supplier_limits_and_upload_without_source(scheduler_case):
    key = add_job(scheduler_case, stage='validate_upload')
    with session_factory()() as db:
        stage = db.scalar(select(JobStage).where(JobStage.job_id == key))
        stage.name = 'validate_upload'
        db.get(Job, key).input_asset_id = None
        db.get(ComputeNode, 'node-0').capabilities = ['validate_upload']
        db.commit()
        assert scheduler.has_claimable_work(db, 'node-0')


def test_text_readiness_respects_supplier_enablement_and_rpm(scheduler_case, monkeypatch):
    from admission_test_utils import freeze_clock, window_count
    from app.redis_state import window
    from app.translation_models import TranslationProvider

    add_job(scheduler_case, stage='text')
    clock = [now()]
    freeze_clock(monkeypatch, clock)
    with session_factory()() as db:
        node = db.get(ComputeNode, 'node-0')
        node.capabilities, node.engine_version = ['text'], 'control'
        provider = db.get(TranslationProvider, scheduler_case['text']['provider_id'])
        provider.enabled, provider.requests_per_minute = False, 1
        db.commit()
        assert not scheduler.has_claimable_work(db, node.id)
        provider.enabled = True
        db.commit()
        assert scheduler.has_claimable_work(db, node.id)
        window('provider', provider.id, 1, member='existing-call')
        assert not scheduler.has_claimable_work(db, node.id)
        assert window_count('provider', provider.id) == 1
        clock[0] += timedelta(seconds=61)
        assert scheduler.has_claimable_work(db, node.id)
        # Readiness observes the elapsed window without reserving or pruning it.
        assert window_count('provider', provider.id) == 1
