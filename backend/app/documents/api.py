"""Small authenticated JSON requests; document bytes never transit the API."""
from datetime import timedelta
import math
from typing import Annotated, Literal
from uuid import UUID
from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field, field_validator
from sqlalchemy import func, select, tuple_
from sqlalchemy.orm import Session
from ..auth import identity
from ..classic_config import profile_snapshot
from ..system_settings import get_request_limits
from .text import PROMPT_VERSION, system_prompt
from ..db import get_db
from ..entitlements import locked_user
from ..errors import problem
from ..languages import LANGUAGES, Language
from ..models import Job, User, now, uid
from ..providers import digest
from ..queue_models import JobStage
from ..request_models import RequestBody
from ..scheduler import lock_scheduler, touch_job
from ..translation_limits import acquire_control, release_control
from ..translation_models import TranslationProvider
from ..translation_providers import _provider_query
from ..translation_routing import choose_provider
from ..translation_selection import policy_resolver
from .config import MAX_PAGES, MAX_SOURCE_BYTES, get_document_settings
from .models import Document, DocumentPage, DocumentQuotaAllocation
from .quota import reserve_document
from .storage import DocumentStoreError, get_document_store

router = APIRouter(prefix='/v1/documents', tags=['documents'])
OPERATION = 'document:translate'
TERMINAL = {'succeeded', 'failed', 'cancelled'}


class DocumentInput(RequestBody):
    filename: str = Field(min_length=1, max_length=240, strict=True)
    source_type: Literal['zip', 'pdf']
    byte_size: int = Field(ge=1, le=MAX_SOURCE_BYTES, strict=True)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$', strict=True)
    target_language: Language
    model_id: str | None = Field(default=None, min_length=1, max_length=36, pattern=r'^[a-zA-Z0-9_-]+$')

    @field_validator('filename')
    @classmethod
    def safe_filename(cls, value):
        if not value.strip() or any(ord(char) < 32 or ord(char) == 127 or char in '/\\' for char in value):
            raise ValueError('Expected a filename without paths or control characters')
        return value


class UploadParts(RequestBody):
    part_numbers: list[Annotated[int, Field(ge=1, strict=True)]] = Field(min_length=1, max_length=40)

    @field_validator('part_numbers')
    @classmethod
    def unique_parts(cls, value):
        if any(number < 1 for number in value) or len(set(value)) != len(value):
            raise ValueError('Part numbers must be positive and unique')
        return value


def guarded_user(request: Request, user: User = Depends(identity)):
    scope = 'document_snapshot' if request.method == 'GET' else 'documents'
    token = acquire_control(user.id, scope)
    try:
        yield user
    finally:
        release_control(user.id, token, scope)


def _enabled():
    cfg = get_document_settings()
    if not cfg.enabled:
        problem('DOCUMENT_DISABLED', '文件翻译暂未开放', 503)
    return cfg


def _storage(method, *args, **kwargs):
    try:
        return getattr(get_document_store(), method)(*args, **kwargs)
    except DocumentStoreError as error:
        problem(error.code, '文件存储暂时不可用，请稍后重试', 503)


def owned_document(db, owner_id, request_id, *, lock=False):
    if lock:
        lock_scheduler(db)
    query = select(Job, Document).join(Document, Document.job_id == Job.id).where(
        Job.owner_id == owner_id, Job.operation == OPERATION, Job.idempotency_key == str(request_id),
        Job.workflow_kind == 'document')
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    row = db.execute(query).first()
    if row is None:
        problem('DOCUMENT_NOT_FOUND', '找不到文件任务', 404)
    return row


def _stamp(value):
    return value.isoformat() + 'Z' if value else None


def _snapshot_context(db, job_ids):
    progress, quota = {}, {}
    if not job_ids:
        return progress, quota
    for job_id, status, count in db.execute(select(DocumentPage.job_id, DocumentPage.status, func.count())
            .where(DocumentPage.job_id.in_(job_ids)).group_by(DocumentPage.job_id, DocumentPage.status)):
        progress.setdefault(job_id, {})[status] = count
    for row in db.execute(select(DocumentQuotaAllocation.job_id,
            *(func.sum(getattr(DocumentQuotaAllocation, field)) for field in ('reserved', 'used', 'released')))
            .where(DocumentQuotaAllocation.job_id.in_(job_ids)).group_by(DocumentQuotaAllocation.job_id)):
        quota[row[0]] = row[1:]
    return progress, quota


