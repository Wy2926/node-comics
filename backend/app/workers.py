"""Fenced stage completion and bounded control-side upload/text/redraw executors."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from fastapi import HTTPException
import hmac
import re
from threading import Event, Thread
import time
from sqlalchemy import select
from .adapters.images import redraw
from .assets import available, create_asset, inspect_image, read_asset
from .classic import run_text_stage, validate_analysis, validate_render
from .config import settings
from .db import initialize, session_factory
from .errors import ProcessingError, problem
from .jobs import settle
from .models import Asset, Attempt, ClassicState, Job, Provider, now
from .providers import digest
from .queue_models import ComputeNode, ExecutionLease, JobStage
from .scheduler import claim_stage, current_lease, heartbeat_lease, lock_scheduler, release_lease, touch_job
from .storage import StorageError, get_store


def _scoped(lease, token, node_id):
    if not lease or (token is not None and not hmac.compare_digest(lease.token, token)) or (node_id is not None and lease.node_id != node_id):
        problem("NODE_SCOPE_MISMATCH", "执行授权与节点不匹配", 403)


def _finished(db, lease_id, token, node_id, result_hash=None):
    lease = db.get(ExecutionLease, lease_id)
    _scoped(lease, token, node_id)
    if lease.completed_at:
        if result_hash is not None and lease.outcome == "succeeded" and lease.result_hash == result_hash:
            return True
        if lease.outcome in {"failed", "cancelled"} and result_hash is None:
            return True
        raise ProcessingError("LEASE_EXPIRED", "此执行代次已结束，不能提交其他结果")
    return False


def finish_job(db, job, status, *, error=None):
    job.status, job.phase, job.completed_at = status, "completed" if status in {"succeeded", "no_text"} else status, now()
    job.error_code, job.error_message = (error.code, error.message) if error else (None, None)
    for stage in db.scalars(select(JobStage).where(JobStage.job_id == job.id, JobStage.status.in_(["waiting", "ready"]))):
        stage.status = "cancelled"
    if job.attempt_id:
        db.get(Attempt, job.attempt_id).completed_at = now()
    settle(db, job, success=status == "succeeded" and "unrecognized_regions" not in (job.quality_flags or []))


def complete_stage(lease_id, result, *, token=None, node_id=None):
    result_hash = digest(result)
    with session_factory()() as db:
        lock_scheduler(db)
        if _finished(db, lease_id, token, node_id, result_hash):
            return
        lease, stage, job = current_lease(db, lease_id, token)
        # Freeze the accepted payload before any output PUT. Concurrent retries
        # with the same bytes are safe; a conflicting reply must never overwrite
        # the object that a previous completion has already delivered.
        if lease.result_hash is not None and lease.result_hash != result_hash:
            raise ProcessingError("COMPLETION_CONFLICT", "此执行代次已经接收了另一份阶段结果")
        lease.result_hash = result_hash
        name, owner_id, input_id, attempt_id, mode = stage.name, job.owner_id, job.input_asset_id, job.attempt_id, job.mode
        source = db.get(Asset, input_id) if input_id else None
        config = job.config
        backend = db.get(Attempt, attempt_id).output_storage_backend
        db.commit()
    # Image decoding, object reads and PUTs hold neither row nor scheduler locks.
    if name in {"analyze", "inpaint", "render"}:
        if result.get("input_hash") != source.sha256 or result.get("version") != config["engine"]["version"]:
            raise ProcessingError("ENGINE_RESULT_MISMATCH", "图像结果与输入或引擎版本不一致")
    image, info = None, None
    if name == "analyze":
        validate_analysis(result, source.width, source.height)
    elif name == "inpaint":
        if not isinstance(result.get("cache_key"), str) or not re.fullmatch(r"[a-f0-9]{64}", result["cache_key"]):
            raise ProcessingError("INVALID_ENGINE_RESULT", "抹字缓存标识无效")
    elif name == "render":
        image = validate_render(read_asset(source), result)
    elif name == "redraw":
        image = base64.b64decode(result["image"], validate=True)
    if image is not None:
        info = inspect_image(image, output=True)
        ratio = (info["width"] / info["height"]) / (source.width / source.height)
        if (mode == "classic" and (info["width"], info["height"]) != (source.width, source.height)) or not .8 <= ratio <= 1.25:
            raise ProcessingError("INVALID_PROVIDER_OUTPUT", "结果尺寸或宽高比不符合原图")
        # Each generation has its own output key; late uploads cannot overwrite
        # the object selected by a replacement lease.
        get_store(backend).put(f"{owner_id}/{lease_id}", image, info["mime"], kind=mode)
    with session_factory()() as db:
        lock_scheduler(db)
        if _finished(db, lease_id, token, node_id, result_hash):
            return
        lease, stage, job = current_lease(db, lease_id, token)
        state = db.get(ClassicState, job.id) if mode == "classic" else None
        if name == "analyze":
            state.analysis, state.timings = result, result.get("timings", {})
            if not result["segments"]:
                finish_job(db, job, "no_text")
            else:
                for nxt in db.scalars(select(JobStage).where(JobStage.job_id == job.id, JobStage.name.in_(["text", "inpaint"]))):
                    nxt.status = "ready"
        elif name == "inpaint":
            state.artifacts = {"cache_key": result["cache_key"], "node_id": lease.node_id}
            state.timings = {**state.timings, **result.get("timings", {})}
        elif name in {"render", "redraw"}:
            if not available(db.get(Asset, input_id)):
                raise ProcessingError("ASSET_EXPIRED", "输入原图已失效")
            output = db.get(Asset, lease_id) or create_asset(db, owner_id, image, kind=mode, parent_id=input_id,
                stable_id=lease_id, storage_backend=backend, prewritten=True, verified_info=info)
            job.output_asset_id = output.id
            job.quality_flags = (state.analysis or {}).get("quality_flags", []) if state else result.get("quality_flags", [])
            if abs(ratio - 1) > .03:
                job.quality_flags = [*job.quality_flags, "aspect_ratio_changed"]
            if state:
                state.timings = {**state.timings, **result.get("timings", {})}
            finish_job(db, job, "succeeded")
            if name == "redraw":
                provider = db.get(Provider, job.config["provider"]["id"])
                if provider and provider.config == job.config["provider"]:
                    provider.validated_at, provider.validation_job_id = now(), job.id
        stage.status, stage.completed_at = "succeeded", now()
        lease.result_hash = result_hash
        release_lease(db, lease, "succeeded")
        if name in {"text", "inpaint"} and job.status == "running":
            statuses = {s.name: s.status for s in db.scalars(select(JobStage).where(JobStage.job_id == job.id))}
            if statuses.get("text") == statuses.get("inpaint") == "succeeded":
                db.scalar(select(JobStage).where(JobStage.job_id == job.id, JobStage.name == "render")).status = "ready"
                job.phase = "render"
            else:
                job.phase = "text" if statuses.get("text") != "succeeded" else "inpaint"
        touch_job(db, job)
        db.commit()


def fail_stage(lease_id, error, *, token=None, node_id=None, recovering=False):
    with session_factory()() as db:
        lock_scheduler(db)
        if _finished(db, lease_id, token, node_id):
            return
        lease = db.get(ExecutionLease, lease_id)
        stage, job = db.get(JobStage, lease.stage_id), db.get(Job, lease.job_id)
        if recovering and lease.expires_at > now():
            return  # A heartbeat committed after maintenance's initial snapshot.
        if stage.generation != lease.generation:
            raise ProcessingError("LEASE_EXPIRED", "执行代次已更新")
        if job.status not in {"running", "outcome_unknown"}:
            stage.status = "cancelled"
            release_lease(db, lease, "cancelled")
            db.commit()
            return
        if not recovering and not job.cancel_requested and not job.discard_output:
            current_lease(db, lease_id, token)
        attempt = db.get(Attempt, job.attempt_id)
        if recovering and stage.name == "redraw" and attempt.call_started_at is not None:
            # Re-read the call intent under the scheduler lock; a maintenance
            # snapshot taken before its commit cannot authorize another request.
            error = ProcessingError("UPSTREAM_OUTCOME_UNKNOWN", "图片调用已开始，等待核实供应商结果", unknown=True)
        retryable = stage.name in {"analyze", "inpaint", "render", "validate_upload", "text"} and error.code in {
            "CLASSIC_ENGINE_UNAVAILABLE", "CLASSIC_ANALYZE_FAILED", "CLASSIC_INPAINT_FAILED", "CLASSIC_RENDER_FAILED",
            "STORAGE_UNAVAILABLE", "WORKER_LEASE_EXPIRED", "CLASSIC_LOCAL_INTERRUPTED", "ENGINE_UNAVAILABLE"}
        if stage.name == "redraw" and attempt.call_started_at is None:
            retryable = error.code in {"STORAGE_UNAVAILABLE", "WORKER_LEASE_EXPIRED", "CLASSIC_LOCAL_INTERRUPTED"}
        if job.cancel_requested or job.discard_output:
            finish_job(db, job, "cancelled")
            stage.status = "cancelled"
        elif error.unknown and stage.name == "redraw":
            job.status, job.phase, job.unknown_since = "outcome_unknown", "reconciliation", now()
            job.error_code, job.error_message = error.code, error.message
            stage.status = "unknown"
        elif retryable and stage.attempts < settings().cluster_stage_attempts:
            stage.status, stage.available_at = "ready", now() + timedelta(seconds=min(30, stage.attempts * 2))
            job.phase = "recovering_" + stage.name
        else:
            finish_job(db, job, "failed", error=error)
            stage.status = "failed"
        release_lease(db, lease, "cancelled" if job.cancel_requested else "failed")
        touch_job(db, job)
        db.commit()


def _heartbeat(lease_id, token, stopped):
    while not stopped.wait(max(1, settings().cluster_lease_seconds // 3)):
        try:
            with session_factory()() as db:
                heartbeat_lease(db, lease_id, token)
                db.commit()
        except Exception:
            return


def finish_stopped_lease(lease_id, token=None, node_id=None):
    """A returned call no longer consumes a slot after user/sibling termination.

    This is intentionally separate from normal completion: current_lease rejects
    cancelled jobs, but only the still-matching generation may clear its slot.
    """
    with session_factory()() as db:
        lock_scheduler(db)
        lease = db.get(ExecutionLease, lease_id)
        _scoped(lease, token, node_id)
        if lease.completed_at:
            return
        stage, job = db.get(JobStage, lease.stage_id), db.get(Job, lease.job_id)
        if stage.generation != lease.generation:
            return
        if not job.cancel_requested and not job.discard_output and job.status in {"running", "outcome_unknown"}:
            return
        if job.status in {"running", "outcome_unknown"}:
            finish_job(db, job, "cancelled")
        stage.status = "cancelled"
        release_lease(db, lease, "cancelled")
        touch_job(db, job)
        db.commit()


def run_control_stage(lease_id):
    with session_factory()() as db:
        lease, stage, job = current_lease(db, lease_id)
        name, token, job_id = stage.name, lease.token, job.id
    stopped = Event()
    thread = Thread(target=_heartbeat, args=(lease_id, token, stopped), daemon=True)
    thread.start()
    try:
        if name == "validate_upload":
            from .upload_models import UploadReservation
            from .uploads import complete_upload
            from .submission_api import bind_file_page
            with session_factory()() as db:
                reservation = db.scalar(select(UploadReservation).where(UploadReservation.job_id == job_id))
                complete_upload(db, reservation, reservation.owner_id, lease_id=lease_id, lease_token=token)
                lease = db.get(ExecutionLease, lease_id)
                stage = db.get(JobStage, lease.stage_id)
                job = db.get(Job, job_id)
                if job.input_asset_id:
                    bind_file_page(db, job)
                stage.status, stage.completed_at = ("succeeded" if job.input_asset_id else "failed"), now()
                release_lease(db, lease, stage.status)
                touch_job(db, job)
                db.commit()
        elif name == "text":
            result = run_text_stage(job_id, lease_id)
            complete_stage(lease_id, result or {}, token=token)
        elif name == "redraw":
            with session_factory()() as db:
                _, _, job = current_lease(db, lease_id, token)
                source = db.get(Asset, job.input_asset_id)
                data, mime, config, language, attempt_id = read_asset(source), source.mime, job.config, job.target_language, job.attempt_id
            with session_factory()() as db:
                lock_scheduler(db)
                current_lease(db, lease_id, token)
                attempt = db.get(Attempt, attempt_id)
                if attempt.call_started_at:
                    raise ProcessingError("UPSTREAM_OUTCOME_UNKNOWN", "此调用已开始，不能自动重发", unknown=True)
                attempt.call_started_at = now()
                db.commit()
            result = redraw(data, mime, language, config)
            with session_factory()() as db:
                lock_scheduler(db)
                attempt = db.get(Attempt, attempt_id)
                attempt.request_id, attempt.usage = result.request_id, result.usage
                attempt.cost_state = "reported" if result.usage is not None else "unknown"
                db.commit()
            complete_stage(lease_id, {"image": base64.b64encode(result.image).decode(), "quality_flags": result.quality_flags or []}, token=token)
    except HTTPException as error:
        detail = error.detail if isinstance(error.detail, dict) else {}
        code = detail.get("code", "STAGE_REQUEST_REJECTED")
        message = detail.get("message", "阶段请求不符合任务约束")
        fail_stage(lease_id, ProcessingError(code, message), token=token)
    except StorageError:
        # Keep a possibly uploaded output for maintenance reconciliation.
        with session_factory()() as db:
            lock_scheduler(db)
            lease = db.get(ExecutionLease, lease_id)
            if lease and not lease.completed_at:
                lease.expires_at = now()
                db.commit()
    except ProcessingError as error:
        if error.code == "LEASE_EXPIRED":
            finish_stopped_lease(lease_id, token)
        elif error.code != "COMPLETION_CONFLICT":
            if name == "redraw":
                with session_factory()() as db:
                    lock_scheduler(db)
                    job = db.get(Job, job_id)
                    attempt = db.get(Attempt, job.attempt_id)
                    if error.usage is not None:
                        attempt.usage, attempt.cost_state = error.usage, "reported"
                    attempt.request_id, attempt.error_code = error.request_id, error.code
                    db.commit()
            fail_stage(lease_id, error, token=token)
    except Exception:
        unknown = False
        if name == "redraw":
            with session_factory()() as db:
                attempt = db.get(Attempt, db.get(Job, job_id).attempt_id)
                unknown = attempt.call_started_at is not None
        fail_stage(lease_id, ProcessingError("UPSTREAM_OUTCOME_UNKNOWN" if unknown else "CLASSIC_LOCAL_INTERRUPTED",
            "执行中断，已保存检查点供恢复", unknown=unknown), token=token)
    finally:
        stopped.set()
        thread.join(timeout=1)


def main():
    initialize()
    cfg = settings()
    pools = {"text": cfg.cluster_text_slots, "redraw": cfg.cluster_redraw_slots, "validate_upload": cfg.cluster_upload_slots}
    with session_factory()() as db:
        lock_scheduler(db)
        for name, capacity in pools.items():
            node_id = "control-" + name
            node = db.get(ComputeNode, node_id)
            if not node:
                db.add(ComputeNode(id=node_id, name=node_id, resource_id=node_id, capabilities=[name], capacity=capacity,
                    engine_version="control", device="network", enabled=True))
            else:
                node.capacity, node.enabled = capacity, True
        db.commit()
    with ThreadPoolExecutor(max_workers=sum(pools.values()), thread_name_prefix="translation") as executor:
        futures = set()
        while True:
            futures = {future for future in futures if not future.done()}
            for name in pools:
                if len(futures) >= sum(pools.values()):
                    break
                with session_factory()() as db:
                    lease = claim_stage(db, "control-" + name, [name])
                    db.commit()
                if lease:
                    futures.add(executor.submit(run_control_stage, lease.id))
            time.sleep(.25)


if __name__ == "__main__":
    main()
