"""One per-image translation contract for reading and explicit actions."""
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from .assets import available, find_shared_original, owned_asset
from .auth import identity
from .config import settings
from .db import get_db
from .entitlements import entitlements_json, locked_user
from .errors import problem
from .file_pages import FilePage
from .jobs import create_job, idem_key, job_json, owned_job
from .languages import Language
from .models import Asset, Job, User, now
from .results import ReaderEntry, get_entry, shared_candidate
from .plan_limits import acquire_control, image_budget, policy_snapshot, release_control, server_now
from .plan_models import ReadingSession, TranslationOperation
from .providers import configuration, digest
from .reading_sessions import apply_priority, claim_priority, reading_window
from .request_models import RequestBody
from .scheduler import ACTIVE, lock_scheduler
from .schemas import OperationPageResponse, OperationResolutionResponse, ReadingLeaseResponse, TranslationPlanResponse
from .upload_models import UploadReservation
from .uploads import create_upload, upload_json

router = APIRouter(tags=['translation plans'])
Mode = Literal['classic', 'redraw']


class ImageDescriptor(RequestBody):
    client_item_id: str = Field(min_length=1, max_length=100)
    image_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    byte_size: int = Field(gt=0)
    content_type: str = Field(max_length=60)
    name: str = Field(default='', max_length=255)
    file_hash: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')
    page_index: int | None = Field(default=None, ge=0, le=1000000)
    asset_id: str | None = None

    @model_validator(mode='after')
    def paired(self):
        if (self.file_hash is None) != (self.page_index is None):
            raise ValueError('文件身份字段必须配对')
        return self


class PlanItem(RequestBody):
    page_key: str = Field(min_length=1, max_length=100)
    operation_key: str = Field(min_length=1, max_length=128)
    role: Literal['current', 'prefetch'] = 'current'
    mode: Mode
    target_language: Language
    max_quota_pages: int = Field(default=1, ge=0, le=1)
    expected_kind: str | None = None
    image: ImageDescriptor
    job_id: str | None = None
    action: Literal['ensure', 'retry', 'regenerate'] = 'ensure'
    source_job_id: str | None = None
    acknowledge_unknown_cost: bool = False


class TranslationPlan(RequestBody):
    trigger: Literal['reading', 'manual']
    session_id: str | None = Field(default=None, min_length=1, max_length=80)
    sequence: int | None = Field(default=None, ge=0, le=2147483647)
    priority_epochs: dict[Mode, int] = Field(default_factory=dict)
    allow_new: bool = True
    items: list[PlanItem] = Field(max_length=3)

    @model_validator(mode='after')
    def shape(self):
        if (self.session_id is None) != (self.sequence is None):
            raise ValueError('阅读会话和序号必须配对')
        if self.trigger == 'reading' and not self.session_id:
            raise ValueError('自动阅读需要会话')
        if self.trigger == 'manual' and len(self.items) != 1:
            raise ValueError('手动操作限单页')
        if self.trigger == 'reading' and any(item.action != 'ensure' for item in self.items):
            raise ValueError('自动阅读不能重译')
        if self.items and (self.items[0].role != 'current' or any(item.role != 'prefetch' for item in self.items[1:])):
            raise ValueError('当前页必须排在预取页之前')
        if len({item.page_key for item in self.items}) != len(self.items) or len({item.operation_key for item in self.items}) != len(self.items):
            raise ValueError('页面或操作编号不能重复')
        if any(epoch < 0 for epoch in self.priority_epochs.values()):
            raise ValueError('阅读epoch无效')
        return self


def operation_hash(item):
    return digest({'sha256': item.image.image_sha256, 'mode': item.mode,
        'language': item.target_language, 'max_quota_pages': item.max_quota_pages,
        'expected_kind': item.expected_kind, 'action': item.action, 'source_job_id': item.source_job_id,
        'acknowledge_unknown_cost': item.acknowledge_unknown_cost})


