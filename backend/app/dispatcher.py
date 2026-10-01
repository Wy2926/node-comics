"""Lease reconciliation and retention maintenance. No message broker or dispatch backlog."""
from datetime import timedelta
import logging
import signal
from threading import Event
import time
from sqlalchemy import and_, or_, select
from .assets import available, asset_storage_key, create_asset, inspect_image
from .config import settings
from .db import session_factory
from .runtime import check_runtime
from .errors import ProcessingError
from .health import log_failure, probe_oidc, report_failure, report_progress
from .jobs import settle
from .models import Asset, Attempt, ClassicState, Job, Provider, now
from .queue_models import ExecutionLease, JobStage
from .redis_state import AdmissionUnavailable
from .scheduler import lock_scheduler, release_lease, touch_job
from .storage import get_store, StorageError
from .uploads import expire_uploads, recover_received_uploads
from .workers import fail_stage, finish_job

def recover_lease(lease_id):
    from .compute_v3 import recover_compute_results
    with session_factory()() as recovery_db:
        recover_compute_results(recovery_db)
        recovery_db.commit()
    with session_factory()() as db:
        lease = db.get(ExecutionLease, lease_id)
        if not lease or lease.completed_at or lease.expires_at > now():
            return
        job, stage = db.get(Job, lease.job_id), db.get(JobStage, lease.stage_id)
        attempt = db.get(Attempt, job.attempt_id)
        image = None
        if stage.name == "redraw":
            store = get_store()
            key = lease.output_key
            try:
                image = store.read(key) if key and store.exists(key) else None
            except StorageError:
                return  # An unavailable object store is not evidence of absent output.
        unknown = stage.name == "redraw" and attempt.call_started_at is not None
        expired_page = False
        invalid_source = False
        if stage.name == 'page':
            from .compute_v3 import lease_deadline
            expired_page = lease_deadline(db, lease) <= now()
            invalid_source = not available(db.get(Asset, job.input_asset_id))
    if invalid_source and stage.name == 'page':
        with session_factory()() as db:
            lock_scheduler(db)
            lease = db.get(ExecutionLease, lease_id)
            stage, job = db.get(JobStage, lease.stage_id), db.get(Job, lease.job_id)
            if lease.completed_at:
                return
            if stage.generation == lease.generation and not job.cancel_requested and not job.discard_output and job.status in {'queued', 'running'}:
                from .uploads import pause_missing_input
                release_lease(db, lease, 'failed')
                stage.status = 'ready'
                pause_missing_input(db, job)
                db.commit()
                return
    if image is None:
        code = ('ASSET_EXPIRED' if invalid_source else 'PAGE_DEADLINE_EXCEEDED' if expired_page
                else 'UPSTREAM_OUTCOME_UNKNOWN' if unknown else 'WORKER_LEASE_EXPIRED')
        fail_stage(lease_id, ProcessingError(code,
            "计算节点失联，保留调用记录并恢复可重复阶段", unknown=unknown), recovering=True)
        return
    try:
        info = inspect_image(image, output=True)
        if info["sha256"] != (lease.limits.get("output_info") or {}).get("sha256"):
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
                    stable_id=lease_id, prewritten=True, verified_info=info)
                job.output_asset_id = output.id
                job.result_description = {'representation': 'full-image-v1', 'input_hash': source.sha256,
                    'normalization_version': source.normalization_version, 'width': output.width, 'height': output.height}
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


_input_scan_cursor = None


def recover_missing_inputs(limit=100):
    """Queue loss is recoverable even when no compute node can claim the page."""
    global _input_scan_cursor
    with session_factory()() as db:
        candidates = list(db.scalars(select(Job.id).join(Asset, Asset.id == Job.input_asset_id).where(
            Job.status == 'queued', Job.cancel_requested.is_(False), Job.discard_output.is_(False),
            Asset.deleted_at.is_(None),
            Job.id > _input_scan_cursor if _input_scan_cursor else True).order_by(Job.id).limit(limit)))
    _input_scan_cursor = candidates[-1] if len(candidates) == limit else None
    for job_id in candidates:
        with session_factory()() as db:
            job = db.get(Job, job_id)
            source = db.get(Asset, job.input_asset_id)
            if get_store().exists(source.storage_key):
                continue
            lock_scheduler(db)
            db.refresh(job)
            if job.status != 'queued' or job.cancel_requested or job.discard_output:
                continue
            if db.scalar(select(ExecutionLease.id).where(ExecutionLease.job_id == job_id,
                    ExecutionLease.completed_at.is_(None)).limit(1)):
                continue
            from .uploads import pause_missing_input
            pause_missing_input(db, job)
            db.commit()


def recover_once():
    recover_missing_inputs()
    from .compute_v3 import recover_compute_results
    with session_factory()() as recovery_db:
        recover_compute_results(recovery_db)
        recovery_db.commit()
    try:
        recover_received_uploads()
    except AdmissionUnavailable as error:
        # Upload recovery needs ingress state; SQL recovery and cleanup do not.
        log_failure("upload-recovery", error)
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
        for job in db.scalars(select(Job).outerjoin(Provider, provider_join).where(Job.id.in_(disabled_ids), *disabled_filter)):
            finish_job(db, job, "failed", error=ProcessingError("PROVIDER_DISABLED", "图片服务已停用"))
        db.commit()


