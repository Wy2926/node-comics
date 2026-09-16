"""Upload validation and R2 durability; no supplier calls or shared test data."""
import asyncio
from datetime import timedelta
import hashlib
from unittest.mock import Mock
from fastapi import HTTPException
import pytest
from sqlalchemy import select
from storage_fakes import MemoryS3


@pytest.fixture
def storage_db(tmp_path, monkeypatch):
    """Exercise storage transactions independently of HTTP/worker adapters."""
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'storage.db').as_posix()}")
    monkeypatch.setenv("STORAGE_PATH", str(tmp_path / "objects"))
    monkeypatch.setenv("RESULT_STORAGE_BACKEND", "local")
    monkeypatch.setenv("RETENTION_DAYS", "7")
    monkeypatch.setenv("R2_ENDPOINT_URL", "")
    monkeypatch.setenv("DEV_AUTH", "true")
    from app.config import settings
    from app.db import Base, engine, session_factory
    from app import models, upload_models, queue_models, entitlement_models  # noqa: F401
    settings.cache_clear()
    if engine.cache_info().currsize:
        engine().dispose()
    engine.cache_clear()
    Base.metadata.create_all(engine())
    with session_factory()() as db:
        db.add(queue_models.SchedulerMutex(id=1))
        db.commit()
    yield
    engine().dispose()
    engine.cache_clear()
    settings.cache_clear()


@pytest.fixture
def remote(storage_db, monkeypatch):
    from app.config import settings
    from app.storage import S3Store
    import app.storage as storage
    settings().result_storage_backend = "r2"
    settings().r2_endpoint_url = "https://" + "a" * 32 + ".r2.cloudflarestorage.com"
    sdk = MemoryS3()
    store = S3Store(sdk, "test-bucket", "isolated/")
    monkeypatch.setattr(storage, "r2_store", lambda *args: store)
    return sdk, store


def pending(db, owner_id, data, *, mime="image/png"):
    from app.models import Job, uid
    from app.uploads import create_upload
    job = Job(id=uid(), owner_id=owner_id, mode="classic", target_language="zh-Hans",
              status="awaiting_upload", phase="awaiting_upload", idempotency_key=uid(),
              operation="submission", request_hash="b" * 64, cache_key=uid(),
              config={}, quota_pages=0, quota_kind="classic", settlement="included")
    db.add(job)
    db.flush()
    receipt = create_upload(db, job, {"sha256": hashlib.sha256(data).hexdigest(),
                                     "byte_size": len(data), "mime": mime})
    return job, receipt


def owner(storage_db):
    from app.db import session_factory
    from app.models import User
    with session_factory()() as db:
        user = db.scalar(select(User).where(User.subject == "dev:alice"))
        if not user:
            user = User(subject="dev:alice", name="alice")
            db.add(user)
            db.commit()
        return user.id


def test_originals_live_in_r2_and_queries_never_probe_objects(storage_db, remote, png):
    from app.assets import access_json, available, create_asset, object_path
    from app.db import session_factory
    sdk, _ = remote
    owner_id = owner(storage_db)
    with session_factory()() as db:
        original = create_asset(db, owner_id, png)
        assert original.storage_backend == "r2"
        assert not object_path(original.storage_key).exists()
        calls = len(sdk.calls)
        assert available(original)
        assert access_json(original)["authorization_required"] is False
        assert len(sdk.calls) == calls


def test_originals_refuse_production_local_storage(storage_db, png):
    from app.assets import create_asset
    from app.config import settings
    from app.db import session_factory
    owner_id = owner(storage_db)
    settings().dev_auth = False
    with session_factory()() as db, pytest.raises(ValueError, match="private R2"):
        create_asset(db, owner_id, png)


