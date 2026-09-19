"""Inline upload races, immutable write recovery and revoked grants."""
from datetime import timedelta
import pytest
from app.db import session_factory
from app.models import Asset, Job, User, now
from app.upload_models import UploadReservation
from app.upload_api import upload_complete
from conftest import login
from test_cluster_submissions import cluster, descriptor, submit, validate_next  # noqa: F401


@pytest.mark.parametrize('complete', [False, True])
def test_verified_replay_skips_body_and_never_requeues(cluster, png, complete, monkeypatch):
    client, sdk = cluster
    auth = login(client)
    item = submit(client, auth, [descriptor(png)]).json()['items'][0]
    assert client.put(item['upload']['url'], headers=auth, content=png).status_code == 200
    if complete:
        assert client.post(f"/v1/uploads/{item['upload']['id']}/complete", headers=auth).status_code == 200
    async def forbidden(*args, **kwargs):
        raise AssertionError('Accepted replay must not consume a body')
    from app import upload_ingress
    monkeypatch.setattr(upload_ingress, 'read_upload_stream', forbidden)
    assert client.put(item['upload']['url'], headers=auth, content=b'wrong').status_code == 200
    assert [method for method, _ in sdk.calls] == ['PUT']
    with session_factory()() as db:
        job = db.get(Job, item['job']['id'])
        assert job.status == 'queued' and job.input_pinned
        assert db.get(Asset, job.input_asset_id).active_references == 1


def test_complete_during_put_retains_durable_recovery_stage(cluster, png, monkeypatch):
    from app.storage import get_store
    client, _ = cluster
    auth = login(client)
    item = submit(client, auth, [descriptor(png)]).json()['items'][0]
    store = get_store('r2')
    put = store.put
    def racing_put(*args, **kwargs):
        put(*args, **kwargs)
        with session_factory()() as db:
            receipt = db.get(UploadReservation, item['upload']['id'])
            result = upload_complete(receipt.id, db.get(User, receipt.owner_id), db)
            assert result['status'] == 'validating_upload'
    monkeypatch.setattr(store, 'put', racing_put)
    assert client.put(item['upload']['url'], headers=auth, content=png).json()['status'] == 'validating'
    validate_next()
    with session_factory()() as db:
        assert db.get(Job, item['job']['id']).status == 'queued'


def test_cancel_during_put_cannot_publish_asset(cluster, png, monkeypatch):
    from app.storage import get_store
    client, _ = cluster
    auth = login(client)
    submission = submit(client, auth, [descriptor(png)]).json()
    item = submission['items'][0]
    store = get_store('r2')
    put = store.put
    def racing_put(*args, **kwargs):
        put(*args, **kwargs)
        assert client.post(f"/v1/jobs/{item['job']['id']}/cancel", headers=auth).status_code == 200
    monkeypatch.setattr(store, 'put', racing_put)
    client.put(item['upload']['url'], headers=auth, content=png)
    with session_factory()() as db:
        job = db.get(Job, item['job']['id'])
        assert job.status == 'cancelled' and not job.input_asset_id and not job.input_pinned


@pytest.mark.parametrize('removed', ['purged', 'expired'])
def test_verified_replay_rejects_unavailable_original(cluster, png, removed):
    client, _ = cluster
    auth = login(client)
    item = submit(client, auth, [descriptor(png)]).json()['items'][0]
    response = client.put(item['upload']['url'], headers=auth, content=png)
    with session_factory()() as db:
        asset = db.get(Asset, response.json()['asset_id'])
        if removed == 'purged':
            asset.purged_at = now()
        else:
            asset.active_references = 0
            asset.expires_at = now() - timedelta(days=1)
        db.commit()
    assert client.put(item['upload']['url'], headers=auth, content=png).status_code in {404, 410}
    assert client.post(f"/v1/uploads/{item['upload']['id']}/complete", headers=auth).status_code in {404, 410}
