"""One original PUT in the common path; durable recovery after an uncertain write."""
import pytest
from sqlalchemy import select
from app.db import session_factory
from app.models import Job
from app.queue_models import JobStage
from app.upload_models import UploadReservation
from app.upload_ingress import acquire_ingress, persist_received_upload, release_ingress
from app.storage import StorageError
from conftest import login
from test_cluster_submissions import cluster, descriptor, submit, validate_next  # noqa: F401


def test_inline_upload_uses_one_put_no_get_and_complete_is_idempotent(cluster, png):
    client, sdk = cluster
    auth = login(client)
    item = submit(client, auth, [descriptor(png)]).json()['items'][0]
    assert client.put(item['upload']['url'], headers=auth, content=png).json()['status'] == 'verified'
    assert [method for method, _ in sdk.calls] == ['PUT']
    for _ in range(2):
        assert client.post(f"/v1/uploads/{item['upload']['id']}/complete", headers=auth).json()['status'] == 'queued'
    assert [method for method, _ in sdk.calls] == ['PUT']
    with session_factory()() as db:
        assert 'validate_upload' not in db.scalars(select(JobStage.name).where(JobStage.job_id == item['job']['id'])).all()


def test_written_original_recovers_from_intent_without_second_put(cluster, png, monkeypatch):
    from app import upload_ingress
    client, sdk = cluster
    auth = login(client)
    item = submit(client, auth, [descriptor(png)]).json()['items'][0]
    with session_factory()() as db:
        owner = db.get(Job, item['job']['id']).owner_id
    lease = acquire_ingress(item['upload']['id'], owner)
    original = upload_ingress.accept_verified_upload
    def lose_commit(*args, **kwargs):
        raise StorageError()
    monkeypatch.setattr(upload_ingress, 'accept_verified_upload', lose_commit)
    try:
        with pytest.raises(StorageError):
            persist_received_upload(lease, png)
    finally:
        release_ingress(lease)
    monkeypatch.setattr(upload_ingress, 'accept_verified_upload', original)
    with session_factory()() as db:
        receipt = db.get(UploadReservation, item['upload']['id'])
        assert receipt.status == 'awaiting_upload' and receipt.verified_info
        assert db.get(Job, receipt.job_id).input_asset_id is None
    assert client.post(f"/v1/uploads/{item['upload']['id']}/complete", headers=auth).json()['status'] == 'validating_upload'
    validate_next()
    assert client.get(f"/v1/jobs/{item['job']['id']}", headers=auth).json()['status'] == 'queued'
    assert [method for method, _ in sdk.calls] == ['PUT', 'GET']
