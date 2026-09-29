"""Private local upload durability and recovery, without remote storage."""
from datetime import timedelta
import hashlib
import pytest
from sqlalchemy import select


@pytest.fixture
def storage_db(tmp_path, monkeypatch):
    """Exercise storage transactions independently of HTTP/worker adapters."""
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'storage.db').as_posix()}")
    monkeypatch.setenv("STORAGE_PATH", str(tmp_path / "objects"))
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


def test_upload_identity_has_private_path(storage_db, png):
    from app.assets import asset_storage_key
    from app.db import session_factory
    user = owner(storage_db)
    with session_factory()() as db:
        first, a = pending(db, user, png)
        second, b = pending(db, user, png)
        assert asset_storage_key(a.id, 'original') != asset_storage_key(b.id, 'original')


def test_completed_upload_receipt_survives_file_cleanup(storage_db, png):
    from app.assets import asset_storage_key, inspect_image
    from app.storage import get_store
    from app.db import session_factory
    from app.uploads import accept_verified_upload, complete_upload
    from app.workers import finish_job
    user = owner(storage_db)
    with session_factory()() as db:
        job, receipt = pending(db, user, png)
        job.config = {'engine': {'version': 'test', 'protocol_version': 3}}
        get_store().put(asset_storage_key(receipt.id, 'original'), png, 'image/png', kind='original')
        source = accept_verified_upload(db, receipt, b'', inspect_image(png))
        db.commit()
        finish_job(db, job, 'no_text')
        db.commit()
        assert not get_store().exists(source.storage_key)
        assert complete_upload(db, receipt, user).sha256 == hashlib.sha256(png).hexdigest()
