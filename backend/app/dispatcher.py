"""Lease reconciliation and retention maintenance. No message broker or dispatch backlog."""
from datetime import timedelta
import logging
import time
from sqlalchemy import and_, or_, select
from .assets import available, create_asset, delete_asset_object, inspect_image
from .config import settings
from .db import initialize, session_factory
from .errors import ProcessingError
from .jobs import cancel_job, settle
from .models import Asset, Attempt, ClassicState, Job, Provider, now
from .queue_models import ExecutionLease, JobStage
from .scheduler import lock_scheduler, release_lease, touch_job
from .storage import get_store, StorageError
from .storage_cleanup import cleanup_orphans
from .uploads import expire_uploads
from .workers import fail_stage, finish_job

log = logging.getLogger("node_comics.maintenance")


def recover_lease(lease_id):
    with session_factory()() as db:
        lease = db.get(ExecutionLease, lease_id)
        if not lease or lease.completed_at or lease.expires_at > now():
            return
        job, stage = db.get(Job, lease.job_id), db.get(JobStage, lease.stage_id)
        attempt = db.get(Attempt, job.attempt_id)
        image = None
        if stage.name in {"render", "redraw"}:
            store = get_store(attempt.output_storage_backend)
            key = f"{job.owner_id}/{lease.id}"
            try:
                image = store.read(key) if store.exists(key) else None
            except StorageError:
                return  # An unavailable object store is not evidence of absent output.
        unknown = stage.name == "redraw" and attempt.call_started_at is not None
    if image is None:
        fail_stage(lease_id, ProcessingError("UPSTREAM_OUTCOME_UNKNOWN" if unknown else "WORKER_LEASE_EXPIRED",
            "计算节点失联，保留调用记录并恢复可重复阶段", unknown=unknown), recovering=True)
        return
    info = inspect_image(image, output=True)
    with session_factory()() as db:
        lock_scheduler(db)
        lease = db.get(ExecutionLease, lease_id)
        if lease.completed_at or lease.expires_at > now():
            return
        job, stage = db.get(Job, lease.job_id), db.get(JobStage, lease.stage_id)
        source = db.get(Asset, job.input_asset_id)
        if stage.generation != lease.generation:
            release_lease(db, lease, "cancelled")
        elif job.status not in {"running", "outcome_unknown"}:
            stage.status = "cancelled"
            release_lease(db, lease, "cancelled")
        elif job.cancel_requested or job.discard_output or not available(source):
            finish_job(db, job, "cancelled")
            stage.status = "cancelled"
            release_lease(db, lease, "cancelled")
        else:
            ratio = (info["width"] / info["height"]) / (source.width / source.height)
            if not .8 <= ratio <= 1.25 or (job.mode == "classic" and (info["width"], info["height"]) != (source.width, source.height)):
                finish_job(db, job, "failed", error=ProcessingError("INVALID_PROVIDER_OUTPUT", "已存结果尺寸不合格"))
                release_lease(db, lease, "failed")
            else:
                attempt = db.get(Attempt, job.attempt_id)
                output = db.get(Asset, lease_id) or create_asset(db, job.owner_id, image, kind=job.mode, parent_id=source.id,
                    stable_id=lease_id, storage_backend=attempt.output_storage_backend, prewritten=True, verified_info=info)
                job.output_asset_id = output.id
                state = db.get(ClassicState, job.id)
                job.quality_flags = (state.analysis or {}).get("quality_flags", []) if state else []
                if abs(ratio - 1) > .03:
                    job.quality_flags = [*job.quality_flags, "aspect_ratio_changed"]
                stage.status, stage.completed_at = "succeeded", now()
                finish_job(db, job, "succeeded")
                attempt.recovered = True
                release_lease(db, lease, "succeeded")
        touch_job(db, job)
        db.commit()


def recover_once():
    with session_factory()() as db:
        ids = list(db.scalars(select(ExecutionLease.id).where(ExecutionLease.completed_at.is_(None), ExecutionLease.expires_at <= now()).limit(100)))
    for lease_id in ids:
        try:
            recover_lease(lease_id)
        except (StorageError, ProcessingError):
            continue
    with session_factory()() as db:
        lock_scheduler(db)
        deadline = now() - timedelta(seconds=settings().unknown_release_seconds)
        for job in db.scalars(select(Job).where(Job.status == "outcome_unknown", Job.unknown_since <= deadline)):
            job.status, job.phase, job.completed_at = "unknown_released", "reconciliation_required", now()
            settle(db, job, success=False)
        expire_uploads(db)
        for job in db.scalars(select(Job).where(Job.status == "queued", Job.mode == "redraw")):
            provider = db.get(Provider, job.config["provider"]["id"])
            if not provider or not provider.enabled:
                finish_job(db, job, "failed", error=ProcessingError("PROVIDER_DISABLED", "图片服务已停用"))
        db.commit()


def cleanup(db):
    lock_scheduler(db)
    expired = and_(Asset.expires_at.is_not(None), Asset.expires_at <= now(), Asset.active_references == 0)
    parents = select(Asset.id).where(or_(expired, Asset.deleted_at.is_not(None)))
    assets = list(db.scalars(select(Asset).where(Asset.purged_at.is_(None), or_(expired, Asset.deleted_at.is_not(None), Asset.parent_id.in_(parents)))
        .order_by(Asset.expires_at, Asset.id).limit(200)))
    for asset in assets:
        asset.deleted_at = asset.deleted_at or now()
        for job in db.scalars(select(Job).where(or_(Job.input_asset_id == asset.id, Job.output_asset_id == asset.id))):
            if job.input_asset_id == asset.id:
                cancel_job(db, job)
            touch_job(db, job)
        for state in db.scalars(select(ClassicState).join(Job, Job.id == ClassicState.job_id).where(Job.input_asset_id == asset.id)):
            db.delete(state)
    db.commit()  # Revoke access before slow object deletion, without a scheduler lock.
    for asset in assets:
        try:
            delete_asset_object(asset)
            asset.purged_at = now()
        except StorageError:
            continue
    db.commit()
    cleanup_orphans(db)
    db.commit()


def main():
    initialize()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    while True:
        try:
            recover_once()
            with session_factory()() as db:
                cleanup(db)
        except Exception:
            log.warning("Translation maintenance paused; retrying from durable state.")
        time.sleep(settings().dispatch_interval_seconds)


if __name__ == "__main__":
    main()
