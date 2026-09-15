"""Bounded, durable remote sweep of objects left by rolled-back transactions."""
from datetime import timedelta
import time
from sqlalchemy import select
from .config import settings
from .models import Asset, Attempt, Job, StorageScan, now
from .storage import get_store, StorageError


def referenced(db, backend, key):
    if db.scalar(select(Asset.id).where(Asset.storage_backend == backend, Asset.storage_key == key)):
        return True
    # A save-before-commit output must survive until its attempt is reconciled.
    parts = key.split("/")
    return len(parts) == 2 and db.scalar(select(Attempt.id).join(Job, Job.attempt_id == Attempt.id).where(
        Attempt.id == parts[1], Attempt.output_storage_backend == backend, Job.owner_id == parts[0],
        Job.status.in_(["running", "outcome_unknown"]))) is not None


def cleanup_orphans(db, *, skip_remote=False):
    cutoff = now() - timedelta(days=1)
    root = settings().storage_path
    for path in root.glob("*/*"):
        if path.is_file() and path.stat().st_mtime < time.time() - 24 * 3600:
            key = path.relative_to(root).as_posix()
            if not referenced(db, "local", key):
                get_store("local").delete(key)
    if skip_remote or not settings().r2_endpoint_url:
        return
    # Inserting with ON CONFLICT also serializes the initial concurrent sweep.
    if db.get_bind().dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    db.execute(insert(StorageScan).values(backend="r2", next_scan_at=now()).on_conflict_do_nothing(index_elements=["backend"]))
    scan = db.scalar(select(StorageScan).where(StorageScan.backend == "r2").with_for_update(skip_locked=True))
    if not scan or scan.next_scan_at > now():
        return
    try:
        store = get_store("r2")
        objects, cursor = store.list_page(scan.cursor)
        for key, modified in objects:
            if modified < cutoff and not referenced(db, "r2", key):
                store.delete(key)
        scan.cursor = cursor
        scan.next_scan_at = now() + (timedelta(seconds=2) if cursor else timedelta(hours=1))
    except StorageError:
        # Keep the cursor; a partial sweep is safe to repeat after an outage.
        scan.next_scan_at = now() + timedelta(minutes=1)
