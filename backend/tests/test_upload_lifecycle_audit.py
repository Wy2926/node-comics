"""Focused race reproductions from final upload lifecycle review."""
from datetime import timedelta
import pytest

from conftest import login
from test_cluster_submissions import cluster, descriptor, submit, upload_and_enqueue
from test_upload_storage import storage_db, remote, owner, pending, validation_lease


@pytest.mark.parametrize("state", ["uploaded", "validating_upload", "running"])
def test_rejected_put_retry_preserves_already_accepted_validation(cluster, png, state):
    from app.db import session_factory
    from app.models import Job
    from app.queue_models import ComputeNode
    from app.scheduler import claim_stage
    from app.upload_models import UploadReservation
    client, _ = cluster
    auth = login(client)
    response = submit(client, auth, [descriptor(png)])
    assert response.status_code == 202, response.text
    item = response.json()["items"][0]
    if state == "uploaded":
        accepted = item["job"]
        response = client.put(item["upload"]["url"], headers=auth, content=png)
        assert response.status_code == 200
    else:
        accepted = upload_and_enqueue(client, auth, item, png)
    if state == "running":
        with session_factory()() as db:
            db.add(ComputeNode(id="audit-validator", name="audit-validator", resource_id="audit-validator",
                capabilities=["validate_upload"], capacity=1, engine_version="control", device="cpu"))
            db.commit()
            assert claim_stage(db, "audit-validator", ["validate_upload"])
            db.commit()
    retry = client.put(item["upload"]["url"], headers=auth, content=png[:-1])
    assert retry.status_code == 422
    with session_factory()() as db:
        job = db.get(Job, accepted["id"])
        receipt = db.get(UploadReservation, item["upload"]["id"])
        assert (job.status, receipt.status, job.settlement) == (
            "awaiting_upload" if state == "uploaded" else state,
            "uploaded" if state == "uploaded" else "validating", "reserved")


def test_pending_put_cannot_downgrade_concurrently_accepted_validation(storage_db, remote, png, monkeypatch):
    from app.db import session_factory
    from app.models import Job, User
    from app.submission_api import upload_complete
    from app.upload_models import UploadReservation
    from app.uploads import receive_upload
    owner_id = owner(storage_db)
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, png)
        db.commit()
        reservation_id, job_id = receipt.id, job.id
        actual_put = remote[1].put
        raced = False
        accepted_expiry = None

        def accept_other_request(key, *args, **kwargs):
            nonlocal raced, accepted_expiry
            if not raced:
                raced = True
                with session_factory()() as other:
                    fresh = other.get(UploadReservation, reservation_id)
                    receive_upload(other, fresh, owner_id, png)
                    other.commit()
                    upload_complete(reservation_id, other.get(User, owner_id), other)
                    accepted_expiry = fresh.expires_at
            return actual_put(key, *args, **kwargs)

        monkeypatch.setattr(remote[1], "put", accept_other_request)
        receive_upload(db, receipt, owner_id, png)
        db.commit()
        assert receipt.status == "validating"
        assert receipt.expires_at == accepted_expiry
        assert db.get(Job, job_id).status == "validating_upload"


@pytest.mark.parametrize("removed", ["purged", "expired"])
def test_verified_upload_replay_rejects_unavailable_original(storage_db, remote, png, removed):
    from app.db import session_factory
    from app.errors import ProcessingError
    from app.models import now
    from app.uploads import complete_upload, receive_upload
    owner_id = owner(storage_db)
    with session_factory()() as db:
        _, receipt = pending(db, owner_id, png)
        receive_upload(db, receipt, owner_id, png)
        original = complete_upload(db, receipt, owner_id)
        if removed == "purged":
            original.purged_at = now()
        else:
            original.active_references = 0
            original.expires_at = now() - timedelta(days=1)
        db.commit()
        with pytest.raises(ProcessingError, match="ASSET_EXPIRED"):
            complete_upload(db, receipt, owner_id)


def test_late_validator_put_is_removed_after_successful_original_deletion(storage_db, remote, png, monkeypatch):
    from app.db import session_factory
    from app.errors import ProcessingError
    from app.main import delete_image
    from app.models import Asset, Job, User, now, uid
    from app.queue_models import ExecutionLease, JobStage
    from app.storage_cleanup import cleanup_orphans
    from app.upload_models import UploadReservation
    from app.uploads import complete_upload, receive_upload
    owner_id = owner(storage_db)
    sdk, store = remote
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, png)
        receive_upload(db, receipt, owner_id, png)
        lease = validation_lease(db, job, receipt)
        reservation_id, lease_id, job_id = receipt.id, lease.id, job.id
        original_key = f"{owner_id}/{reservation_id}"
        actual_put = store.put
        raced = False

        def finish_new_generation_then_delete(key, *args, **kwargs):
            nonlocal raced
            if key == original_key and not raced:
                raced = True
                # The first validator has already passed its lease check and is
                # delayed in storage I/O. A replacement generation finishes.
                with session_factory()() as replacement:
                    old = replacement.get(ExecutionLease, lease_id)
                    old.completed_at = now()
                    stage = replacement.get(JobStage, old.stage_id)
                    stage.generation += 1
                    replacement_lease = ExecutionLease(id=uid(), stage_id=stage.id, job_id=job_id,
                        node_id=old.node_id, owner_id=owner_id, generation=stage.generation,
                        resource_pool="upload", mode="classic", priority_class="preload", weight=1,
                        estimated_seconds=1, expires_at=now() + timedelta(minutes=5))
                    replacement.add(replacement_lease)
                    replacement.commit()
                    fresh_receipt = replacement.get(UploadReservation, reservation_id)
                    completed = complete_upload(replacement, fresh_receipt, owner_id,
                        lease_id=replacement_lease.id, lease_token=replacement_lease.token)
                    stage.status = "succeeded"
                    replacement_lease.completed_at = now()
                    replacement.commit()
                    assert completed.active_references == 1
                with session_factory()() as deletion:
                    delete_image(reservation_id, deletion.get(User, owner_id), deletion)
                    assert deletion.get(Asset, reservation_id).purged_at
                    assert store.prefix + original_key not in sdk.objects
            return actual_put(key, *args, **kwargs)

        monkeypatch.setattr(store, "put", finish_new_generation_then_delete)
        try:
            complete_upload(db, receipt, owner_id, lease_id=lease_id, lease_token=lease.token)
        except ProcessingError as exc:
            assert exc.code == "LEASE_EXPIRED"
        db.rollback()
    with session_factory()() as db:
        assert db.get(Asset, reservation_id).purged_at
        assert db.get(Job, job_id).status == "cancelled"
        cleanup_orphans(db)  # MemoryS3 lists these keys as older than 24 hours.
        db.commit()
    assert store.prefix + original_key not in sdk.objects
