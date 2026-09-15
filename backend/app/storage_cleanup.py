"""Bounded, durable remote sweep of objects left by rolled-back transactions."""
from datetime import timedelta
import time
from sqlalchemy import select
from .config import settings
from .models import Asset, Attempt, Job, StorageScan, now
from .storage import get_store, StorageError
from .upload_models import UploadReservation
from .queue_models import ExecutionLease


def referenced(db, backend, key):
    asset = db.scalar(select(Asset).where(Asset.storage_backend == backend, Asset.storage_key == key))
    if asset:
        # A delayed PUT can recreate a key after deletion completed. Its purged
        # metadata must not protect those bytes forever, even if an old lease or
        # upload receipt still exists. Nonpurged tombstones stay on the durable
        # asset cleanup path so failed deletes can be retried there.
        return asset.purged_at is None
    # A validated original PUT can precede its database commit. Its active upload
    # receipt protects both staging and final server-generated keys on recovery.
    upload_id = key.split("/")[-1]
    reservation = db.get(UploadReservation, upload_id)
    if (reservation and reservation.storage_backend == backend
            and reservation.status in {"awaiting_upload", "uploaded", "validating"}
            and key in {reservation.storage_key, f"{reservation.owner_id}/{reservation.id}"}):
        job = db.get(Job, reservation.job_id)
        if (reservation.expires_at > now() or (job and (job.status == "validating_upload"
                or (job.status == "running" and job.phase == "validate_upload")))):
            return True
    # A save-before-commit output is fenced by its execution lease. Preserve it
    # while the job is live or still requires explicit upstream reconciliation.
    parts = key.split("/")
    return len(parts) == 2 and db.scalar(select(ExecutionLease.id)
        .join(Job, Job.id == ExecutionLease.job_id).join(Attempt, Attempt.id == Job.attempt_id).where(
            ExecutionLease.id == parts[1], ExecutionLease.owner_id == parts[0],
            Attempt.output_storage_backend == backend,
            Job.status.in_(["running", "outcome_unknown", "unknown_released"]))) is not None


def cleanup_orphans(db, *, skip_remote=False):
    cutoff = now() - timedelta(days=1)
    root = settings().storage_path
    for path in root.rglob("*"):
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
