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
    store = get_store('r2')
    put = store.put
    def racing_put(*args, **kwargs):
        put(*args, **kwargs)
        assert client.post('/v1/translations/' + item['id'] + '/cancel', headers=auth).status_code == 200
    monkeypatch.setattr(store, 'put', racing_put)
    client.put('/v1/translations/' + item['id'] + '/input', headers=auth, content=png)
    with session_factory()() as db:
        job = db.get(Job, request_record(client, auth, item['id']).job_id)
        assert job.status == 'cancelled' and not job.input_asset_id and not job.input_pinned


@pytest.mark.parametrize('removed', ['purged', 'expired'])
def test_verified_input_replay_rejects_unavailable_original(cluster, png, removed):
    client, _ = cluster
    auth = login(client)
    item = submit(client, auth, descriptor(png)).json()
    accepted = upload_and_enqueue(client, auth, item, png)
    with session_factory()() as db:
        asset = db.get(Asset, accepted['input_asset_id'])
        if removed == 'purged':
            asset.purged_at = now()
        else:
            asset.active_references = 0
            asset.expires_at = now() - timedelta(days=1)
        db.commit()
    assert client.put('/v1/translations/' + item['id'] + '/input', headers=auth, content=png).status_code == 410
