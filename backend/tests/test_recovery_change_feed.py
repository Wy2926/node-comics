"""Maintenance terminal transitions must reach already-synchronized readers."""
from datetime import timedelta

import pytest

from conftest import create, login_plus, run_job, upload
from app import workers
from app.db import session_factory
from app.dispatcher import recover_once
from app.errors import ProcessingError
from app.models import Job, Provider, now


@pytest.mark.parametrize('transition', ['unknown_deadline', 'provider_disabled'])
def test_maintenance_terminal_transition_advances_change_feed(client, png, monkeypatch, transition):
    auth = login_plus(client)
    job_id = create(client, auth, upload(client, auth, png)).json()['id']
    if transition == 'unknown_deadline':
        def unknown(*args):
            raise ProcessingError('UPSTREAM_OUTCOME_UNKNOWN', 'isolated uncertain response', unknown=True)
        monkeypatch.setattr(workers, 'redraw', unknown)
        run_job(job_id)
    cursor = client.get('/v1/me/translation-changes', headers=auth).json()['cursor']
    with session_factory()() as db:
        job = db.get(Job, job_id)
        if transition == 'unknown_deadline':
            job.unknown_since = now() - timedelta(days=1)
        else:
            db.get(Provider, job.config['provider']['id']).enabled = False
        db.commit()

    recover_once()

    expected = 'unknown_released' if transition == 'unknown_deadline' else 'failed'
    assert client.get(f'/v1/jobs/{job_id}', headers=auth).json()['status'] == expected
    changes = client.get('/v1/me/translation-changes', headers=auth, params={'cursor': cursor}).json()
    assert [(job['id'], job['status']) for job in changes['items']] == [(job_id, expected)]
