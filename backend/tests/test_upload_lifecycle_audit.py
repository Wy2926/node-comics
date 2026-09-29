"""Immutable input checks, cancellation during object I/O, revoked authorizations."""
from datetime import timedelta
import pytest
from app.db import session_factory
from app.models import Asset, Job, now
from conftest import login, request_record
from test_cluster_submissions import cluster, descriptor, submit, upload_and_enqueue


def test_replay_accepts_identical_bytes_and_rejects_different_input(cluster, png):
    client, sdk = cluster
    auth = login(client)
    item = submit(client, auth, descriptor(png)).json()
    upload_and_enqueue(client, auth, item, png)
    assert upload_and_enqueue(client, auth, item, png)['state'] == 'queued'
    wrong = client.put('/v1/translations/' + item['id'] + '/input', headers=auth, content=b'x'*len(png))
    assert wrong.status_code == 422 and wrong.json()['error']['code'] == 'UPLOAD_HASH_MISMATCH'
    assert [method for method, _ in sdk.calls] == ['PUT']
    with session_factory()() as db:
        job = db.get(Job, request_record(client, auth, item['id']).job_id)
        assert job.status == 'queued' and job.input_pinned
        assert db.get(Asset, job.input_asset_id).active_references == 1


def test_cancel_during_input_put_cannot_publish_asset(cluster, png, monkeypatch):
    from app.storage import get_store
    client, _ = cluster
    auth = login(client)
    item = submit(client, auth, descriptor(png)).json()
    from app.storage import LocalStore
    put = LocalStore.put_file
    def racing_put(self, *args, **kwargs):
        put(self, *args, **kwargs)
        assert client.post('/v1/translations/' + item['id'] + '/cancel', headers=auth).status_code == 200
    monkeypatch.setattr(LocalStore, 'put_file', racing_put)
    client.put('/v1/translations/' + item['id'] + '/input', headers=auth, content=png)
    with session_factory()() as db:
        job = db.get(Job, request_record(client, auth, item['id']).job_id)
        assert job.status == 'cancelled' and not job.input_asset_id and not job.input_pinned




def test_missing_queued_input_pauses_and_repairs_without_new_charge(cluster, png):
    from app.assets import object_path
    from app.dispatcher import recover_once
    from app.upload_models import UploadReservation
    from app.models import Ledger
    from sqlalchemy import select, func
    client, _ = cluster
    auth = login(client)
    item = submit(client, auth, descriptor(png)).json()
    upload_and_enqueue(client, auth, item, png)
    with session_factory()() as db:
        job = db.get(Job, request_record(client, auth, item['id']).job_id)
        original_id = job.input_asset_id
        object_path(db.get(Asset, original_id).storage_key).unlink()
    recover_once()
    state = client.get('/v1/translations/' + item['id'], headers=auth).json()
    assert state['state'] == 'needs_input'
    assert upload_and_enqueue(client, auth, item, png)['state'] == 'queued'
    with session_factory()() as db:
        job = db.get(Job, request_record(client, auth, item['id']).job_id)
        assert job.input_asset_id == original_id
        assert object_path(db.get(Asset, original_id).storage_key).exists()
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'reserve')) == 1
