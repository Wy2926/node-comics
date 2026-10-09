"""Terminal input deletion, independent results and account-scoped references."""
from io import BytesIO
from uuid import uuid4
import pytest
from PIL import Image
from sqlalchemy import select, func
from conftest import login_plus as login, request_record, create, upload, run_job, submit_asset, request_for_job
from app.db import session_factory
from app.models import Asset, Job, Ledger
from app.assets import object_path


def finished(client, png, monkeypatch):

    import app.workers as workers
    monkeypatch.setattr("conftest.fixture_output", lambda *args: png)
    auth = login(client)
    source = upload(client, auth, png)
    response = create(client, auth, source)
    assert response.status_code == 202, response.text
    job_id = response.json()['id']
    run_job(job_id)
    request = request_for_job(client, auth, job_id)
    return auth, source, job_id, request


def test_terminal_input_deleted_and_result_still_downloadable(client, png, monkeypatch):
    auth, source, job_id, request = finished(client, png, monkeypatch)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        original = db.get(Asset, job.input_asset_id)
        assert original.purged_at and not object_path(original.storage_key).exists()
        assert not original.deleted_at
    state = client.get('/v1/translations/' + request, headers=auth).json()
    assert state['state'] == 'succeeded'
    assert 'input_asset_id' not in state
    result = state['result']
    assert result['representation'] == 'full-image-v1'
    assert result['width'] == 320 and result['height'] == 480
    response = client.get(result['artifact']['path'], headers=auth)
    assert response.content == png
    assert response.headers['cache-control'] == 'private, no-store'
    assert client.get(result['artifact']['path'], headers={**auth, 'If-None-Match': response.headers['etag']}).status_code == 304
    assert client.get(result['artifact']['path'], headers=login(client, 'other')).status_code == 404
    assert client.get('/v1/images/' + source + '/content', headers=auth).status_code == 404


def test_account_cache_survives_source_deletion_and_last_reference_gc(client, png, monkeypatch):
    auth, source, job_id, first = finished(client, png, monkeypatch)
    alias = submit_asset(client, auth, source, key=uuid4().hex).json()
    assert alias['state'] == 'succeeded'
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        output = db.get(Asset, db.get(Job, job_id).output_asset_id)
        path = object_path(output.storage_key)
    assert client.delete('/v1/translations/' + first, headers=auth).status_code == 200
    assert path.exists()
    assert client.get(alias['result']['artifact']['path'], headers=auth).status_code == 200
    assert client.delete('/v1/translations/' + alias['id'], headers=auth).status_code == 200
    assert not path.exists()
    assert client.get(alias['result']['artifact']['path'], headers=auth).status_code == 410
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'settle')) == 1


def test_another_account_cannot_claim_known_hash(client, png, monkeypatch):
    auth, source, _, _ = finished(client, png, monkeypatch)
    other = login(client, 'other')
    import hashlib
    response = client.put('/v1/translations/' + str(uuid4()), headers=other, json={
        'image': {'sha256': hashlib.sha256(png).hexdigest(), 'byte_size': len(png), 'content_type': 'image/png'},
        'mode': 'classic', 'target_language': 'zh-Hans'})
    assert response.status_code == 202
    assert response.json()['state'] == 'needs_input'


def test_missing_result_keeps_success_and_never_restarts_model(client, png, monkeypatch):
    auth, _, job_id, request = finished(client, png, monkeypatch)
    with session_factory()() as db:
        output = db.get(Asset, db.get(Job, job_id).output_asset_id)
        object_path(output.storage_key).unlink()
    state = client.get('/v1/translations/' + request, headers=auth).json()
    assert state['state'] == 'succeeded' and state['error']['code'] == 'RESULT_UNAVAILABLE'
    assert client.get(state['result']['artifact']['path'], headers=auth).status_code == 503


def test_original_representation_has_dimensions_without_file(client, png):
    from app.workers import finish_job
    from app.config import settings
    settings().classic_enabled = True
    auth = login(client)
    source = upload(client, auth, png)
    job_id = create(client, auth, source, mode='classic').json()['id']
    with session_factory()() as db:
        finish_job(db, db.get(Job, job_id), 'no_text')
        db.commit()
    request = request_for_job(client, auth, job_id)
    result = client.get('/v1/translations/' + request, headers=auth).json()['result']
    assert result['representation'] == 'original' and result['artifact'] is None
    assert result['width'] == 320 and result['height'] == 480
    assert submit_asset(client, auth, source, key=uuid4().hex, mode='classic').json()['state'] == 'succeeded'


def test_old_client_cannot_start_paid_work(client, png):
    auth = login(client)
    auth.pop('X-Translation-Protocol')
    client.headers.pop('X-Translation-Protocol')
    import hashlib
    response = client.put('/v1/translations/' + str(uuid4()), headers=auth, json={
        'image': {'sha256': hashlib.sha256(png).hexdigest(), 'byte_size': len(png), 'content_type': 'image/png'},
        'mode': 'classic', 'target_language': 'zh-Hans'})
    assert response.status_code == 409 and response.json()['error']['code'] == 'CLIENT_UPGRADE_REQUIRED'


def test_full_image_dimensions_follow_actual_output_not_input(client, png, monkeypatch):

    from app import workers
    output = BytesIO()
    Image.open(BytesIO(png)).resize((160, 240)).save(output, 'PNG')
    monkeypatch.setattr("conftest.fixture_output", lambda *args: output.getvalue())
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()['id']
    run_job(job_id)
    result = client.get('/v1/translations/' + request_for_job(client, auth, job_id), headers=auth).json()['result']
    assert result['representation'] == 'full-image-v1'
    assert (result['width'], result['height']) == (160, 240)


def test_open_result_stream_survives_concurrent_unlink(client, png, monkeypatch):
    import os
    if os.name == 'nt':
        pytest.skip('Windows defers unlink until the open authorized response closes')
    from app import translation_api
    auth, _, job_id, request = finished(client, png, monkeypatch)
    with session_factory()() as db:
        path = object_path(db.get(Asset, db.get(Job, job_id).output_asset_id).storage_key)
    original = translation_api.StreamingResponse
    def unlink_before_first_chunk(*args, **kwargs):
        path.unlink()
        return original(*args, **kwargs)
    monkeypatch.setattr(translation_api, 'StreamingResponse', unlink_before_first_chunk)
    response = client.get('/v1/translations/' + request + '/result', headers=auth)
    assert response.status_code == 200 and response.content == png
    assert not path.exists()