def document_json(db, job, document, *, context=None):
    progress, quota = context if context is not None else _snapshot_context(db, [job.id])
    totals = quota.get(job.id, (0, 0, 0))
    gift = (job.entitlement or {}).get('document_unlimited_gift', {})
    totals = tuple(amount + gift.get(field, 0) for amount, field in zip(totals, ('reserved', 'used', 'released')))
    checked_quota = (job.entitlement or {}).get('document_quota', {})
    cfg = get_document_settings()
    return {'id': job.idempotency_key, 'status': job.status, 'phase': job.phase, 'version': job.version,
        'filename': document.filename, 'source_type': document.source_type, 'byte_size': document.source_size,
        'page_count': document.page_count, 'target_language': job.target_language,
        'model': {'id': job.config['text']['provider_id'], 'name': job.config['document']['model_name']},
        'progress': progress.get(job.id, {}), 'quota': {**dict(zip(('reserved', 'used', 'released'), totals)),
            'needed': document.page_count, 'available': checked_quota.get('available'),
            'difference': checked_quota.get('difference'), 'checked_at': checked_quota.get('checked_at')},
        'cancellable': document.reserved_at is None and job.status not in TERMINAL,
        'resumable': job.status == 'awaiting_quota' and document.reserved_at is None and document.expires_at > now(),
        'downloadable': job.status == 'succeeded' and bool(document.output_ref) and document.expires_at > now(),
        'error_code': job.error_code, 'error_message': job.error_message,
        'created_at': _stamp(job.created_at), 'expires_at': _stamp(document.expires_at),
        'upload': {'part_bytes': cfg.upload_part_bytes,
                   'part_count': math.ceil(document.source_size / cfg.upload_part_bytes)} if job.status == 'uploading' else None}


def _document_models(db, user, model_id=None):
    resolve = policy_resolver(db, user)
    query = _provider_query()
    if model_id:
        query = query.where(TranslationProvider.id == model_id)
    rows = list(db.execute(query))
    if model_id and not rows:
        problem('TRANSLATION_MODEL_UNAVAILABLE', '所选模型暂不可用', 503)
    candidates = []
    for row in rows:
        if not (row.config.get('document') or {}).get('enabled'):
            continue
        policy, reason = resolve(row.text_plan_ids)
        if reason != 'not_allowed':
            candidates.append((row, policy))
    return candidates


def _model(db, user, body):
    candidates = _document_models(db, user, body.model_id)
    if not candidates:
        problem('MODEL_DOCUMENT_UNSUPPORTED', '当前模型或权益不支持整份文件翻译，请选择支持的模型', 403)
    selected = choose_provider({row.id: row.weight for row, _ in candidates}, digest([body.sha256, body.target_language]))
    row, policy = next(item for item in candidates if item[0].id == selected)
    config = profile_snapshot({'provider_id': row.id, 'revision_id': row.revision_id,
                               'channel': row.channel, **row.config}, prompt_version=PROMPT_VERSION,
                              text_prompt=system_prompt(get_request_limits(db).comic_translation_prompt))
    config['document'] = {'service_plans': row.text_plan_ids, 'model_name': row.name}
    config['version'] = digest(config)
    return config, policy


@router.get('/capabilities')
def document_capabilities(user: User = Depends(guarded_user), db: Session = Depends(get_db)):
    cfg = get_document_settings()
    return {'enabled': cfg.enabled,
        'limits': {'max_bytes': MAX_SOURCE_BYTES, 'max_pages': MAX_PAGES,
                   'part_bytes': cfg.upload_part_bytes, 'waiting_hours': cfg.waiting_retention_hours},
        'source_types': ['pdf', 'zip', 'cbz'], 'output_type': 'zip',
        'languages': [{'id': key, 'label': label} for key, label in LANGUAGES.items()],
        'models': [{'id': row.id, 'name': row.name} for row, _ in _document_models(db, user)] if cfg.enabled else []}


