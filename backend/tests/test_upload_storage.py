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




def test_recovery_drops_db_connection_and_fences_lease_lost_during_get(storage_db, remote, png, monkeypatch):
    from app.assets import content_storage_key, inspect_image
    from app.db import engine, session_factory
    from app.errors import ProcessingError
    from app.models import Job, now
    from app.queue_models import ExecutionLease
    from app.uploads import complete_upload
    sdk, store = remote
    owner_id = owner(storage_db)
    with session_factory()() as db:
        job, receipt = pending(db, owner_id, png)
        receipt.verified_info = inspect_image(png)
        lease = validation_lease(db, job, receipt)
        job_id, receipt_id, lease_id, token = job.id, receipt.id, lease.id, lease.token
    store.put(content_storage_key(hashlib.sha256(png).hexdigest()), png, 'image/png', kind='original')
    read = store.read
    def expired_read(key):
        assert engine().pool.checkedout() == 0
        value = read(key)
        with session_factory()() as db:
            db.get(ExecutionLease, lease_id).expires_at = now() - timedelta(seconds=1)
            db.commit()
        return value
    monkeypatch.setattr(store, 'read', expired_read)
    with session_factory()() as db:
        from app.upload_models import UploadReservation
        with pytest.raises(ProcessingError, match='LEASE_EXPIRED'):
            complete_upload(db, db.get(UploadReservation, receipt_id), owner_id, lease_id=lease_id, lease_token=token)
        db.rollback()
        assert db.get(Job, job_id).input_asset_id is None
    assert [method for method, _ in sdk.calls] == ['PUT', 'GET']