def receipt_json(db, operation, *, page_key=None, accepted=False, uploads=None, entries=None):
    job = entries[operation.entry_id] if entries is not None else get_entry(db, operation.entry_id)
    payload = job_json(db, job)
    source = db.get(Asset, job.input_asset_id) if job.input_asset_id else None
    if job.status in {'succeeded', 'no_text'} and available(source) and (job.status == 'no_text' or payload['result_available']):
        disposition = 'ready'
    elif job.status in ACTIVE - {'outcome_unknown'} and (not source or available(source)):
        disposition = 'accepted' if accepted else 'pending'
    else:
        disposition = 'blocked'
    upload = uploads.get(job.id) if uploads is not None else db.scalar(select(UploadReservation).where(UploadReservation.job_id == job.id))
    result = {'page_key': page_key or operation.descriptor.get('page_key'), 'operation_key': operation.operation_key,
        'disposition': disposition, 'job': payload,
        'upload': upload_json(upload) if upload and upload.status == 'awaiting_upload' else None,
        'created_at': operation.created_at.isoformat() + 'Z'}
    if disposition == 'blocked':
        result.update(code=job.error_code or ('RESULT_UNAVAILABLE' if job.status in {'succeeded', 'no_text'} else 'JOB_' + job.status.upper()),
            message=job.error_message or '该操作需要手动处理')
    return result


def receipt_page(db, operations):
    """Materialize bounded page dependencies once, including result grants."""
    operations = list(operations)
    if not operations:
        return []
    jobs = list(db.scalars(select(ReaderEntry).where(ReaderEntry.id.in_({row.entry_id for row in operations}))))
    assets = list(db.scalars(select(Asset).where(Asset.id.in_({asset_id for job in jobs
        for asset_id in (job.input_asset_id, job.output_asset_id) if asset_id}))))
    uploads = {row.job_id: row for row in db.scalars(select(UploadReservation).where(
        UploadReservation.job_id.in_({job.id for job in jobs})))}
    # jobs/assets stay strongly referenced while job_json uses the identity map.
    indexed = {job.id: job for job in jobs}
    result = [receipt_json(db, row, uploads=uploads, entries=indexed) for row in operations]
    return result


def bind_file_page(db, job, *, descriptor=None):
    if not job.input_asset_id:
        return
    identities = {(job.file_hash, job.page_index)} if job.file_hash and job.page_index is not None else set()
    descriptors = [descriptor] if descriptor is not None else [receipt.descriptor.get('image', {})
        for receipt in db.scalars(select(TranslationOperation).where(TranslationOperation.job_id == job.id))]
    for source_identity in descriptors:
        if source_identity.get('file_hash') and source_identity.get('page_index') is not None:
            identities.add((source_identity['file_hash'], source_identity['page_index']))
    for file_hash, index in sorted(identities):
        key = (job.owner_id, file_hash, index)
        existing = db.get(FilePage, key)
        if existing:
            source = db.get(Asset, existing.asset_id)
            if available(source) and source.sha256 != job.source_sha256:
                problem('FILE_PAGE_CONFLICT', '文件页已绑定不同原图', 409)
            existing.asset_id = job.input_asset_id
        else:
            db.add(FilePage(owner_id=job.owner_id, file_hash=file_hash, page_index=index, asset_id=job.input_asset_id))