def _ensure_upload(db, job, document):
    if document.upload_id or job.status != 'uploading':
        return job, document
    if document.expires_at <= now():
        problem('DOCUMENT_EXPIRED', '上传已过期，请创建新的文件任务', 410)
    key, mime = document.source_key, 'application/pdf' if document.source_type == 'pdf' else 'application/zip'
    owner_id, request_id = job.owner_id, job.idempotency_key
    db.commit()  # No network metadata operation may hold the scheduler mutex.
    upload_id = _storage('create_multipart', key, mime)
    job, document = owned_document(db, owner_id, request_id, lock=True)
    keep = job.status == 'uploading' and document.expires_at > now() and not document.upload_id
    if keep:
        document.upload_id = upload_id
    db.commit()
    if not keep:
        try:
            _storage('abort_multipart', key, upload_id)
        except Exception:
            # An unbound empty upload is also covered by the R2 multipart lifecycle.
            pass
    return job, document


@router.put('/{request_id}', status_code=202)
def create_document(request_id: UUID, body: DocumentInput, user: User = Depends(guarded_user), db: Session = Depends(get_db)):
    cfg = _enabled()
    request_hash = digest(body.model_dump())
    lock_scheduler(db)
    user = locked_user(db, user.id)
    previous = db.scalar(select(Job).where(Job.owner_id == user.id, Job.operation == OPERATION,
                                         Job.idempotency_key == str(request_id)))
    if previous:
        if previous.request_hash != request_hash:
            problem('IDEMPOTENCY_CONFLICT', '此操作编号已用于其他文件或参数', 409)
        job, document = previous, db.get(Document, previous.id)
    else:
        config, policy = _model(db, user, body)
        at = now()
        job = Job(id=uid(), owner_id=user.id, mode='classic', workflow_kind='document',
            target_language=body.target_language, operation=OPERATION, idempotency_key=str(request_id),
            source_sha256=body.sha256, request_hash=request_hash, cache_key=digest([user.id, request_hash]),
            config=config, quota_pages=0, quota_kind='document_pages', settlement='unreserved',
            entitlement={'plan': policy.plan, 'service_plan': policy.service_plan, 'priority': 0},
            version=1, status='uploading', phase='uploading', created_at=at)
        db.add(job)
        db.flush()
        document = Document(job_id=job.id, filename=body.filename, source_type=body.source_type,
            source_key=f'{cfg.r2_key_prefix}/input/{job.id}/source', source_size=body.byte_size,
            source_sha256=body.sha256, expires_at=at + timedelta(seconds=cfg.upload_lifetime_seconds))
        db.add(document)
        touch_job(db, job)
    db.commit()
    job, document = _ensure_upload(db, job, document)
    return document_json(db, job, document)


@router.post('/{request_id}/upload-parts')
def upload_parts(request_id: UUID, body: UploadParts, user: User = Depends(guarded_user), db: Session = Depends(get_db)):
    cfg = _enabled()
    job, document = owned_document(db, user.id, request_id)
    if job.status != 'uploading' or document.expires_at <= now():
        problem('DOCUMENT_UPLOAD_CLOSED', '此任务不再接受上传', 409)
    job, document = _ensure_upload(db, job, document)
    count = math.ceil(document.source_size / cfg.upload_part_bytes)
    if max(body.part_numbers) > count:
        problem('DOCUMENT_PART_INVALID', '上传分片编号超出文件范围', 422)
    key, upload_id, size = document.source_key, document.upload_id, document.source_size
    db.commit()
    parts = [{'part_number': number, **_storage('presign_upload_part', key, upload_id, number,
        byte_size=min(cfg.upload_part_bytes, size - (number - 1) * cfg.upload_part_bytes))} for number in body.part_numbers]
    return {'parts': parts}