def test_upload_verifies_same_buffer_to_server_only_key_and_replays(storage_db, remote, png, monkeypatch):
    from app.assets import read_asset
    from app.db import session_factory
    from app.models import Asset
    from app.uploads import complete_upload, receive_upload, upload_json
    import app.scheduler as scheduler
    stages = Mock()
    monkeypatch.setattr(scheduler, "ensure_stages", stages, raising=False)
    owner_id = owner(storage_db)
    sdk, store = remote
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, png)
        public = upload_json(receipt)
        assert public["authorization_required"] is True and public["method"] == "PUT"
        assert receipt.storage_key not in public["url"]
        receive_upload(db, receipt, owner_id, png)
        original_read = store.read
        def raced_read(key):
            result = original_read(key)
            if key == receipt.storage_key:
                sdk.objects[store.prefix + key] = b"attacker overwrite after validation read"
            return result
        monkeypatch.setattr(store, "read", raced_read)
        asset = complete_upload(db, receipt, owner_id)
        assert asset and read_asset(asset) == png
        assert job.status == "queued" and job.input_pinned
        assert asset.active_references == 1
        assert asset.storage_key != receipt.storage_key
        calls = len(sdk.calls)
        assert complete_upload(db, receipt, owner_id).id == asset.id
        assert receive_upload(db, receipt, owner_id, b"changed") is receipt
        assert len(sdk.calls) == calls
        assert asset.active_references == 1 and stages.call_count == 1
        assert db.scalar(select(Asset.id).where(Asset.id == receipt.asset_id)) == asset.id


@pytest.mark.parametrize("invalid", ["hash", "size", "image", "mime"])
def test_upload_failure_releases_only_its_job_and_never_becomes_ready(storage_db, remote, png, invalid, monkeypatch):
    from app.db import session_factory
    from app.uploads import complete_upload, receive_upload
    import app.jobs as jobs
    owner_id = owner(storage_db)
    data = b"not a static image" if invalid == "image" else png
    settle = Mock()
    monkeypatch.setattr(jobs, "settle", settle)
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, data, mime="image/jpeg" if invalid == "mime" else "image/png")
        if invalid == "hash":
            receipt.expected_sha256 = "0" * 64
        elif invalid == "size":
            receipt.expected_size += 1
        receive_upload(db, receipt, owner_id, data)
        assert complete_upload(db, receipt, owner_id) is None
        assert job.status == "failed" and receipt.status == "failed"
        assert receipt.asset_id is None
        assert settle.call_count == 1
        complete_upload(db, receipt, owner_id)
        assert settle.call_count == 1


def test_expiry_and_cancel_release_upload_once(storage_db, remote, png, monkeypatch):
    from app.db import session_factory
    from app.models import now
    from app.uploads import complete_upload, expire_uploads, receive_upload
    import app.jobs as jobs
    settle = Mock()
    monkeypatch.setattr(jobs, "settle", settle)
    owner_id = owner(storage_db)
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, png)
        receipt.expires_at = now() - timedelta(seconds=1)
        db.flush()
        assert expire_uploads(db) == 1
        assert expire_uploads(db) == 0
        assert job.status == "failed" and receipt.status == "expired"
        assert complete_upload(db, receipt, owner_id) is None
        other, cancelled = pending(db, owner_id, png)
        other.cancel_requested = True
        receive_upload(db, cancelled, owner_id, png)
        assert cancelled.status == "cancelled" and other.status == "cancelled"
        assert settle.call_count == 2


def test_upload_account_isolation_does_no_remote_io(storage_db, remote, png):
    from app.db import session_factory
    from app.uploads import complete_upload, receive_upload
    owner_id = owner(storage_db)
    with session_factory()() as db:
        _, receipt = pending(db, owner_id, png)
        for action in (lambda: receive_upload(db, receipt, "other-owner", png),
                       lambda: complete_upload(db, receipt, "other-owner")):
            with pytest.raises(HTTPException) as error:
                action()
            assert error.value.status_code == 404
        assert remote[0].calls == []


