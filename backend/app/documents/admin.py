"""Explicit operator reconciliation, never an automatic full-document resubmit."""
from uuid import UUID
from fastapi import APIRouter, Depends
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..admin_audit import record_audit
from ..auth import admin
from ..db import get_db
from ..errors import ProcessingError, problem
from ..models import Job, TextCall, User, now
from ..queue_models import ExecutionLease
from ..request_models import RequestBody
from ..scheduler import lock_scheduler, touch_job
from .models import Document
from .workflow import finish_failed

router = APIRouter(prefix='/v1/admin/documents', tags=['documents-admin'])


class ResolveUnknown(RequestBody):
    call_id: UUID
    confirmed_no_deliverable_result: bool
    note: str = Field(min_length=10, max_length=500)
    accounted_micros: int | None = Field(default=None, ge=0, le=10**13, strict=True)


@router.post('/{job_id}/resolve-unknown')
def resolve_unknown(job_id: UUID, body: ResolveUnknown, actor: User = Depends(admin), db: Session = Depends(get_db)):
    lock_scheduler(db)
    job, document = db.get(Job, str(job_id)), db.get(Document, str(job_id))
    if not document or not job or job.workflow_kind != 'document':
        problem('NOT_FOUND', '找不到文件任务', 404)
    call = db.get(TextCall, str(body.call_id))
    if not call or call.id != document.text_call_id or call.job_id != job.id:
        problem('DOCUMENT_CALL_MISMATCH', '核实记录不属于此文件调用', 409)
    if job.status == 'failed' and job.error_code == 'DOCUMENT_TEXT_RECONCILED_FAILED':
        return {'id': job.id, 'status': job.status}
    if job.status != 'outcome_unknown' or document.text_state != 'unknown' or not body.confirmed_no_deliverable_result:
        problem('DOCUMENT_RECONCILIATION_REQUIRED', '请先核实原调用和 R2 响应，确认无法交付后再释放额度', 409)
    if db.scalar(select(ExecutionLease.id).where(ExecutionLease.job_id == job.id,
            ExecutionLease.completed_at.is_(None)).limit(1)):
        problem('DOCUMENT_EXECUTION_ACTIVE', '仍有文件执行租约，不能完成核实', 409)
    before = {'status': job.status, 'accounted_micros': call.accounted_micros, 'cost_state': call.cost_state}
    if body.accounted_micros is not None:
        call.accounted_micros, call.cost_state = body.accounted_micros, 'confirmed'
    call.completed_at = call.completed_at or now()
    document.text_state = 'failed'
    finish_failed(db, job, ProcessingError('DOCUMENT_TEXT_RECONCILED_FAILED', '原文本调用已核实无法交付，预占已释放'))
    touch_job(db, job)
    record_audit(db, actor.id, 'document.resolve_unknown', 'job', job.id,
        before=before, after={'status': job.status, 'accounted_micros': call.accounted_micros, 'cost_state': call.cost_state},
        details={'call_id': call.id}, note=body.note)
    db.commit()
    return {'id': job.id, 'status': job.status}
