"""Central whole-document text executor; image files remain on the assigned host."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
import logging
import os
import signal
import socket
from threading import Event, Thread
import time
from sqlalchemy import select
# Standalone workers must register quota FKs before their first ORM flush.
from .. import billing_models, entitlement_models  # noqa: F401
from ..config import settings
from ..db import session_factory
from ..errors import ProcessingError
from ..health import log_failure, report_failure, report_progress
from ..models import Job, now
from ..queue_models import ExecutionLease
from ..scheduler import heartbeat_lease, lock_scheduler, touch_job
from .config import get_document_settings
from .models import Document
from .storage import DocumentStoreError, get_document_store
from .workflow import (TERMINAL, claim_control, complete_control, current,
                       expire_offline_workspaces, fail_lease, finish_failed)


@dataclass
class MaintenanceState:
    """Process-local bounded scan cursors; restart safely begins another cycle."""
    unknown_after: str | None = None


@contextmanager
def lease_guard(lease):
    stopping, lost = Event(), Event()

    def heartbeat():
        while not stopping.wait(min(5, max(1, settings().cluster_lease_seconds // 3))):
            try:
                with session_factory()() as db:
                    heartbeat_lease(db, lease.id, lease.token)
                    db.commit()
            except Exception as error:
                log_failure('document-heartbeat', error, lease_id=lease.id)
                lost.set()
                return

    def check():
        if lost.is_set():
            raise ProcessingError('WORKER_LEASE_EXPIRED', '文件任务租约失效，停止本次执行')

    thread = Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        yield check
    finally:
        stopping.set()
        thread.join(timeout=10)


def execute(lease):
    try:
        with lease_guard(lease) as check:
            with session_factory()() as db:
                _, stage, _ = current(db, lease.id, lease.token)
                name = stage.name
            if name == 'doc_text':
                from .text import run_text_stage
                result = run_text_stage(lease.job_id, lease.id, check)
            else:
                raise ProcessingError('DOCUMENT_STAGE_INVALID', '不支持的文件阶段')
            check()
            complete_control(lease.id, result)
    except Exception as error:
        log_failure('document-worker', error, job_id=lease.job_id, lease_id=lease.id)
        if not isinstance(error, ProcessingError):
            error = ProcessingError(getattr(error, 'code', 'DOCUMENT_WORKER_FAILED'), '文件处理失败，请根据错误代码检查后重试')
        fail_lease(lease.id, error, token=lease.token)


def maintain(state=None):
    """Bounded state-driven expiry/cleanup, not age-based deletion of live work."""
    from .text import reconcile_saved_response
    state = state or MaintenanceState()
    expire_offline_workspaces()
    store = get_document_store()
    with session_factory()() as db:
        ids = list(db.scalars(select(Job.id).join(Document, Document.job_id == Job.id).where(
            Job.workflow_kind == 'document', Document.reserved_at.is_(None),
            Job.status.not_in(TERMINAL), Document.expires_at <= now()).limit(50)))
        unknown_query = select(Job.id).where(Job.workflow_kind == 'document', Job.status == 'outcome_unknown')
        unknown = list(db.scalars(unknown_query.where(Job.id > state.unknown_after)
            .order_by(Job.id).limit(20))) if state.unknown_after else list(db.scalars(unknown_query.order_by(Job.id).limit(20)))
        if not unknown and state.unknown_after:
            unknown = list(db.scalars(unknown_query.order_by(Job.id).limit(20)))
        state.unknown_after = unknown[-1] if unknown else None
    for job_id in ids:
        with session_factory()() as db:
            lock_scheduler(db)
            doc, job = db.get(Document, job_id), db.get(Job, job_id)
            if not doc.reserved_at and job.status not in TERMINAL and doc.expires_at <= now():
                finish_failed(db, job, ProcessingError('DOCUMENT_UPLOAD_EXPIRED', '上传或等待补充额度已过期'))
                touch_job(db, job)
                db.commit()
    for job_id in unknown:
        try:
            reconcile_saved_response(job_id)
        except (DocumentStoreError, ProcessingError) as error:
            log_failure('document-reconcile', error, job_id=job_id)
    with session_factory()() as db:
        terminal = list(db.execute(select(Document, Job.status).join(Job, Job.id == Document.job_id).where(
            Job.status.in_(TERMINAL), Document.cleanup_after.is_not(None), Document.cleanup_after <= now(),
            ~select(ExecutionLease.id).where(ExecutionLease.job_id == Job.id,
                ExecutionLease.completed_at.is_(None)).exists()).order_by(Document.cleanup_after).limit(20)))
        expired = list(db.scalars(select(Document).join(Job, Job.id == Document.job_id).where(
            Job.status == 'succeeded', Document.output_ref.is_not(None), Document.expires_at <= now()).limit(20)))
    for document, status in terminal:
        try:
            if document.upload_id:
                store.abort_multipart(document.source_key, document.upload_id)
            more = False
            # v2 creates no work objects. Reclaim any old terminal v1 namespace
            # once too; clearing cleanup_after prevents recurring legacy scans.
            for category in ('input', 'work', *(('output',) if status != 'succeeded' else ())):
                more |= store.delete_prefix(f'{store.config.r2_key_prefix}/{category}/{document.job_id}')['more']
            if not more:
                with session_factory()() as db:
                    db.get(Document, document.job_id).cleanup_after = None
                    db.commit()
        except DocumentStoreError as error:
            log_failure('document-cleanup', error, job_id=document.job_id)
    for document in expired:
        try:
            more = store.delete_prefix(f'{store.config.r2_key_prefix}/output/{document.job_id}')['more']
            if not more:
                with session_factory()() as db:
                    db.get(Document, document.job_id).output_ref = None
                    db.commit()
        except DocumentStoreError as error:
            log_failure('document-cleanup', error, job_id=document.job_id)
    return state


def main():
    from ..runtime import check_database, check_redis
    cfg = get_document_settings()
    if not cfg.enabled:
        raise RuntimeError('Document worker requires DOCUMENT_ENABLED=true')
    check_database()
    check_redis()
    stopping = Event()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, lambda *_: stopping.set())
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    executor_id = f'{socket.gethostname()}:{os.getpid()}'
    pending, next_maintenance, maintenance = set(), 0, MaintenanceState()
    with ThreadPoolExecutor(max_workers=cfg.worker_slots, thread_name_prefix='document') as pool:
        while not stopping.is_set():
            try:
                for future in list(pending):
                    if future.done():
                        pending.remove(future)
                        future.result()
                while len(pending) < cfg.worker_slots:
                    with session_factory()() as db:
                        lease = claim_control(db, executor_id)
                        db.commit()
                    if not lease:
                        break
                    pending.add(pool.submit(execute, lease))
                if time.monotonic() >= next_maintenance:
                    maintain(maintenance)
                    next_maintenance = time.monotonic() + 60
                report_progress('document-worker')
            except Exception as error:
                report_failure('document-worker', error)
            stopping.wait(cfg.worker_poll_seconds)


if __name__ == '__main__':
    main()
