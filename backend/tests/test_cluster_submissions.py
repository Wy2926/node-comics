"""Public UUID translation requests, input delivery and durable execution."""
from datetime import timedelta
import hashlib
import pytest
from sqlalchemy import func, select
from conftest import login, login_plus, request_id, request_record
from storage_fakes import MemoryS3


@pytest.fixture
def cluster(client, monkeypatch):
    from app.config import settings
    from app.storage import S3Store
    import app.storage as storage
    cfg = settings()
    cfg.classic_enabled = True
    cfg.result_storage_backend = "r2"
    cfg.r2_endpoint_url = "https://" + "a" * 32 + ".r2.cloudflarestorage.com"
    sdk = MemoryS3()
    store = S3Store(sdk, "test-bucket", "isolated/")
    monkeypatch.setattr(storage, "r2_store", lambda *args: store)
    return client, sdk


def descriptor(data, **extra):
    return {"sha256": hashlib.sha256(data).hexdigest(), "byte_size": len(data),
            "content_type": "image/png", **extra}


def manifest(count, prefix="page"):
    return [descriptor(f"{prefix}:{index}".encode()) for index in range(count)]


def submit(client, auth, image, *, key="operation-1", mode="classic", **fields):
    return client.put('/v1/translations/' + request_id(key), headers=auth,
        json={"image": image, "mode": mode, "target_language": "zh-Hans", **fields})


def snapshot(client, auth, keys, **params):
    return client.get('/v1/translations', headers=auth,
        params={"ids": ','.join(request_id(key) for key in keys), **params})


def upload_id(client, auth, translation):
    from app.db import session_factory
    from app.upload_models import UploadReservation
    record = request_record(client, auth, translation['id'])
    with session_factory()() as db:
        return db.scalar(select(UploadReservation.id).where(UploadReservation.job_id == record.job_id))


def active_jobs(client, auth):
    from app.db import session_factory
    from app.models import Job
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    with session_factory()() as db:
        return list(db.scalars(select(Job.id).where(Job.owner_id == owner,
            Job.status.in_(['awaiting_upload', 'validating_upload', 'queued', 'running']))))


def validate_next():
    from app.db import session_factory
    from app.queue_models import ComputeNode
    from app.scheduler import claim_stage
    from app.workers import run_control_stage
    with session_factory()() as db:
        if not db.get(ComputeNode, 'test-validator'):
            db.add(ComputeNode(id='test-validator', name='test-validator', capabilities=['validate_upload'],
                capacity=2, resource_id='test-validator', engine_version='control', device='cpu'))
            db.commit()
        lease = claim_stage(db, 'test-validator', ['validate_upload'])
        db.commit()
        assert lease is not None
    run_control_stage(lease.id)
    return lease.id


def grant_redraw(client, auth, pages):
    from app.models import now
    user_id = client.get('/v1/me', headers=auth).json()['user']['id']
    response = client.post(f'/v1/admin/users/{user_id}/quota-grants',
        headers={**login(client, 'admin'), 'Idempotency-Key': f'grant-{user_id}'},
        json={'mode': 'redraw', 'pages': pages, 'expires_at': (now() + timedelta(days=2)).isoformat() + 'Z', 'note': 'isolated grant'})
    assert response.status_code == 201, response.text


def upload_and_enqueue(client, auth, translation, data):
    response = client.put('/v1/translations/' + translation['id'] + '/input',
        headers={**auth, 'Content-Type': 'image/png'}, content=data)
    assert response.status_code in {200, 202}, response.text
    return response.json()


def test_http_input_automatically_queues_without_complete(cluster, png):
    from app.db import session_factory
    from app.models import Asset, Job
    from app.queue_models import JobStage
    client, sdk = cluster
    auth = login(client)
    first = submit(client, auth, descriptor(png))
    assert first.status_code == 202 and first.json()['state'] == 'needs_input'
    translated = first.json()
    assert translated['input_expires_at']
    accepted = upload_and_enqueue(client, auth, translated, png)
    assert accepted['state'] == 'queued'
    assert [method for method, _ in sdk.calls] == ['PUT']
    record = request_record(client, auth, translated['id'])
    with session_factory()() as db:
        job = db.get(Job, record.job_id)
        source = db.get(Asset, job.input_asset_id)
        assert source.storage_backend == 'r2' and source.active_references == 1
        assert {s.name: s.status for s in db.scalars(select(JobStage).where(JobStage.job_id == job.id))} == {
            'page': 'ready', 'text': 'waiting'}
    assert upload_and_enqueue(client, auth, translated, png)['state'] == 'queued'
    assert [method for method, _ in sdk.calls] == ['PUT']
    assert len(active_jobs(client, auth)) == 1