@pytest.mark.parametrize("headers,chunks,size,expected", [
    ({}, [b"12", b"345"], 4, 413),
    ({"content-length": "1"}, [b"12345"], 4, 413),
    ({"content-length": "9000"}, [b"1"], 4, 413),
    ({}, [b"123"], 4, 422),
    ({}, [b"12", b"34"], 4, None),
])
def test_chunked_upload_measures_actual_bytes(storage_db, headers, chunks, size, expected):
    from app.uploads import read_upload_stream
    class Request:
        async def stream(self):
            for chunk in chunks:
                yield chunk
    request = Request()
    request.headers = headers
    if expected:
        with pytest.raises(HTTPException) as error:
            asyncio.run(read_upload_stream(request, size))
        assert error.value.status_code == expected
    else:
        assert asyncio.run(read_upload_stream(request, size)) == b"1234"


def test_retention_starts_with_delivery_and_active_originals_stay_available(storage_db, remote, png):
    from app.assets import access_json, available, create_asset
    from app.config import settings
    from app.db import session_factory
    from app.models import now
    owner_id = owner(storage_db)
    with session_factory()() as db:
        original = create_asset(db, owner_id, png)
        original.expires_at = now() - timedelta(days=2)
        original.active_references = 1
        assert available(original)
        assert access_json(original)["url"]
        before = now()
        output = create_asset(db, owner_id, png, kind="classic", parent_id=original.id)
        assert output.expires_at >= before + timedelta(days=settings().retention_days)
        assert original.expires_at >= output.expires_at
        original.deleted_at = now()
        assert not available(original)


def test_storage_outage_keeps_upload_retryable(storage_db, remote, png):
    from app.db import session_factory
    from app.storage import StorageError
    from app.uploads import receive_upload
    owner_id = owner(storage_db)
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, png)
        remote[0].uncertain_put = True
        with pytest.raises(StorageError):
            receive_upload(db, receipt, owner_id, png)
        assert receipt.status == "awaiting_upload" and job.status == "awaiting_upload"
        receive_upload(db, receipt, owner_id, png)
        assert receipt.status == "uploaded"


def test_commit_rollback_keeps_staging_and_retry_creates_one_original(storage_db, remote, png, monkeypatch):
    from app.db import session_factory
    from app.models import Asset, Job
    from app.upload_models import UploadReservation
    from app.uploads import complete_upload, receive_upload
    import app.scheduler as scheduler
    monkeypatch.setattr(scheduler, "ensure_stages", lambda *args: None)
    owner_id = owner(storage_db)
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, png)
        receive_upload(db, receipt, owner_id, png)
        db.commit()
        receipt_id, job_id, staging_key = receipt.id, job.id, receipt.storage_key
        first = complete_upload(db, receipt, owner_id)
        assert remote[1].prefix + staging_key in remote[0].objects
        db.rollback()
        assert db.get(Asset, receipt_id) is None
        receipt = db.get(UploadReservation, receipt_id)
        assert receipt.status == "uploaded"
        assert db.get(Job, job_id).status == "awaiting_upload"
        second = complete_upload(db, receipt, owner_id)
        db.commit()
        assert first.id == second.id == receipt_id
        assert second.active_references == 1
        assert len(db.scalars(select(Asset)).all()) == 1




def test_remote_transfer_and_image_decode_precede_scheduler_lock(storage_db, remote, png, monkeypatch):
    from app.db import session_factory
    from app.uploads import complete_upload, receive_upload
    import app.uploads as uploads
    import app.scheduler as scheduler
    owner_id = owner(storage_db)
    events = []
    store = remote[1]
    actual_put, actual_read, actual_inspect = store.put, store.read, uploads.inspect_image
    actual_lock = scheduler.lock_scheduler
    def put(*args, **kwargs):
        events.append("put")
        return actual_put(*args, **kwargs)
    def read(*args):
        events.append("read")
        return actual_read(*args)
    def inspect(*args):
        events.append("decode")
        return actual_inspect(*args)
    def lock(db):
        events.append("lock")
        return actual_lock(db)
    monkeypatch.setattr(store, "put", put)
    monkeypatch.setattr(store, "read", read)
    monkeypatch.setattr(uploads, "inspect_image", inspect)
    monkeypatch.setattr(scheduler, "lock_scheduler", lock)
    with session_factory()() as db:
        _, receipt = pending(db, owner_id, png)
        db.commit()
        receive_upload(db, receipt, owner_id, png)
        db.commit()
        assert events == ["put", "lock"]
        events.clear()
        complete_upload(db, receipt, owner_id)
        assert events[:4] == ["read", "decode", "put", "lock"]
        assert all(event == "lock" for event in events[4:])