_lease_cleanup_cursor = None
_upload_cleanup_cursor = None


def cleanup(db):
    """Only durable tombstones/terminal intents authorize physical deletion."""
    from .assets import cleanup_inputs
    from .scheduler import ACTIVE
    from .upload_models import UploadReservation
    global _lease_cleanup_cursor, _upload_cleanup_cursor
    lock_scheduler(db)
    orphan_cutoff = now() - timedelta(seconds=max(3600, settings().upload_body_timeout_seconds * 2))
    orphan_results = list(db.scalars(select(Asset).outerjoin(Job, Job.output_asset_id == Asset.id).where(
        Asset.kind != "original", Asset.deleted_at.is_(None), Asset.created_at <= orphan_cutoff,
        Job.id.is_(None), or_(Asset.parent_id.is_(None), Asset.parent_id.not_in(
            select(Job.input_asset_id).where(Job.mode == 'redraw', Job.input_asset_id.is_not(None),
                Job.status.in_(['outcome_unknown', 'unknown_released'])).correlate(None)))).limit(100)))
    for asset in orphan_results:
        asset.deleted_at = now()
    db.flush()
    originals = list(db.scalars(select(Asset.id).outerjoin(Job, Job.input_asset_id == Asset.id).where(
        Asset.kind == 'original', Asset.purged_at.is_(None),
        or_(Asset.deleted_at.is_not(None), Job.status.not_in(ACTIVE),
            and_(Job.id.is_(None), Asset.created_at <= orphan_cutoff))).limit(200)))
    deleted = list(db.scalars(select(Asset).where(Asset.kind != 'original', Asset.deleted_at.is_not(None),
        Asset.purged_at.is_(None)).limit(200)))
    files = [(asset.id, asset.storage_key) for asset in deleted]
    # Revoked assets cannot regain an authorization; no new grant path exists.
    db.commit()
    cleanup_inputs(originals)
    for asset_id, key in files:
        try:
            get_store().delete(key)
        except OSError:
            continue
        asset = db.get(Asset, asset_id)
        asset.purged_at = now()
    db.commit()
    # Keep lease pointers as tombstones, including after unlink: a cancelled
    # request may still finish writing and the next pass must remove that file.
    cutoff = now() - timedelta(seconds=settings().upload_body_timeout_seconds + 60)
    rows = db.execute(select(ExecutionLease.id, ExecutionLease.output_key).join(JobStage, JobStage.id == ExecutionLease.stage_id)
        .join(Job, Job.id == ExecutionLease.job_id).outerjoin(Asset, Asset.id == ExecutionLease.id).where(
            or_(JobStage.name == 'page', and_(JobStage.name == 'redraw', Job.status.in_(['failed', 'cancelled']))),
            ExecutionLease.completed_at.is_not(None), ExecutionLease.completed_at <= cutoff,
            ExecutionLease.output_key.is_not(None), Asset.id.is_(None),
            ExecutionLease.id > _lease_cleanup_cursor if _lease_cleanup_cursor else True)
        .order_by(ExecutionLease.id).limit(100)).all()
    _lease_cleanup_cursor = rows[-1][0] if len(rows) == 100 else None
    abandoned = list(db.scalars(select(UploadReservation.id).join(Job, Job.id == UploadReservation.job_id).where(
        Job.status.not_in(ACTIVE), UploadReservation.asset_id.is_(None), Job.completed_at <= cutoff,
        UploadReservation.id > _upload_cleanup_cursor if _upload_cleanup_cursor else True)
        .order_by(UploadReservation.id).limit(100)))
    _upload_cleanup_cursor = abandoned[-1] if len(abandoned) == 100 else None
    db.commit()
    for key in [row[1] for row in rows] + [asset_storage_key(value, 'original') for value in abandoned]:
        try:
            get_store().delete(key)
        except OSError:
            pass
    # Parts are never results. A generous age bound exceeds every bounded I/O.
    import time as wallclock
    root = settings().storage_path.resolve()
    part_cutoff = wallclock.time() - max(3600, settings().upload_body_timeout_seconds * 2)
    for part in (root / 'staging').glob('*.part'):
        if not part.resolve().is_relative_to(root):
            continue
        try:
            if part.stat().st_mtime < part_cutoff:
                part.unlink(missing_ok=True)
        except OSError:
            pass


def main():
    stopping = Event()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, lambda *_: stopping.set())
    check_runtime()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    from threading import Thread
    from .billing_sync import run as billing_maintenance
    billing_thread = Thread(target=billing_maintenance, args=(stopping,))
    billing_thread.start()
    next_oidc_probe = 0
    next_campaign_scan = 0
    while not stopping.is_set():
        try:
            recover_once()
            with session_factory()() as db:
                cleanup(db)
            if time.monotonic() >= next_oidc_probe:
                probe_oidc()
                next_oidc_probe = time.monotonic() + max(1, min(60, settings().cluster_node_timeout_seconds / 3))
            if time.monotonic() >= next_campaign_scan:
                from .quota_campaigns import backfill_campaigns
                backfill_campaigns()
                next_campaign_scan = time.monotonic() + 10
            report_progress("maintenance")
        except Exception as error:
            report_failure("maintenance", error)
        stopping.wait(settings().dispatch_interval_seconds)
    billing_thread.join()


if __name__ == "__main__":
    main()
