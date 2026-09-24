"""Lease reconciliation and retention maintenance. No message broker or dispatch backlog."""
from datetime import timedelta
import logging
import signal
from threading import Event
import time
from sqlalchemy import and_, or_, select
from .assets import available, content_storage_key, create_asset, inspect_image
from .config import settings
from .db import initialize, session_factory
from .errors import ProcessingError
from .health import log_failure, probe_oidc, report_failure, report_progress
from .jobs import cancel_job, settle
from .models import Asset, Attempt, ClassicState, Job, Provider, now
from .queue_models import ExecutionLease, JobStage
from .scheduler import lock_scheduler, release_lease, touch_job
from .storage import get_store, StorageError
from .uploads import expire_uploads, recover_received_uploads
from .translation_limits import clean_admissions
from .workers import fail_stage, finish_job

def recover_lease(lease_id):
    with session_factory()() as db:
        lease = db.get(ExecutionLease, lease_id)
        if not lease or lease.completed_at or lease.expires_at > now():
            return
        job, stage = db.get(Job, lease.job_id), db.get(JobStage, lease.stage_id)
        attempt = db.get(Attempt, job.attempt_id)
        image = None
        if stage.name == "redraw":
            store = get_store(attempt.output_storage_backend)
            key = lease.output_key
            try:
                image = store.read(key) if key and store.exists(key) else None
            except StorageError:
                return  # An unavailable object store is not evidence of absent output.
        unknown = stage.name == "redraw" and attempt.call_started_at is not None
        expired_page = False
        invalid_source = False
        if stage.name == 'page':
            from .compute_v2 import lease_deadline
            expired_page = lease_deadline(db, lease) <= now()
            invalid_source = not available(db.get(Asset, job.input_asset_id))
    if image is None:
        code = ('ASSET_EXPIRED' if invalid_source else 'PAGE_DEADLINE_EXCEEDED' if expired_page
                else 'UPSTREAM_OUTCOME_UNKNOWN' if unknown else 'WORKER_LEASE_EXPIRED')
        fail_stage(lease_id, ProcessingError(code,
            "计算节点失联，保留调用记录并恢复可重复阶段", unknown=unknown), recovering=True)
        return
    try:
        info = inspect_image(image, output=True)
        if content_storage_key(info["sha256"]) != key:
            raise ProcessingError("INVALID_PROVIDER_OUTPUT", "已存结果与租约内容摘要不一致")
    except ProcessingError as error:
        fail_stage(lease_id, error, recovering=True)
        return
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
            if not .8 <= ratio <= 1.25:
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
    recover_received_uploads()
    with session_factory()() as db:
        ids = list(db.scalars(select(ExecutionLease.id).where(ExecutionLease.completed_at.is_(None), ExecutionLease.expires_at <= now()).limit(100)))
    for lease_id in ids:
        try:
            recover_lease(lease_id)
        except (StorageError, ProcessingError) as error:
            log_failure("lease-recovery", error, lease_id=lease_id)
            continue
    deadline = now() - timedelta(seconds=settings().unknown_release_seconds)
    unknown_filter = (Job.status == "outcome_unknown", Job.unknown_since <= deadline)
    provider_join = Provider.id == Job.config["provider"]["id"].as_string()
    disabled_filter = (Job.status == "queued", Job.mode == "redraw", or_(Provider.id.is_(None), Provider.enabled.is_(False)))
    # Select bounded candidate IDs without blocking claims. Their eligibility is
    # rechecked under the scheduler lock before any settlement/status mutation.
    with session_factory()() as db:
        unknown_ids = list(db.scalars(select(Job.id).where(*unknown_filter).order_by(Job.unknown_since, Job.id).limit(100)))
        disabled_ids = list(db.scalars(select(Job.id).outerjoin(Provider, provider_join).where(*disabled_filter)
            .order_by(Job.created_at, Job.id).limit(100)))
    with session_factory()() as db:
        lock_scheduler(db)
        for job in db.scalars(select(Job).where(Job.id.in_(unknown_ids), *unknown_filter)):
            job.status, job.phase, job.completed_at = "unknown_released", "reconciliation_required", now()
            settle(db, job, success=False)
        expire_uploads(db)
        clean_admissions(db)
        for job in db.scalars(select(Job).outerjoin(Provider, provider_join).where(Job.id.in_(disabled_ids), *disabled_filter)):
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
        # This marks cleanup of the user's grant, never physical object deletion.
        # Content-addressed originals and outputs can be shared by other users.
        asset.purged_at = now()
    db.commit()


def main():
    stopping = Event()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, lambda *_: stopping.set())
    initialize()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    from threading import Thread
    from .billing_sync import run as billing_maintenance
    Thread(target=billing_maintenance, args=(stopping,), daemon=True).start()
    next_oidc_probe = 0
    while not stopping.is_set():
        try:
            recover_once()
            with session_factory()() as db:
                cleanup(db)
            if time.monotonic() >= next_oidc_probe:
                probe_oidc()
                next_oidc_probe = time.monotonic() + max(1, min(60, settings().cluster_node_timeout_seconds / 3))
            report_progress("maintenance")
        except Exception as error:
            report_failure("maintenance", error)
        stopping.wait(settings().dispatch_interval_seconds)


if __name__ == "__main__":
    main()
