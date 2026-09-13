"""Durable job execution. A committed call intent forbids automatic paid-call replay."""
from datetime import timedelta
from threading import Event, Thread
from celery import Celery
from sqlalchemy import func, select, update
from .adapters.images import redraw
from .assets import available, create_asset, inspect_image, object_path
from .config import settings
from .db import session_factory
from .errors import ProcessingError
from .jobs import settle
from .models import Asset, Attempt, Job, Provider, now, uid

celery_app = Celery("node_comics", broker=settings().redis_url)
celery_app.conf.update(task_serializer="json", accept_content=["json"], result_serializer="json", task_ignore_result=True,
                       task_acks_late=True, task_reject_on_worker_lost=True, worker_prefetch_multiplier=1,
                       broker_connection_retry_on_startup=True, broker_transport_options={"visibility_timeout": 7200},
                       task_routes={"app.workers.process_job": {"queue": "redraw"}})


def lease_duration(job):
    seconds = job.config.get("provider", job.config).get("timeout_seconds", 900)
    return timedelta(seconds=seconds + 180)


def heartbeat(job_id, attempt_id, stopped):
    while not stopped.wait(20):
        try:
            with session_factory()() as db:
                job = db.get(Job, job_id)
                if not job or job.attempt_id != attempt_id or job.status != "running":
                    return
                db.execute(update(Attempt).where(Attempt.id == attempt_id).values(heartbeat_at=now(), lease_expires_at=now() + lease_duration(job)))
                db.commit()
        except Exception:
            # The committed intent and lease recovery retain the unknown state if DB is unavailable.
            continue


def claim(job_id):
    with session_factory()() as db:
        job = db.get(Job, job_id)
        if not job or job.status != "queued":
            return None
        provider_id = job.config["provider"]["id"]
        if job.mode == "redraw":
            provider = db.scalar(select(Provider).where(Provider.id == provider_id).with_for_update())
            if not provider or not provider.enabled:
                job = db.scalar(select(Job).where(Job.id == job_id).with_for_update().execution_options(populate_existing=True))
                if job.status == "queued":
                    job.status, job.phase, job.completed_at = "failed", "failed", now()
                    job.error_code, job.error_message = "PROVIDER_DISABLED", "管理员已停用此图片编辑服务，请重新选择服务"
                    settle(db, job, success=False)
                    db.commit()
                return None
            running = db.scalar(select(func.count()).select_from(Attempt).join(Job, Job.attempt_id == Attempt.id).where(Attempt.provider_id == provider_id, Job.status == "running"))
            if running >= job.config["provider"]["concurrency"]:
                return None
        attempt_id = uid()
        updated = db.execute(update(Job).where(Job.id == job_id, Job.status == "queued").values(status="running", phase="preprocessing", attempt_id=attempt_id))
        if updated.rowcount != 1:
            db.rollback()
            return None
        db.add(Attempt(id=attempt_id, job_id=job_id, provider_id=provider_id, lease_expires_at=now() + lease_duration(job)))
        db.commit()
        return attempt_id


def finish_error(job_id, attempt_id, error):
    with session_factory()() as db:
        job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
        attempt = db.get(Attempt, attempt_id)
        if not job or job.attempt_id != attempt_id or job.status not in ("running", "outcome_unknown"):
            return
        job.error_code, job.error_message = error.code, error.message
        attempt.error_code, attempt.request_id, attempt.completed_at = error.code, error.request_id, now()
        if error.usage is not None:
            attempt.usage, attempt.cost_state = error.usage, "reported"
        if error.unknown:
            job.status, job.phase, job.unknown_since = "outcome_unknown", "reconciliation", now()
        else:
            job.status = "cancelled" if job.cancel_requested or job.discard_output else "failed"
            job.phase, job.completed_at = job.status, now()
            settle(db, job, success=False)
        db.commit()


@celery_app.task(name="app.workers.process_job", acks_late=True)
def process_job(job_id: str):
    attempt_id = claim(job_id)
    if not attempt_id:
        return
    stopped = Event()
    thread = Thread(target=heartbeat, args=(job_id, attempt_id, stopped), daemon=True)
    thread.start()
    try:
        with session_factory()() as db:
            job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
            attempt = db.get(Attempt, attempt_id)
            if job.attempt_id != attempt_id or job.status != "running" or not attempt or attempt.lease_expires_at <= now():
                return
            asset = db.get(Asset, job.input_asset_id)
            if not available(asset) or job.discard_output or job.cancel_requested:
                raise ProcessingError("ASSET_EXPIRED", "原图已删除、过期或任务已取消")
            data = object_path(asset.storage_key).read_bytes()
            mime, language, config, mode = asset.mime, job.target_language, job.config, job.mode
            attempt.call_started_at = now()
            job.phase = "calling_image_model"
            db.commit()  # Write-ahead intent: after this point a crash means unknown, never replay.
        result = redraw(data, mime, language, config)
        # Preserve provider consumption before output validation, storage or settlement can fail.
        with session_factory()() as db:
            attempt = db.get(Attempt, attempt_id)
            attempt.request_id, attempt.usage = result.request_id, result.usage
            attempt.cost_state = "reported" if result.usage is not None else "unknown"
            db.commit()
        with session_factory()() as db:
            job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
            attempt = db.get(Attempt, attempt_id)
            if job.attempt_id != attempt_id or job.status not in ("running", "outcome_unknown"):
                return
            attempt.request_id, attempt.usage = result.request_id, result.usage
            attempt.cost_state = "reported" if result.usage is not None else "unknown"
            attempt.completed_at = now()
            asset = db.get(Asset, job.input_asset_id)
            if job.discard_output or job.cancel_requested or not available(asset):
                job.status, job.phase, job.completed_at = "cancelled", "cancelled", now()
                settle(db, job, success=False)
            elif result.no_text:
                job.status, job.phase, job.completed_at = "no_text", "completed", now()
                settle(db, job, success=False)
            else:
                job.phase = "validating"
                info = inspect_image(result.image, output=True)
                ratio_change = (info["width"] / info["height"]) / (asset.width / asset.height)
                if ratio_change < 0.8 or ratio_change > 1.25:
                    raise ProcessingError("INVALID_PROVIDER_OUTPUT", "结果宽高比偏离原图过多，未交付且不扣用户额度", request_id=result.request_id)
                output = create_asset(db, job.owner_id, result.image, kind=job.mode, parent_id=asset.id, stable_id=attempt_id)
                job.output_asset_id = output.id
                job.quality_flags = ["aspect_ratio_changed"] if abs(ratio_change - 1) > 0.03 else []
                job.status, job.phase, job.completed_at = "succeeded", "completed", now()
                job.error_code, job.error_message = None, None
                settle(db, job, success=True)
                if mode == "redraw":
                    provider = db.get(Provider, config["provider"]["id"])
                    if provider and provider.config == config["provider"]:
                        provider.validated_at, provider.validation_job_id = now(), job.id
            db.commit()
    except ProcessingError as error:
        finish_error(job_id, attempt_id, error)
    except Exception:
        # No exception body is logged: it may contain provider URLs, OCR text or credentials.
        finish_error(job_id, attempt_id, ProcessingError("UPSTREAM_OUTCOME_UNKNOWN", "任务执行中断，结果待核实；不会自动重复请求", unknown=True))
    finally:
        stopped.set()
        thread.join(timeout=1)
