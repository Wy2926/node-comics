"""Fenced stage completion and bounded control-side upload/text executors."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from fastapi import HTTPException
import hmac
import logging
import os
import signal
import socket
from threading import Event, Thread
import time
from sqlalchemy import select
from .classic import run_text_stage
from .config import settings
from .db import session_factory
from .runtime import check_runtime
from .errors import ProcessingError, problem
from .health import log_failure, report_failure, report_progress
from .jobs import settle
from .models import Attempt, Job, now
from .providers import digest
from .queue_models import ExecutionLease, JobStage
from .scheduler import (claim_batch, current_lease, has_claimable_work, heartbeat_lease, lock_scheduler,
                        next_control_delay, release_lease, touch_job)
from .storage import StorageError


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
        name = stage.name
        stage.status, stage.completed_at = "succeeded", now()
        lease.result_hash = result_hash
        release_lease(db, lease, "succeeded")
        if name == "text" and job.status == "running":
            job.phase = "render"
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
        retryable = stage.name in {"page", "validate_upload", "text"} and error.code in {
            "CLASSIC_ENGINE_UNAVAILABLE", "CLASSIC_ANALYZE_FAILED", "CLASSIC_INPAINT_FAILED", "CLASSIC_RENDER_FAILED",
            "STORAGE_UNAVAILABLE", "WORKER_LEASE_EXPIRED", "CLASSIC_LOCAL_INTERRUPTED", "ENGINE_UNAVAILABLE"}
        if job.cancel_requested or job.discard_output:
            finish_job(db, job, "cancelled")
            stage.status = "cancelled"
        elif stage.name == 'text' and error.code in {'TEXT_PROVIDER_DISABLED', 'TEXT_RATE_LIMITED', 'ADMISSION_UNAVAILABLE'}:
            # Pauses and rate waits release the shared execution slot without
            # consuming a stage attempt. Per-call limits remain durable.
            delay = min(3600, max(0, getattr(error, 'retry_after', 0)))
            stage.status, stage.available_at = 'ready', now() + timedelta(seconds=delay)
            stage.attempts = max(0, stage.attempts - 1)
            job.phase = 'text'
        elif retryable and stage.attempts < (lease.limits.get('max_attempts', settings().cluster_stage_attempts)
                                            if stage.name == 'page' else settings().cluster_stage_attempts):
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
        except Exception as error:
            log_failure("lease-heartbeat", error, lease_id=lease_id)
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
            with session_factory()() as db:
                reservation = db.scalar(select(UploadReservation).where(UploadReservation.job_id == job_id))
                complete_upload(db, reservation, reservation.owner_id, lease_id=lease_id, lease_token=token)
                lease = db.get(ExecutionLease, lease_id)
                stage = db.get(JobStage, lease.stage_id)
                job = db.get(Job, job_id)
                stage.status, stage.completed_at = ("succeeded" if job.input_asset_id else "failed"), now()
                release_lease(db, lease, stage.status)
                touch_job(db, job)
                db.commit()
        elif name == "text":
            result = run_text_stage(job_id, lease_id)
            complete_stage(lease_id, result or {}, token=token)
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
            fail_stage(lease_id, error, token=token)
    except Exception as error:
        log_failure("control-stage", error, job_id=job_id, stage=name, lease_id=lease_id)
        fail_stage(lease_id, ProcessingError("CLASSIC_LOCAL_INTERRUPTED",
            "执行中断，已保存检查点供恢复"), token=token)
    finally:
        stopped.set()
        thread.join(timeout=1)


class ControlDispatcher:
    """Round-robin bounded batches, with no leased work behind an executor queue."""

    def __init__(self, executor, executor_id, pool_limits, wake):
        self.executor, self.executor_id, self.wake = executor, executor_id, wake
        self.pools = tuple(pool_limits)
        self.maximum = sum(pool_limits.values())
        self.cursor = 0
        self.futures = {}

    def reap(self):
        completed = {future: lease_id for future, lease_id in self.futures.items() if future.done()}
        for future, lease_id in completed.items():
            del self.futures[future]
            try:
                future.result()
            except Exception as error:
                log_failure("control-stage-future", error, lease_id=lease_id)

    def dispatch(self, stopping):
        admitted = 0
        order = self.pools[self.cursor:] + self.pools[:self.cursor]
        self.cursor = (self.cursor + 1) % len(self.pools)
        for name in order:
            free = self.maximum - len(self.futures)
            if stopping.is_set() or free <= 0:
                break
            with session_factory()() as db:
                leases = claim_batch(db, 'control-' + name, [name], limit=min(4, free), executor_id=self.executor_id)
                db.commit()
            for lease in leases:
                future = self.executor.submit(run_control_stage, lease.id)
                self.futures[future] = lease.id
                future.add_done_callback(lambda _: self.wake.set())
            admitted += len(leases)
        return admitted

    def idle_delay(self, maximum):
        with session_factory()() as db:
            # A retry deadline may cross, or a prepared head may be consumed,
            # between this round's election and waiting. Reconcile once before
            # sleeping; local and durable capacity must both permit dispatch.
            if len(self.futures) < self.maximum and any(has_claimable_work(db, 'control-' + name, [name])
                    for name in self.pools):
                return 0
            return next_control_delay(db, maximum)


def main():
    stopping, wake = Event(), Event()
    def stop(*_):
        stopping.set()
        wake.set()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, stop)
    check_runtime()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    from .control_pools import POOL_LIMITS, report_pools
    from .notifications import close_hub, hub
    executor_id = f"{socket.gethostname()}:{os.getpid()}"[:160]
    notices = hub()
    notices.start()
    next_heartbeat = 0
    try:
        # Threads start lazily; live capacity remains cluster-wide in the DB.
        with notices.subscribe_thread('compute', wake), ThreadPoolExecutor(
                max_workers=sum(POOL_LIMITS.values()), thread_name_prefix='translation') as executor:
            dispatch = ControlDispatcher(executor, executor_id, POOL_LIMITS, wake)
            while not stopping.is_set():
                wake.clear()  # Subscribe/clear before rereading state: no lost wakeup.
                try:
                    dispatch.reap()
                    admitted = dispatch.dispatch(stopping)
                    if time.monotonic() >= next_heartbeat:
                        with session_factory()() as db:
                            report_pools(db)
                        report_progress('control-worker')
                        next_heartbeat = time.monotonic() + 5
                    if admitted:
                        continue  # Free slots and queued work get the next fair round immediately.
                    delay = dispatch.idle_delay(max(0, next_heartbeat - time.monotonic()))
                    wake.wait(delay)
                except Exception as error:
                    report_failure('control-worker', error)
                    stopping.wait(1)
            # The executor drains accepted stages before PID 1 exits.
    finally:
        close_hub()


if __name__ == "__main__":
    main()
