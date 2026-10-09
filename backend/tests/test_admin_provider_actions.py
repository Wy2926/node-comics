"""Isolated operator controls; no supplier or remote object calls are made."""
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from conftest import create, login, login_plus, png_variant, upload


def unknown_job(client, png, *, settlement='reserved', cancelled=False):
    from app.db import session_factory
    from app.models import Job
    from app.entitlements import settle
    owner = login_plus(client)
    source = upload(client, owner, png)
    response = create(client, owner, source)
    assert response.status_code == 202, response.text
    job_id = response.json()['id']
    with session_factory()() as db:
        job = db.get(Job, job_id)
        job.status = 'outcome_unknown'
        job.phase = 'outcome_unknown'
        job.cancel_requested = cancelled
        if settlement == 'released':
            job.status = 'unknown_released'
            settle(db, job, success=False)
        db.commit()
    return owner, job_id, source


def test_attempts_timeline_is_admin_only_paginated_and_metadata_only(client, png):
    from app.db import session_factory
    from app.models import Attempt, now
    owner, job_id, _ = unknown_job(client, png)
    admin = login(client, 'admin')
    with session_factory()() as db:
        for index in range(3):
            db.add(Attempt(job_id=job_id, provider_id='default', request_id=f'request-{index}',
                started_at=now() + timedelta(seconds=index), call_started_at=now(), lease_expires_at=now(),
                usage={'total_tokens': index + 1}, cost_state='reported'))
        db.commit()
    url = f'/v1/admin/jobs/{job_id}/attempts'
    assert client.get(url, headers=owner).status_code == 403
    response = client.get(url + '?limit=2', headers=admin)
    assert response.status_code == 200 and response.json()['total'] == 3
    assert response.json()['next_offset'] == 2
    assert response.json()['items'][0]['request_id'] == 'request-2'
    assert len(client.get(url + '?offset=2&limit=2', headers=admin).json()['items']) == 1
    assert 'storage_backend' not in response.text and 'isolated-test-provider-key' not in response.text
