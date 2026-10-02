"""Input receipt persistence needs no second browser confirmation after a crash."""
import pytest
from sqlalchemy import select
from app.db import session_factory
from app.models import Job
from app.queue_models import JobStage
from app.upload_models import UploadReservation
from app.upload_ingress import acquire_ingress, persist_received_upload, release_ingress
from app.storage import StorageError
from conftest import login, request_record
from test_cluster_submissions import cluster, descriptor, submit, upload_id, upload_and_enqueue, validate_next


def test_input_uses_one_object_put_and_reupload_is_idempotent(cluster, png):
    client, sdk = cluster
    auth = login(client)
    item = submit(client, auth, descriptor(png)).json()
    assert upload_and_enqueue(client, auth, item, png)['state'] == 'queued'
    assert upload_and_enqueue(client, auth, item, png)['state'] == 'queued'
    assert [method for method, _ in sdk.calls] == ['PUT']
    with session_factory()() as db:
        assert 'validate_upload' not in db.scalars(select(JobStage.name).where(
            JobStage.job_id == request_record(client, auth, item['id']).job_id)).all()


@pytest.mark.parametrize('padded_jpeg', [False, True])
def test_written_original_recovers_without_browser_confirmation(cluster, png, monkeypatch, padded_jpeg):
    from hashlib import sha256
    from app.models import Asset, Ledger
    from sqlalchemy import func
    from app import upload_ingress
    from app.dispatcher import recover_once
    if padded_jpeg:
        from test_image_metadata import encoded
        png = encoded('JPEG') + b'\0' * 3
    client, sdk = cluster
    auth = login(client)
    image = descriptor(png, content_type='image/jpeg' if padded_jpeg else 'image/png')
    item = submit(client, auth, image).json()
    record = request_record(client, auth, item['id'])
    receipt_id = upload_id(client, auth, item)
    with session_factory()() as db:
        owner = db.get(Job, record.job_id).owner_id
    lease = acquire_ingress(receipt_id, owner)
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
        receipt = db.get(UploadReservation, receipt_id)
        assert receipt.status == 'awaiting_upload' and receipt.verified_info
        assert db.get(Job, receipt.job_id).input_asset_id is None
    recover_once()
    validate_next()
    current = client.get('/v1/translations/' + item['id'], headers=auth)
    assert current.json()['state'] == 'queued', current.text
    assert upload_and_enqueue(client, auth, item, png)['state'] == 'queued'
    assert [method for method, _ in sdk.calls] == ['PUT']
    with session_factory()() as db:
        source = db.get(Asset, db.get(Job, record.job_id).input_asset_id)
        assert source.sha256 == sha256(png).hexdigest() and source.byte_size == len(png)
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'reserve')) == 1