@router.post('/{request_id}/complete-upload', status_code=202)
def complete_upload(request_id: UUID, user: User = Depends(guarded_user), db: Session = Depends(get_db)):
    cfg = _enabled()
    job, document = owned_document(db, user.id, request_id, lock=True)
    if document.upload_completed_at or job.status != 'uploading':
        return document_json(db, job, document)
    if document.expires_at <= now() or not document.upload_id:
        problem('DOCUMENT_UPLOAD_CLOSED', '上传已过期或尚未准备完成', 409)
    key, upload_id, size, sha = document.source_key, document.upload_id, document.source_size, document.source_sha256
    db.commit()
    _storage('complete_multipart', key, upload_id, expected_size=size, expected_sha256=sha)
    job, document = owned_document(db, user.id, request_id, lock=True)
    if job.status == 'uploading' and document.expires_at > now() and not document.upload_completed_at:
        document.upload_completed_at = now()
        document.expires_at = now() + timedelta(hours=cfg.waiting_retention_hours)
        job.status, job.phase = 'preflight', 'doc_prepare'
        from .workflow import ensure_prepare
        ensure_prepare(db, job)
        job.version += 1
        touch_job(db, job)
    db.commit()
    return document_json(db, job, document)


@router.post('/{request_id}/resume', status_code=202)
def resume_document(request_id: UUID, user: User = Depends(guarded_user), db: Session = Depends(get_db)):
    _enabled()
    job, document = owned_document(db, user.id, request_id, lock=True)
    if document.reserved_at is not None:
        return document_json(db, job, document)
    if job.status != 'awaiting_quota':
        problem('DOCUMENT_NOT_RESUMABLE', '只有等待补充额度的文件任务可以继续', 409)
    if reserve_document(db, job):
        from .workflow import start_pages
        start_pages(db, job)
        job.version += 1
    db.commit()
    return document_json(db, job, document)


@router.post('/{request_id}/cancel')
def cancel_document(request_id: UUID, user: User = Depends(guarded_user), db: Session = Depends(get_db)):
    job, document = owned_document(db, user.id, request_id, lock=True)
    if document.reserved_at is not None:
        problem('DOCUMENT_NOT_CANCELLABLE', '额度预占完成后文件任务不能取消', 409)
    if job.status not in TERMINAL:
        job.cancel_requested, job.discard_output = True, True
        job.status, job.phase, job.completed_at = 'cancelled', 'cancelled', now()
        job.version += 1
        document.cleanup_after = now() + timedelta(hours=1)
        for stage in db.scalars(select(JobStage).where(JobStage.job_id == job.id,
                                                      JobStage.status.in_(['waiting', 'ready']))):
            stage.status = 'cancelled'
        touch_job(db, job)
    key, upload_id = document.source_key, document.upload_id
    db.commit()
    if upload_id and not document.upload_completed_at:
        try:
            _storage('abort_multipart', key, upload_id)
        except Exception:
            pass  # Persistent cleanup_after retains a retryable cleanup obligation.
    return document_json(db, job, document)


@router.get('')
def document_history(limit: int = Query(20, ge=1, le=50), before: UUID | None = None,
                     user: User = Depends(guarded_user), db: Session = Depends(get_db)):
    query = select(Job, Document).join(Document, Document.job_id == Job.id).where(
        Job.owner_id == user.id, Job.workflow_kind == 'document')
    if before:
        cursor, _ = owned_document(db, user.id, before)
        query = query.where(tuple_(Job.created_at, Job.id) < (cursor.created_at, cursor.id))
    rows = db.execute(query.order_by(Job.created_at.desc(), Job.id.desc()).limit(limit + 1)).all()
    context = _snapshot_context(db, [job.id for job, _ in rows[:limit]])
    return {'items': [document_json(db, job, document, context=context) for job, document in rows[:limit]],
            'next_cursor': rows[limit - 1][0].idempotency_key if len(rows) > limit else None}


@router.get('/{request_id}')
def get_document(request_id: UUID, user: User = Depends(guarded_user), db: Session = Depends(get_db)):
    job, document = owned_document(db, user.id, request_id)
    return document_json(db, job, document)


@router.get('/{request_id}/download')
def download_document(request_id: UUID, user: User = Depends(guarded_user), db: Session = Depends(get_db)):
    job, document = owned_document(db, user.id, request_id)
    if job.status != 'succeeded' or not document.output_ref or document.expires_at <= now():
        problem('DOCUMENT_RESULT_UNAVAILABLE', '完整译图文件尚不可下载或已经过期', 409)
    key = document.output_ref['key']
    filename = document.filename.rsplit('.', 1)[0] + '-translated.zip'
    db.commit()
    return _storage('presign_download', key, filename=filename)