def test_cancel_during_r2_validation_cannot_requeue_job(storage_db, remote, png, monkeypatch):
    from app.db import session_factory
    from app.models import Asset, Job
    from app.uploads import complete_upload, receive_upload
    owner_id = owner(storage_db)
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, png)
        receive_upload(db, receipt, owner_id, png)
        db.commit()
        actual_put = remote[1].put
        def cancelled_during_transfer(*args, **kwargs):
            actual_put(*args, **kwargs)
            with session_factory()() as other:
                pending_job = other.get(Job, job.id)
                pending_job.cancel_requested, pending_job.status = True, "cancelled"
                other.commit()
        monkeypatch.setattr(remote[1], "put", cancelled_during_transfer)
        assert complete_upload(db, receipt, owner_id) is None
        assert receipt.status == "cancelled" and job.status == "cancelled"
        assert db.get(Asset, receipt.id) is None


def validation_lease(db, job, receipt):
    from app.models import now, uid
    from app.queue_models import ComputeNode, ExecutionLease, JobStage
    node = ComputeNode(id=uid(), name="isolated-validator", capabilities=["validate_upload"], capacity=1,
                       resource_id=uid(), engine_version="validator-1", device="cpu")
    stage = JobStage(id=uid(), job_id=job.id, name="validate_upload", status="running", generation=1)
    db.add_all([node, stage])
    db.flush()
    lease = ExecutionLease(id=uid(), stage_id=stage.id, job_id=job.id, node_id=node.id, owner_id=job.owner_id,
                           generation=1, resource_pool="upload", mode=job.mode, priority_class="preload",
                           weight=1, estimated_seconds=1, expires_at=now() + timedelta(minutes=5))
    db.add(lease)
    job.status, job.phase = "running", "validate_upload"
    receipt.status, receipt.expires_at = "validating", now() - timedelta(hours=1)
    db.commit()
    return lease


def test_accepted_validation_does_not_expire_while_waiting_for_resources(storage_db, remote, png):
    from app.db import session_factory
    from app.uploads import complete_upload, expire_uploads, receive_upload
    owner_id = owner(storage_db)
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, png)
        receive_upload(db, receipt, owner_id, png)
        lease = validation_lease(db, job, receipt)
        assert expire_uploads(db) == 0
        db.commit()
        asset = complete_upload(db, receipt, owner_id, lease_id=lease.id, lease_token=lease.token)
        assert asset and job.status == "queued" and job.input_pinned


def test_expired_validation_lease_cannot_finalize_after_remote_put(storage_db, remote, png, monkeypatch):
    from app.db import session_factory
    from app.errors import ProcessingError
    from app.models import Asset, now
    from app.queue_models import ExecutionLease, JobStage
    from app.uploads import complete_upload, receive_upload
    owner_id = owner(storage_db)
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, png)
        receive_upload(db, receipt, owner_id, png)
        lease = validation_lease(db, job, receipt)
        actual_put = remote[1].put
        def lost_lease_during_transfer(*args, **kwargs):
            actual_put(*args, **kwargs)
            with session_factory()() as other:
                expired = other.get(ExecutionLease, lease.id)
                expired.completed_at = now()
                other.get(JobStage, expired.stage_id).generation += 1
                other.commit()
        monkeypatch.setattr(remote[1], "put", lost_lease_during_transfer)
        with pytest.raises(ProcessingError, match="LEASE_EXPIRED"):
            complete_upload(db, receipt, owner_id, lease_id=lease.id, lease_token=lease.token)
        assert db.get(Asset, receipt.id) is None
        assert receipt.status == "validating" and not job.input_pinned