def accept_item(db, user, item, allow_new, *, shared_hint=None):
    key, signature = idem_key(item.operation_key), operation_hash(item)
    old = db.get(TranslationOperation, (user.id, key))
    if old:
        if old.request_hash != signature:
            problem('IDEMPOTENCY_CONFLICT', '操作编号已绑定其他翻译内容', 409)
        return receipt_json(db, old, page_key=item.page_key)
    image = item.image
    if image.byte_size > settings().max_upload_bytes:
        problem('IMAGE_TOO_LARGE', '图片大小超过限制', 413)
    if image.content_type not in {'image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'}:
        problem('UNSUPPORTED_IMAGE', '仅支持静态 PNG、JPEG 或 WebP 图片', 422)
    if image.file_hash:
        binding = db.get(FilePage, (user.id, image.file_hash, image.page_index))
        bound = db.get(Asset, binding.asset_id) if binding else None
        if available(bound) and bound.sha256 != image.image_sha256:
            problem('FILE_PAGE_CONFLICT', '文件页已绑定不同原图', 409)
        pending = db.scalars(select(TranslationOperation).join(Job, Job.id == TranslationOperation.job_id).where(
            TranslationOperation.owner_id == user.id, Job.status.in_(ACTIVE),
            TranslationOperation.descriptor['image']['file_hash'].as_string() == image.file_hash,
            TranslationOperation.descriptor['image']['page_index'].as_integer() == image.page_index))
        if any(db.get(Job, row.job_id).source_sha256 != image.image_sha256 for row in pending):
            problem('FILE_PAGE_CONFLICT', '文件页已有不同原图正在翻译', 409)
    if item.job_id:
        reference = owned_job(db, item.job_id, user.id)
        if (reference.source_sha256, reference.mode, reference.target_language) != (image.image_sha256, item.mode, item.target_language):
            problem('JOB_SOURCE_MISMATCH', '任务与当前图片不符', 409)
    if item.action != 'ensure':
        if not item.source_job_id:
            problem('RERUN_SOURCE_REQUIRED', '重新翻译需要来源任务', 422)
        previous = owned_job(db, item.source_job_id, user.id)
        if (previous.source_sha256, previous.mode, previous.target_language) != (image.image_sha256, item.mode, item.target_language):
            problem('RERUN_SOURCE_MISMATCH', '重新翻译与来源任务不符', 409)
        if previous.status in {'outcome_unknown', 'unknown_released'} and not item.acknowledge_unknown_cost:
            problem('UNKNOWN_COST_ACK_REQUIRED', '原请求可能已计费，请先确认', 409)
        if item.action == 'retry' and previous.status in ACTIVE - {'outcome_unknown'}:
            problem('JOB_STILL_ACTIVE', '原任务尚未完成', 409)
    asset = owned_asset(db, image.asset_id, user.id) if image.asset_id else find_shared_original(
        db, user.id, image.image_sha256, byte_size=image.byte_size, mime=image.content_type)
    if asset and asset.sha256 != image.image_sha256:
        problem('IMAGE_HASH_MISMATCH', '原图与摘要不一致', 409)
    job = create_job(db, user, asset, item.mode, item.target_language, key, operation='plan',
        force=item.action != 'ensure', max_quota_pages=item.max_quota_pages, expected_kind=item.expected_kind,
        source_sha256=image.image_sha256, file_hash=image.file_hash, page_index=image.page_index,
        allow_new=allow_new, request_hash_override=signature, shared_hint=shared_hint)
    operation = db.get(TranslationOperation, (user.id, key))
    operation.descriptor = {'page_key': item.page_key, 'image': image.model_dump()}
    if not job.input_asset_id and job.status == 'awaiting_upload':
        create_upload(db, job, {'sha256': image.image_sha256, 'byte_size': image.byte_size, 'mime': image.content_type})
    bind_file_page(db, job, descriptor=image.model_dump())
    db.flush()
    created = isinstance(job, Job) and job.operation == 'plan' and job.idempotency_key == key
    return receipt_json(db, operation, page_key=item.page_key, accepted=created)


def plan_snapshot(db, user):
    return {'policy_revision': policy_snapshot(db, user), 'server_time': server_now(db).isoformat() + 'Z',
        'image_rate_limit': image_budget(db, user), 'entitlements': entitlements_json(db, user)}


@router.post('/v1/translation-plans', response_model=TranslationPlanResponse,
    responses={202: {'model': TranslationPlanResponse}, 429: {'model': TranslationPlanResponse}})
def translate(body: TranslationPlan, user: User = Depends(identity), db: Session = Depends(get_db)):
    owner_id = user.id
    db.rollback()
    token = acquire_control(owner_id)
    try:
        # Candidate discovery can sort/filter versions and grants without
        # holding the admission/scheduler mutex. These are hints only: create_job
        # checks current configuration and revalidates assets after taking it.
        hints = {}
        discovered = {}
        for item in body.items:
            if item.action != 'ensure' or db.get(TranslationOperation, (owner_id, item.operation_key)):
                continue
            try:
                config = configuration(db, item.mode, item.target_language)
                cache_key = digest({'hash': item.image.image_sha256, 'mode': item.mode,
                    'language': item.target_language, 'config_version': config['version']})
                if cache_key not in discovered:
                    discovered[cache_key] = shared_candidate(db, cache_key)
                hints[item.page_key] = discovered[cache_key]
            except HTTPException:
                pass  # Per-page validation below remains authoritative.
        db.rollback()
        lock_scheduler(db)
        user = locked_user(db, owner_id)
        session = reading_window(db, owner_id, body)
        priority = claim_priority(db, session, sorted({item.mode for item in body.items}), body.priority_epochs) if session else {}
        items = []
        for item in body.items:
            try:
                with db.begin_nested():
                    result = accept_item(db, user, item, body.allow_new, shared_hint=hints.get(item.page_key))
            except HTTPException as error:
                detail = error.detail if isinstance(error.detail, dict) else {'code': 'ITEM_REJECTED', 'message': str(error.detail)}
                result = {'page_key': item.page_key, 'operation_key': item.operation_key,
                    'disposition': 'deferred' if detail['code'] in {'IMAGE_RATE_LIMITED', 'NEW_TRANSLATION_NOT_REQUESTED'} else 'blocked', **detail}
            items.append(result)
        if session:
            apply_priority(db, session, [(item['job']['id'], item['job']['mode']) for item in items if 'job' in item])
        result = {'session_id': body.session_id, 'applied_sequence': session.sequence if session else None,
            'priority': priority, 'items': items, **plan_snapshot(db, user)}
        # Refresh the payload after atomic priority changes, without moving feed cursor.
        for item in items:
            if 'job' in item:
                item['job'] = job_json(db, get_entry(db, item['job']['id']))
        status = 202 if any(item['disposition'] == 'accepted' for item in items) else 200
        headers = {}
        if items and all(item.get('code') == 'IMAGE_RATE_LIMITED' for item in items):
            status = 429
            retry = result['image_rate_limit']['retry_after_seconds']
            result['error'] = {'code': 'IMAGE_RATE_LIMITED', 'message': '本分钟新增翻译图片已达上限', 'scope': 'new_translation', 'retry_after_seconds': retry}
            headers['Retry-After'] = str(retry)
        db.commit()
        return JSONResponse(result, status_code=status, headers=headers)
    finally:
        db.rollback()
        release_control(owner_id, token)


