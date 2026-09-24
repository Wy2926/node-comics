"""Atomic admission, fixed UUID semantics and the intentionally small public API."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from uuid import uuid4
import pytest
from sqlalchemy import func, select
from conftest import configure_system_limits, login, login_plus, submit_asset, upload, request_id, request_record
from test_cluster_submissions import cluster, descriptor, grant_redraw, manifest, snapshot, submit


def counts():
    from app.db import session_factory
    from app.models import Job, Ledger
    from app.translation_requests import ImageAdmission, TranslationRequest
    from app.upload_models import UploadReservation
    with session_factory()() as db:
        return {model.__name__: db.scalar(select(func.count()).select_from(model))
                for model in (Job, Ledger, ImageAdmission, TranslationRequest, UploadReservation)}


def high_control_budget():
    from app.config import settings
    settings().translation_request_concurrency = 32
    settings().translation_request_burst = 1000
    settings().translation_requests_per_minute = 1000


@pytest.mark.parametrize('plus,limit', [(False, 10), (True, 100)])
def test_exact_rolling_limit_combines_devices_modes_and_languages(cluster, plus, limit, monkeypatch):
    from app import translation_limits
    from app.models import now
    client, _ = cluster
    auth = (login_plus if plus else login)(client)
    if not plus:
        grant_redraw(client, auth, 100)
    high_control_budget()
    clock = [now()]
    monkeypatch.setattr(translation_limits, 'server_now', lambda db: clock[0])
    for index in range(limit):
        response = submit(client, auth, manifest(1, f'input-{index}')[0], key=f'op-{index}',
            mode='classic' if index % 2 else 'redraw', target_language='en' if index % 3 else 'zh-Hans')
        assert response.status_code == 202, response.text
    before = counts()
    denied = submit(client, auth, manifest(1, 'last')[0], key='last')
    assert denied.status_code == 429 and denied.json()['error']['code'] == 'IMAGE_RATE_LIMITED'
    assert denied.headers['Retry-After'] == '60'
    assert counts() == before
    replay = submit(client, auth, manifest(1, 'input-0')[0], key='another-key', mode='redraw')
    assert replay.status_code == 202 and replay.json()['state'] == 'needs_input'
    assert counts()['ImageAdmission'] == limit
    clock[0] += timedelta(seconds=59, milliseconds=999)
    assert submit(client, auth, manifest(1, 'last')[0], key='last').headers['Retry-After'] == '1'
    clock[0] += timedelta(milliseconds=1)
    assert submit(client, auth, manifest(1, 'last')[0], key='last').status_code == 202


def test_rejected_page_cannot_rollback_another_independent_request(cluster):
    client, _ = cluster
    auth = login(client)
    configure_system_limits(free_images_per_minute=1)
    first = submit(client, auth, manifest(1)[0])
    denied = submit(client, auth, manifest(1, 'neighbor')[0], key='neighbor')
    assert first.status_code == 202 and denied.status_code == 429
    assert all(value == 1 for value in counts().values())
    assert snapshot(client, auth, ['operation-1', 'neighbor']).json()['missing_ids'] == [request_id('neighbor')]


def test_cancel_does_not_refund_minute_admission(cluster):
    client, _ = cluster
    auth = login(client)
    configure_system_limits(free_images_per_minute=1)
    accepted = submit(client, auth, manifest(1)[0]).json()
    job_id = request_record(client, auth, accepted['id']).job_id
    assert client.post('/v1/translations/' + accepted['id'] + '/cancel', headers=auth).status_code == 200
    assert submit(client, auth, manifest(1, 'new')[0], key='new').status_code == 429
    assert counts()['ImageAdmission'] == 1
    assert client.get('/v1/me/entitlements', headers=auth).json()['modes']['classic']['quota']['reserved'] == 0


def test_existing_original_still_counts_when_translation_is_new(cluster, png):
    client, _ = cluster
    auth = login_plus(client)
    asset = upload(client, auth, png)
    configure_system_limits(plus_images_per_minute=1)
    response = submit_asset(client, auth, asset)
    assert response.status_code == 202 and response.json()['state'] == 'queued'
    assert submit_asset(client, auth, asset, key='other-language', language='en').status_code == 429
    assert counts()['ImageAdmission'] == counts()['Job'] == 1


def test_concurrent_same_uuid_accepts_exactly_once(cluster, png):
    client, _ = cluster
    auth = login(client)
    high_control_budget()
    barrier = Barrier(6)
    def request(_):
        barrier.wait(timeout=10)
        return submit(client, auth, descriptor(png), key='same')
    with ThreadPoolExecutor(6) as pool:
        responses = list(pool.map(request, range(6)))
    assert all(r.status_code == 202 for r in responses)
    assert {r.json()['id'] for r in responses} == {request_id('same')}
    assert all(value == 1 for value in counts().values())
    conflict = submit(client, auth, descriptor(b'changed'), key='same')
    assert conflict.status_code == 409 and conflict.json()['error']['code'] == 'IDEMPOTENCY_CONFLICT'
    assert all(value == 1 for value in counts().values())


def test_concurrent_devices_cannot_exceed_remaining_image_budget(cluster):
    client, _ = cluster
    auth = login(client)
    configure_system_limits(free_images_per_minute=5)
    high_control_budget()
    barrier = Barrier(8)
    def request(index):
        barrier.wait(timeout=10)
        return submit(client, auth, manifest(1, f'device-{index}')[0], key=f'device-{index}')
    with ThreadPoolExecutor(8) as pool:
        responses = list(pool.map(request, range(8)))
    assert sorted(r.status_code for r in responses) == [202] * 5 + [429] * 3
    assert counts()['Job'] == counts()['ImageAdmission'] == counts()['TranslationRequest'] == 5


def test_plus_downgrade_waits_for_enough_events_to_expire(cluster, monkeypatch):
    from app.db import session_factory
    from app.models import User, now
    from app.translation_requests import ImageAdmission
    from app import translation_limits
    client, _ = cluster
    auth = login_plus(client)
    configure_system_limits(free_images_per_minute=2, plus_images_per_minute=4)
    at = now()
    monkeypatch.setattr(translation_limits, 'server_now', lambda db: at)
    for index in range(4):
        assert submit(client, auth, manifest(1, f'p-{index}')[0], key=f'op-{index}').status_code == 202
    with session_factory()() as db:
        db.scalar(select(User).where(User.subject == 'dev:alice')).plus_expires_at = at - timedelta(seconds=1)
        for index, row in enumerate(db.scalars(select(ImageAdmission).order_by(ImageAdmission.job_id))):
            row.admitted_at = at - timedelta(seconds=40 - index * 10)
        db.commit()
    denied = submit(client, auth, manifest(1, 'new')[0], key='new')
    assert denied.status_code == 429 and denied.headers['Retry-After'] == '40'


def test_removed_control_routes_are_not_registered(cluster):
    client, _ = cluster
    auth = login(client)
    for path in ['/v1/translation-operations', '/v1/me/translation-changes', '/v1/me/queues',
                 '/v1/translation-submissions', '/v1/translation-submissions/old']:
        assert client.get(path, headers=auth).status_code == 404
    for path in ['/v1/translation-plans', '/v1/translation-operations/resolve',
                 '/v1/uploads/old/complete', '/v1/translation-submissions',
                 '/v1/me/queues/classic/priority', '/v1/me/queues/classic/pause']:
        assert client.post(path, headers=auth, json={}).status_code == 404
    for path in ['/v1/reading-sessions/old/lease', '/v1/uploads/old/content']:
        assert client.put(path, headers=auth, json={}).status_code == 404
    paths = client.get('/openapi.json').json()['paths']
    assert not any('translation-plans' in p or 'reading-sessions' in p or 'translation-operations' in p for p in paths)


def test_validation_reports_fields_without_reflecting_input(cluster):
    client, _ = cluster
    secret = 'private-url?token=never-return-this'
    response = client.put('/v1/translations/' + str(uuid4()), headers=login(client), json={
        'image': {'sha256': secret, 'byte_size': 1, 'content_type': 'image/png'},
        'mode': 'classic', 'target_language': 'zh-Hans', 'page_key': secret})
    assert response.status_code == 422
    error = response.json()['error']
    assert error['code'] == 'INVALID_REQUEST' and error['fields'] and error['request_id']
    assert secret not in response.text
    assert all(set(item) == {'path', 'code'} for item in error['fields'])


def test_legacy_control_fields_are_rejected(cluster, png):
    client, _ = cluster
    auth = login(client)
    for field in ['page_key', 'session_id', 'sequence', 'priority_epochs', 'allow_new', 'max_quota_pages']:
        response = submit(client, auth, descriptor(png), key=field, **{field: 'legacy'})
        assert response.status_code == 422, (field, response.text)
    assert all(value == 0 for value in counts().values())


def test_cors_exposes_backoff_and_etag(cluster):
    client, _ = cluster
    auth = {**login(client), 'Origin': 'http://localhost:5173'}
    configure_system_limits(free_images_per_minute=1)
    assert submit(client, auth, manifest(1)[0]).status_code == 202
    denied = submit(client, auth, manifest(1, 'other')[0], key='other')
    assert denied.status_code == 429 and denied.headers['Retry-After']
    assert 'retry-after' in denied.headers['Access-Control-Expose-Headers'].lower()
    current = snapshot(client, auth, ['operation-1'])
    assert current.headers['ETag']
    assert 'etag' in current.headers['Access-Control-Expose-Headers'].lower()
    assert current.headers['Cache-Control'] == 'private, no-store'


def test_request_uuid_survives_admission_event_cleanup(cluster):
    from app.db import session_factory
    from app.models import now
    from app.translation_requests import ImageAdmission, TranslationRequest
    from app.translation_limits import clean_admissions
    client, _ = cluster
    auth = login(client)
    first = submit(client, auth, manifest(1)[0], key='permanent').json()
    job_id = request_record(client, auth, first['id']).job_id
    assert client.post('/v1/translations/' + first['id'] + '/cancel', headers=auth).status_code == 200
    with session_factory()() as db:
        db.get(ImageAdmission, job_id).admitted_at = now() - timedelta(minutes=3)
        db.commit()
        clean_admissions(db)
        db.commit()
        assert db.scalar(select(func.count()).select_from(ImageAdmission)) == 0
        assert db.scalar(select(func.count()).select_from(TranslationRequest)) == 1
    replay = submit(client, auth, manifest(1)[0], key='permanent')
    assert replay.status_code == 200 and replay.json()['state'] == 'failed'
    assert counts()['Job'] == 1


def test_batch_snapshot_is_bounded_and_handles_missing_ids_per_item(cluster):
    client, _ = cluster
    auth = login(client)
    accepted = submit(client, auth, manifest(1)[0]).json()
    missing = str(uuid4())
    response = snapshot(client, auth, [accepted['id'], missing])
    assert response.status_code == 200
    assert [item['id'] for item in response.json()['items']] == [accepted['id']]
    assert response.json()['missing_ids'] == [missing]
    assert snapshot(client, auth, [str(uuid4()) for _ in range(33)]).status_code == 422
    assert client.get('/v1/translations',headers=auth,params={'ids':'malformed'}).status_code == 422
    assert client.get('/v1/translations/'+missing,headers=auth).status_code == 404


def test_internal_admission_failure_rolls_back_uuid_quota_and_minute_charge(cluster, monkeypatch):
    from app import translation_api
    client, _ = cluster
    auth = login(client)
    actual = translation_api.create_job
    def fail_after_reservation(*args, **kwargs):
        actual(*args, **kwargs)
        raise RuntimeError('isolated admission rollback')
    monkeypatch.setattr(translation_api,'create_job',fail_after_reservation)
    with pytest.raises(RuntimeError,match='isolated admission rollback'):
        submit(client,auth,manifest(1)[0])
    assert all(value == 0 for value in counts().values())
    assert client.get('/v1/me/entitlements',headers=auth).json()['modes']['classic']['quota']['reserved'] == 0
    monkeypatch.setattr(translation_api,'create_job',actual)
    assert submit(client,auth,manifest(1)[0]).status_code == 202
    assert all(value == 1 for value in counts().values())


def test_same_uuid_is_account_scoped_and_never_an_authorization_credential(cluster):
    client, _ = cluster
    alice, bob = login(client), login(client,'bob')
    image_a, image_b = manifest(1,'alice')[0], manifest(1,'bob')[0]
    first = submit(client,alice,image_a,key='same-public-uuid')
    second = submit(client,bob,image_b,key='same-public-uuid')
    assert first.status_code == second.status_code == 202
    assert first.json()['id'] == second.json()['id']
    assert first.json()['image_sha256'] != second.json()['image_sha256']
    path = '/v1/translations/' + first.json()['id']
    assert client.get(path).status_code == 401
    assert client.get(path,headers=alice).json()['image_sha256'] == image_a['sha256']
    assert client.get(path,headers=bob).json()['image_sha256'] == image_b['sha256']
    assert counts()['Job'] == counts()['ImageAdmission'] == counts()['TranslationRequest'] == 2