def test_missing_input_replay_and_alias_reserve_only_once(cluster, png):
    from app.db import session_factory
    from app.models import Job, Ledger
    from app.translation_requests import TranslationRequest, ImageAdmission
    client, _ = cluster
    auth = login(client)
    first = submit(client, auth, descriptor(png))
    for key in ['operation-1', 'device-two', 'device-three']:
        repeated = submit(client, auth, descriptor(png), key=key)
        assert repeated.status_code == 202 and repeated.json()['state'] == 'needs_input'
        assert request_record(client, auth, repeated.json()['id']).job_id == request_record(client, auth, first.json()['id']).job_id
    changed = submit(client, auth, descriptor(b'changed'), key='device-two')
    assert changed.status_code == 409 and changed.json()['error']['code'] == 'IDEMPOTENCY_CONFLICT'
    with session_factory()() as db:
        for model in (Job, Ledger, ImageAdmission):
            assert db.scalar(select(func.count()).select_from(model)) == 1
        assert db.scalar(select(func.count()).select_from(TranslationRequest)) == 3


def test_input_and_snapshot_are_owner_scoped(cluster, png):
    client, sdk = cluster
    alice, bob = login(client), login(client, 'bob')
    translation = submit(client, alice, descriptor(png)).json()
    path = '/v1/translations/' + translation['id']
    before = list(sdk.calls)
    assert client.put(path + '/input', headers=bob, content=png).status_code == 404
    assert client.get(path, headers=bob).status_code == 404
    assert snapshot(client, bob, [translation['id']]).json() == {'items': [], 'missing_ids': [translation['id']]}
    assert client.put(path + '/input', content=png).status_code == 401
    assert sdk.calls == before


def test_expired_input_releases_quota_without_reviving_uuid(cluster, png):
    from app.db import session_factory
    from app.models import now
    from app.upload_models import UploadReservation
    from app.translation_requests import ImageAdmission
    from app.dispatcher import recover_once
    client, _ = cluster
    auth = login(client)
    first = submit(client, auth, descriptor(png)).json()
    with session_factory()() as db:
        db.get(UploadReservation, upload_id(client, auth, first)).expires_at = now() - timedelta(seconds=1)
        db.commit()
    recover_once()
    repeat = submit(client, auth, descriptor(png))
    assert repeat.status_code == 200 and repeat.json()['state'] == 'failed'
    assert repeat.json()['error']['code'] == 'INPUT_EXPIRED'
    assert client.get('/v1/me/entitlements', headers=auth).json()['modes']['classic']['quota']['reserved'] == 0
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(ImageAdmission)) == 1
    assert client.put('/v1/translations/' + first['id'] + '/input', headers=auth, content=png).status_code == 410


@pytest.mark.parametrize('failure', ['actual_size', 'hash', 'decode'])
def test_invalid_input_fails_only_its_translation(cluster, png, failure):
    client, _ = cluster
    auth = login(client)
    data = b'invalid-image' if failure == 'decode' else png
    first = submit(client, auth, descriptor(data)).json()
    neighbor = submit(client, auth, descriptor(b'neighbor'), key='neighbor').json()
    sent = data + b'extra' if failure == 'actual_size' else (b'x' * len(data) if failure == 'hash' else data)
    response = client.put('/v1/translations/' + first['id'] + '/input', headers=auth, content=sent)
    assert response.status_code in {413, 422}
    assert client.get('/v1/translations/' + first['id'], headers=auth).json()['state'] == 'failed'
    assert client.get('/v1/translations/' + neighbor['id'], headers=auth).json()['state'] == 'needs_input'


def test_accepted_uuid_survives_provider_configuration_change(cluster, png):
    from app.config import settings
    client, _ = cluster
    auth = login(client)
    first = submit(client, auth, descriptor(png)).json()
    settings().classic_enabled = False
    settings().classic_engine_version = 'changed-after-admission'
    repeat = submit(client, auth, descriptor(png))
    assert repeat.status_code == 202 and repeat.json()['id'] == first['id']
    assert len(active_jobs(client, auth)) == 1