class ResolveRequest(RequestBody):
    operation_keys: list[str] = Field(min_length=1, max_length=10)


def ancillary_control(request: Request, user: User = Depends(identity), db: Session = Depends(get_db)):
    owner_id = user.id
    scope = 'lease' if request.url.path.endswith('/lease') else 'operations'
    db.rollback()
    token = acquire_control(owner_id, scope)
    try:
        yield
    finally:
        db.rollback()
        release_control(owner_id, token, scope)


@router.post('/v1/translation-operations/resolve', dependencies=[Depends(ancillary_control)], response_model=OperationResolutionResponse, response_model_exclude_none=True)
def resolve(body: ResolveRequest, user: User = Depends(identity), db: Session = Depends(get_db)):
    lock_scheduler(db)
    for key in body.operation_keys:
        idem_key(key)
    matched = {row['operation_key']: row for row in receipt_page(db, db.scalars(select(TranslationOperation).where(
        TranslationOperation.owner_id == user.id, TranslationOperation.operation_key.in_(body.operation_keys))))}
    items = [matched.get(key, {'operation_key': key, 'disposition': 'not_found'}) for key in body.operation_keys]
    result = {'items': items, 'policy_revision': policy_snapshot(db, user)}
    db.commit()
    return result


@router.get('/v1/translation-operations', dependencies=[Depends(ancillary_control)], response_model=OperationPageResponse, response_model_exclude_none=True)
def operations(offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100),
               user: User = Depends(identity), db: Session = Depends(get_db)):
    query = select(TranslationOperation).where(TranslationOperation.owner_id == user.id)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.scalars(query.order_by(TranslationOperation.created_at.desc(), TranslationOperation.operation_key).offset(offset).limit(limit))
    return {'items': receipt_page(db, rows), 'total': total, 'next_offset': offset + limit if offset + limit < total else None}


class LeaseRequest(RequestBody):
    modes: list[Mode] = Field(min_length=1, max_length=2)
    priority_epochs: dict[Mode, int] = Field(default_factory=dict)
    takeover: bool = False


@router.put('/v1/reading-sessions/{session_id}/lease', dependencies=[Depends(ancillary_control)], response_model=ReadingLeaseResponse)
def lease(session_id: str, body: LeaseRequest, user: User = Depends(identity), db: Session = Depends(get_db)):
    from datetime import timedelta
    from .config import settings
    lock_scheduler(db)
    session = db.get(ReadingSession, (user.id, session_id))
    if not session or session.fenced or session.expires_at <= now():
        problem('READING_SESSION_EXPIRED', '阅读会话已失效，请建立新会话', 409)
    session.expires_at = now() + timedelta(seconds=settings().priority_ttl_seconds)
    priority = claim_priority(db, session, body.modes, body.priority_epochs, takeover=body.takeover)
    jobs = []
    for item in session.window:
        operation = db.get(TranslationOperation, (user.id, item['operation_key']))
        if operation:
            jobs.append((operation.job_id, item['mode']))
    apply_priority(db, session, jobs)
    result = {'session_id': session_id, 'priority': priority, 'policy_revision': policy_snapshot(db, user)}
    db.commit()
    return result
