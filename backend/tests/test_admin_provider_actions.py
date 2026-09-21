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


def test_provider_save_toggle_and_audit_do_not_expose_credentials(client, monkeypatch):
    from app.admin_audit import AdminAudit
    from app.db import session_factory
    from app.models import Provider, now
    from app.providers import ProviderConfig
    monkeypatch.setattr('app.adapters.images.safe_endpoint', lambda *args, **kwargs: None)
    admin = login(client, 'admin')
    body = ProviderConfig(id='second', base_url='https://isolated.example/v1', model='test-image').model_dump()
    body['allowed_parameters'] += ['custom']
    body['parameters'] = {'custom': 'NEVER_PUT_ARBITRARY_PARAMETERS_IN_AUDIT'}
    assert client.put('/v1/admin/providers/second', headers=login(client, 'reader'), json=body).status_code == 403
    response = client.put('/v1/admin/providers/second', headers=admin, json=body)
    assert response.status_code == 200, response.text
    assert 'isolated-test-provider-key' not in response.text
    with session_factory()() as db:
        db.get(Provider, 'second').validated_at = now()
        db.commit()
    assert client.patch('/v1/admin/providers/second', headers=admin, json={'enabled': False}).status_code == 200
    with session_factory()() as db:
        row = db.get(Provider, 'second')
        assert row.config['enabled'] is False and row.enabled is False
        assert row.validated_at is not None
        events = db.scalars(select(AdminAudit).where(AdminAudit.target_id == 'second')).all()
        assert {event.action for event in events} == {'image_provider.save', 'image_provider.toggle'}
        assert all('NEVER_PUT' not in str(event.after) for event in events)
    body['enabled'] = False
    body['model'] = 'different-image-model'
    response = client.put('/v1/admin/providers/second', headers=admin, json=body)
    assert response.json()['validated_at'] is None


def test_provider_test_replays_same_request_and_blocks_unknown_retry(client, png):
    from app.db import session_factory
    from app.models import Asset, Job, Provider
    from app.admin_audit import AdminAudit
    admin = login_plus(client, 'admin')
    headers = {**admin, 'Idempotency-Key': 'isolated-image-test'}
    url = '/v1/admin/providers/default/test'
    first = client.post(url, headers=headers, files={'image': ('sample.png', png, 'image/png')})
    assert first.status_code == 202, first.text
    repeated = client.post(url, headers=headers, files={'image': ('sample.png', png, 'image/png')})
    assert repeated.status_code == 202 and repeated.json()['id'] == first.json()['id']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Asset)) == 1
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.action == 'image_provider.test')) == 1
        job = db.get(Job, first.json()['id'])
        job.status = 'outcome_unknown'
        config = dict(db.get(Provider, 'default').config)
        config['id'] = 'another'
        db.add(Provider(id='another', config=config, enabled=True))
        db.commit()
    conflict = client.post('/v1/admin/providers/another/test', headers=headers, files={'image': ('sample.png', png, 'image/png')})
    assert conflict.status_code == 409 and conflict.json()['error']['code'] == 'IDEMPOTENCY_CONFLICT'
    retry = client.post(url, headers={**admin, 'Idempotency-Key': 'different-test-key'}, files={'image': ('sample.png', png, 'image/png')})
    assert retry.status_code == 409 and retry.json()['error']['code'] == 'PROVIDER_TEST_OUTCOME_UNKNOWN'
    listed = client.get('/v1/admin/providers', headers=admin).json()
    assert next(row for row in listed['items'] if row['id'] == 'default')['latest_test']['id'] == first.json()['id']


def test_failure_reconciliation_replays_and_records_actor_once(client, png):
    from app.admin_audit import AdminAudit
    from app.db import session_factory
    from app.models import Ledger
    owner, job_id, _ = unknown_job(client, png)
    admin = login(client, 'admin')
    url = f'/v1/admin/jobs/{job_id}/reconcile'
    body = {'resolution': 'failed', 'note': 'supplier case closed'}
    assert client.post(url, headers=owner, json=body).status_code == 403
    first = client.post(url, headers=admin, json=body)
    assert first.status_code == 200 and first.json()['settlement'] == 'released'
    repeat = client.post(url, headers=admin, json=body)
    assert repeat.status_code == 200 and repeat.json()['status'] == 'failed'
    assert client.post(url, headers=admin, json={**body, 'note': 'different decision'}).status_code == 409
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.transaction_key == f'{job_id}:release')) == 1
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.target_id == job_id)) == 1


@pytest.mark.parametrize('settlement', ['reserved', 'released'])
def test_image_reconciliation_replays_without_duplicate_delivery_or_charge(client, png, settlement):
    from app.admin_audit import AdminAudit
    from app.db import session_factory
    from app.models import Asset, Ledger
    from app.results import TranslationResult
    _, job_id, _ = unknown_job(client, png, settlement=settlement)
    admin = login(client, 'admin')
    url = f'/v1/admin/jobs/{job_id}/reconcile-image'
    files = {'image': ('recovered.png', png_variant(png, 3), 'image/png')}
    first = client.post(url, headers=admin, files=files, data={'note': 'verified supplier output'})
    assert first.status_code == 200, first.text
    expected = 'settled' if settlement == 'reserved' else 'released'
    assert first.json()['settlement'] == expected
    repeated = client.post(url, headers=admin, files=files, data={'note': 'verified supplier output'})
    assert repeated.status_code == 200 and repeated.json()['output_asset_id'] == first.json()['output_asset_id']
    assert client.post(url, headers=admin, files={'image': ('changed.png', png_variant(png, 4), 'image/png')},
                       data={'note': 'verified supplier output'}).status_code == 409
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Asset)) == 2
        assert db.get(TranslationResult, job_id)
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'settle')) == (1 if settlement == 'reserved' else 0)
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.target_id == job_id)) == 1


def test_reconciliation_rejects_cross_owner_and_referenced_input(client, png):
    from app.db import session_factory
    from app.models import Asset
    owner, job_id, _ = unknown_job(client, png)
    admin = login(client, 'admin')
    other = login_plus(client, 'other')
    foreign = upload(client, other, png_variant(png, 2))
    url = f'/v1/admin/jobs/{job_id}/reconcile'
    assert client.post(url, headers=admin, json={'resolution': 'succeeded', 'output_asset_id': foreign, 'note': 'case checked'}).status_code == 404
    referenced = upload(client, owner, png_variant(png, 3))
    assert create(client, owner, referenced, key='second').status_code == 202
    response = client.post(url, headers=admin, json={'resolution': 'succeeded', 'output_asset_id': referenced, 'note': 'case checked'})
    assert response.status_code == 422 and response.json()['error']['code'] == 'INVALID_PROVIDER_OUTPUT'
    with session_factory()() as db:
        assert db.get(Asset, referenced).kind == 'original'
    assert client.post(url, headers=admin, json={'resolution': 'failed', 'note': '   '}).status_code == 422
    assert client.post(f'{url}-image', headers=admin, files={'image': ('out.png', png, 'image/png')}, data={'note': '   '}).status_code == 422


def test_cancelled_unknown_result_can_only_be_confirmed_failed(client, png):
    _, job_id, _ = unknown_job(client, png, cancelled=True)
    admin = login(client, 'admin')
    url = f'/v1/admin/jobs/{job_id}/reconcile'
    assert client.post(f'{url}-image', headers=admin, files={'image': ('out.png', png, 'image/png')}, data={'note': 'supplier done'}).status_code == 409
    assert client.post(url, headers=admin, json={'resolution': 'failed', 'note': 'supplier failed'}).status_code == 200


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
