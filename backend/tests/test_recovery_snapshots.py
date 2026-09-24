from conftest import inspect_job
"""Maintenance terminal transitions must reach already-synchronized readers."""
from datetime import timedelta

import pytest

from conftest import create, login_plus, run_job, upload, request_for_job
from app import workers
from app.db import session_factory
from app.dispatcher import recover_once
from app.errors import ProcessingError
from app.models import Job, Provider, now


@pytest.mark.parametrize('transition', ['unknown_deadline', 'provider_disabled'])
def test_maintenance_terminal_transition_changes_snapshot(client, png, monkeypatch, transition):
    auth = login_plus(client)
    job_id = create(client, auth, upload(client, auth, png)).json()['id']
    if transition == 'unknown_deadline':
        def unknown(*args):
            raise ProcessingError('UPSTREAM_OUTCOME_UNKNOWN', 'isolated uncertain response', unknown=True)
        monkeypatch.setattr(workers, 'redraw', unknown)
        run_job(job_id)
    translation_id = request_for_job(client, auth, job_id)
    route = '/v1/translations?ids=' + translation_id
    initial = client.get(route, headers=auth)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        if transition == 'unknown_deadline':
            job.unknown_since = now() - timedelta(days=1)
        else:
            db.get(Provider, job.config['provider']['id']).enabled = False
        db.commit()

    recover_once()

    expected = 'unknown_released' if transition == 'unknown_deadline' else 'failed'
    assert inspect_job(job_id)['status'] == expected
    changes = client.get(route, headers={**auth, 'If-None-Match': initial.headers['ETag']})
    if transition == 'provider_disabled':
        assert changes.status_code == 200
        assert changes.json()['items'][0]['state'] == 'failed'
    else:
        # Unknown cost remains a needs-attention state; refresh still recovers it.
        current = client.get(route, headers=auth).json()['items'][0]
        assert current['state'] == 'needs_attention'
