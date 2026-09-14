"""Durable user-fair admission, advisory outbox delivery and conservative recovery."""
from datetime import timedelta
import logging
import time
from sqlalchemy import func, or_, select
from .assets import available, create_asset, inspect_image, object_path
from .errors import ProcessingError
from .config import settings
from .db import initialize, session_factory
from .jobs import cancel_job, settle
from .models import Asset, Attempt, ClassicState, Job, Outbox, now
from .queue_models import QueueAdmission
from .scheduler import admit_jobs, lock_scheduler, release_admission
from .workers import process_job

log = logging.getLogger("node_comics.dispatcher")


def recover(db):
    if db.get_bind().dialect.name == "sqlite":
        lock_scheduler(db)
    for job in db.scalars(select(Job).where(Job.status == "running").with_for_update(skip_locked=True, key_share=True)).all():
        attempt = db.get(Attempt, job.attempt_id)
        if not attempt or attempt.lease_expires_at > now():
            continue
        if attempt.call_started_at:
            saved = object_path(f"{job.owner_id}/{attempt.id}")
            if saved.is_file():
                source = db.get(Asset, job.input_asset_id)
                if job.cancel_requested or job.discard_output or not available(source):
                    saved.unlink(missing_ok=True)
                    job.status, job.phase, job.completed_at = "cancelled", "cancelled", now()
                    settle(db, job, success=False)
                else:
                    try:
                        data = saved.read_bytes()
                        info = inspect_image(data, output=True)
                        ratio = (info["width"] / info["height"]) / (source.width / source.height)
                        if not 0.8 <= ratio <= 1.25:
                            raise ProcessingError("INVALID_PROVIDER_OUTPUT", "已保存结果的宽高比不合格")
                        output = db.get(Asset, attempt.id) or create_asset(db, job.owner_id, data, kind=job.mode, parent_id=source.id, stable_id=attempt.id)
                        job.output_asset_id = output.id
                        job.status, job.phase, job.completed_at = "succeeded", "completed", now()
                        job.error_code, job.error_message = None, None
                        job.quality_flags = ["aspect_ratio_changed"] if abs(ratio - 1) > 0.03 else []
                        settle(db, job, success=True)
                    except ProcessingError as error:
                        job.status, job.phase, job.completed_at = "failed", "failed", now()
                        job.error_code, job.error_message = error.code, error.message
                        settle(db, job, success=False)
                attempt.completed_at, attempt.recovered = now(), True
                continue
            job.status, job.phase, job.unknown_since = "outcome_unknown", "reconciliation", now()
            job.error_code, job.error_message = "UPSTREAM_OUTCOME_UNKNOWN", "工作进程失联，供应商请求结果待核实"
            attempt.error_code, attempt.recovered = "WORKER_LEASE_EXPIRED", True
        elif job.cancel_requested or job.discard_output:
            job.status, job.phase, job.completed_at = "cancelled", "cancelled", now()
            settle(db, job, success=False)
        else:
            job.status, job.phase, job.attempt_id = "queued", "queued", None
            attempt.completed_at, attempt.recovered = now(), True
            release_admission(db, job.id)
    deadline = now() - timedelta(seconds=settings().unknown_release_seconds)
    for job in db.scalars(select(Job).where(Job.status == "outcome_unknown", Job.settlement == "reserved", Job.unknown_since <= deadline).with_for_update(skip_locked=True, key_share=True)).all():
        settle(db, job, success=False)


def cleanup(db):
    expired_parents = select(Asset.id).where(or_(Asset.expires_at <= now(), Asset.deleted_at.is_not(None)))
    for asset in db.scalars(select(Asset).where(Asset.purged_at.is_(None), or_(Asset.expires_at <= now(), Asset.deleted_at.is_not(None), Asset.parent_id.in_(expired_parents))).order_by(Asset.expires_at, Asset.id).limit(200)).all():
        if not asset.deleted_at:
            asset.deleted_at = now()
        for job in db.scalars(select(Job).where(Job.input_asset_id == asset.id, Job.status.in_(["queued", "running", "outcome_unknown"])).with_for_update(key_share=True)).all():
            cancel_job(db, job)
        object_path(asset.storage_key).unlink(missing_ok=True)
        asset.purged_at = now()
    # OCR, translations and masks inherit the original's deletion and expiry.
    for state in db.scalars(select(ClassicState).join(Job, Job.id == ClassicState.job_id).join(Asset, Asset.id == Job.input_asset_id)
                            .where(or_(Asset.expires_at <= now(), Asset.deleted_at.is_not(None)))).all():
        db.delete(state)
    # Ignore young unindexed objects; they may be in the save-before-commit window.
    cutoff = time.time() - 24 * 3600
    root = settings().storage_path
    for path in root.glob("*/*"):
        if path.is_file() and path.stat().st_mtime < cutoff:
            key = path.relative_to(root).as_posix()
            if not db.scalar(select(Asset.id).where(Asset.storage_key == key)):
                path.unlink(missing_ok=True)


def dispatch_once():
    with session_factory()() as db:
        recover(db)
        db.commit()
        cleanup(db)
        db.commit()
    admit_jobs()
    dispatched = 0
    for _ in range(settings().dispatch_max_jobs):
        if not publish_one():
            break
        dispatched += 1
    return dispatched


def publish_one():
    # Admission is ALREADY committed. Crash before/after send can only replay its
    # token; a worker never accepts an unadmitted task or an old recovery token.
    with session_factory()() as db:
        if db.get_bind().dialect.name == "sqlite":
            lock_scheduler(db)
        cutoff = now() - timedelta(seconds=settings().queue_republish_seconds)
        while True:
            admission = db.scalar(select(QueueAdmission).join(Job, Job.id == QueueAdmission.job_id).join(Outbox, Outbox.job_id == Job.id)
                                  .where(Job.status == "queued", Job.cancel_requested.is_(False), Job.discard_output.is_(False),
                                         or_(Outbox.published_at.is_(None), Outbox.published_at <= cutoff))
                                  .order_by(func.coalesce(Outbox.published_at, QueueAdmission.admitted_at), QueueAdmission.sequence)
                                  .limit(1).with_for_update(skip_locked=True, of=QueueAdmission))
            if admission is None:
                return False
            # Under READ COMMITTED, a join can see old Outbox values even though
            # the admission row's lock becomes available after another publisher
            # commits. Re-read under the admission lock using a NEW statement.
            # Lock order matches release_admission: admission -> outbox. Never
            # lock Job here: cancellation/recovery hold Job before admission.
            event = db.scalar(select(Outbox).where(Outbox.job_id == admission.job_id)
                              .with_for_update().execution_options(populate_existing=True))
            if event.published_at is None or event.published_at <= cutoff:
                break
        job = db.get(Job, admission.job_id)
        timeout = job.config["provider"]["timeout_seconds"]
        process_job.apply_async(args=[job.id], kwargs={"admission_token": admission.token}, queue=job.mode, retry=False,
                                soft_time_limit=timeout + 90, time_limit=timeout + 120)
        event.published_at, event.publish_attempts = now(), event.publish_attempts + 1
        db.commit()
        return True


def main():
    initialize()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    while True:
        try:
            dispatch_once()
        except Exception:
            log.warning("Outbox delivery paused; database or broker unavailable. Retrying safely.")
        time.sleep(settings().dispatch_interval_seconds)


if __name__ == "__main__":
    main()
