"""Rehearsal helper checks: synthetic pages, never external model calls."""
import importlib.util
from pathlib import Path

import pytest
from sqlalchemy import select
from app.db import session_factory
from app.errors import ProcessingError
from app.jobs import cancel_job
from app.models import Asset, Job
from app.queue_models import ExecutionLease
from conftest import create, login, upload

spec = importlib.util.spec_from_file_location('classic_fixture_worker',
    Path(__file__).resolve().parents[2] / 'scripts/tests/classic_fixture_worker.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


@pytest.mark.parametrize('outcome', ['succeeded', 'no_text', 'failed', 'cancelled'])
def test_synthetic_page_uses_real_fencing_and_settlement(client, png, outcome):
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()['id']
    def output(data):
        if outcome == 'failed':
            raise ProcessingError('FIXTURE_FAILED', 'synthetic failure')
        if outcome == 'cancelled':
            with session_factory()() as db:
                cancel_job(db, db.get(Job, job_id))
                db.commit()
        return None if outcome == 'no_text' else data
    worker = fixture.SyntheticPageWorker(output)
    assert worker.run_once()
    assert not worker.run_once()
    with session_factory()() as db:
        job = db.get(Job, job_id)
        assert job.status == outcome
        assert job.settlement == ('settled' if outcome == 'succeeded' else 'released')
        lease = db.scalar(select(ExecutionLease).where(ExecutionLease.job_id == job_id))
        assert lease.completed_at is not None
        if outcome == 'succeeded':
            result = db.get(Asset, job.output_asset_id)
            assert result.representation == 'overlay-v1' and result.mime == 'image/webp'
            assert result.bbox == {'x': 0, 'y': 0, 'width': result.width, 'height': result.height}
