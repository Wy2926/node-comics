"""Per-image translation resources, immutable intents and resumable snapshots."""
import asyncio
from datetime import timedelta
from typing import Literal
from uuid import UUID
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import Field, model_validator
from sqlalchemy import and_, func, or_, select, tuple_
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from .assets import available, object_path
from .auth import identity
from .config import settings
from .db import get_db, session_factory
from .errors import problem
from .jobs import cancel_job, create_job
from .languages import Language
from .models import Asset, Attempt, ClassicState, Job, TextCall, User, now
from .queue_models import ExecutionLease
from .providers import digest
from .request_models import RequestBody
from .scheduler import ACTIVE, lock_scheduler, touch_job
from .schemas import TranslationHistoryResponse, TranslationResponse, TranslationsResponse
from .translation_limits import acquire_control, release_control
from .translation_requests import TranslationRequest
from .upload_models import UploadReservation
from .uploads import create_upload

router = APIRouter(tags=['translations'])


class ImageDescriptor(RequestBody):
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    byte_size: int = Field(gt=0, strict=True)
    content_type: Literal['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream']
    normalization_version: Literal[1] = 1


class TranslationInput(RequestBody):
    image: ImageDescriptor | None = None
    mode: Literal['classic'] | None = None
    target_language: Language | None = None
    retry_of: UUID | None = None
    regenerate_of: UUID | None = None
    acknowledge_unknown_cost: bool = False
    result_format: Literal['overlay-v1', 'overlay-tiles-v1'] = Field(default='overlay-v1', exclude=True)
    priority: Literal['current', 'prefetch'] = Field(default='current', exclude=True, deprecated=True,
        description='仅兼容旧插件；接收后忽略，不参与调度、持久化或请求身份。')

    @model_validator(mode='after')
    def shape(self):
        ordinary = any(value is not None for value in (self.image, self.mode, self.target_language))
        if sum((ordinary, self.retry_of is not None, self.regenerate_of is not None)) != 1:
            raise ValueError('图片描述、重试来源、重译来源必须且只能指定一种')
        if ordinary and any(value is None for value in (self.image, self.mode, self.target_language)):
            raise ValueError('请提供图片描述、翻译模式和目标语言')
        if self.acknowledge_unknown_cost and self.regenerate_of is None:
            raise ValueError('未知成本确认仅用于显式重新生成')
        return self


def owned_translation(db, owner_id, request_id):
    row = db.get(TranslationRequest, (owner_id, str(request_id)))
    if row is None:
        problem('NOT_FOUND', '找不到此翻译请求', 404)
    return row


def iso(value):
    return value.isoformat() + 'Z' if value else None


def unavailable(db, row, entry, assets=None):
    if entry and (entry.entitlement or {}).get('plan') == 'guest' and entry.completed_at and entry.completed_at <= now() - timedelta(hours=24):
        return True
    if row.revoked_at or entry is None:
        return True
    lookup = (lambda key: assets.get(key)) if assets is not None else (lambda key: db.get(Asset, key))
    source = lookup(entry.input_asset_id) if entry.input_asset_id else None
    output = lookup(entry.output_asset_id) if entry.output_asset_id else None
    return bool((source and source.deleted_at) or (output and output.deleted_at))


def snapshot_context(db, rows):
    entries = {entry.id: entry for entry in db.scalars(select(Job).where(
        tuple_(Job.owner_id, Job.id).in_({(row.owner_id, row.job_id) for row in rows if row.job_id})))} if rows else {}
    asset_ids = {asset_id for entry in entries.values()
        for asset_id in (entry.input_asset_id, entry.output_asset_id) if asset_id}
    assets = {asset.id: asset for asset in db.scalars(select(Asset).where(Asset.id.in_(asset_ids)))} if asset_ids else {}
    awaiting = {entry.id for entry in entries.values() if entry.status == 'awaiting_upload'}
    uploads = {upload.job_id: upload for upload in db.scalars(select(UploadReservation).where(
        UploadReservation.job_id.in_(awaiting)))} if awaiting else {}
    withdrawn = {row.job_id for row in rows if row.job_id in entries and
        unavailable(db, row, entries[row.job_id], assets)}
    resolved = resolved_execution_ids(db, {key: entries[key] for key in withdrawn})
    return entries, assets, uploads, resolved


def resolved_execution_ids(db, entries):
    """A withdrawn result may expose only its owner's verified terminal verdict."""
    candidates = {key for key, entry in entries.items() if entry.status in
        {'succeeded', 'no_text', 'failed', 'cancelled'} and entry.completed_at and
        entry.settlement in {'settled', 'released', 'included'}}
    if not candidates:
        return set()
    live_lease = select(ExecutionLease.id).where(ExecutionLease.job_id == Job.id,
        ExecutionLease.completed_at.is_(None)).exists()
    live_text = select(TextCall.id).where(TextCall.job_id == Job.id, TextCall.completed_at.is_(None)).exists()
    unknown_text = select(TextCall.id).where(TextCall.job_id == Job.id,
        TextCall.cost_state.not_in({'reported', 'estimated'})).exists()
    attempt_exists = select(Attempt.id).where(Attempt.job_id == Job.id, Attempt.id == Job.attempt_id).exists()
    never_started = and_(Job.attempt_id.is_(None), Job.status.in_({'failed', 'cancelled', 'no_text'}))
    return set(db.scalars(select(Job.id).where(Job.id.in_(candidates), ~live_lease, ~live_text,
        ~unknown_text, or_(attempt_exists, never_started))))


def translation_page(db, rows):
    rows = list(rows)
    context = snapshot_context(db, rows)
    return [translation_json(db, row, context=context) for row in rows]


def translation_json(db, row, *, context=None):
    context = context if context is not None else snapshot_context(db, [row])
    entry = context[0].get(row.job_id)
    assets = context[1]
    asset_for = lambda key: assets.get(key)
    descriptor = row.descriptor or {}
    state = ('needs_input' if entry.status == 'awaiting_upload' else
        'needs_attention' if entry.status in {'outcome_unknown', 'unknown_released'} else
        'succeeded' if entry.status in {'succeeded', 'no_text'} else
        'failed' if entry.status in {'failed', 'cancelled'} else
        'running' if entry.status == 'running' and entry.phase != 'validate_upload' else 'queued') if entry else 'failed'
    error = ({'code': entry.error_code, 'message': entry.error_message or '翻译失败'} if entry and entry.error_code else None)
    withdrawn = unavailable(db, row, entry, assets)
    if withdrawn:
        state, error = 'failed', {'code': 'TRANSLATION_UNAVAILABLE', 'message': '翻译访问已撤销'}
    elif state == 'failed' and error is None:
        error = {'code': 'TRANSLATION_CANCELLED', 'message': '翻译已取消'}
    upload = context[2].get(row.job_id) if state == 'needs_input' else None
    result = None
    if state == 'succeeded':
        output = asset_for(entry.output_asset_id) if entry.output_asset_id else None
        source = asset_for(entry.input_asset_id) if entry.input_asset_id else None
        description = entry.result_description or {}
        representation = output.representation if output else 'original'
        result = {'kind': 'no_text' if entry.status == 'no_text' else 'partial' if 'unrecognized_regions' in (entry.quality_flags or []) else 'translated',
            'representation': representation, 'input_sha256': entry.source_sha256,
            'normalization_version': source.normalization_version if source else 1,
            'width': output.width if representation == 'full-image-v1' else description.get('width') or (source.width if source else None),
            'height': output.height if representation == 'full-image-v1' else description.get('height') or (source.height if source else None),
            'artifact': None, 'quality_flags': entry.quality_flags or []}
        if output:
            result['artifact'] = {'sha256': output.sha256, 'byte_size': output.byte_size, 'mime': output.mime,
                'path': f"/v1/{'guest/' if (entry.entitlement or {}).get('plan') == 'guest' else ''}translations/{row.id}/result"}
            if representation == 'overlay-v1':
                result.update(bbox=output.bbox, composite='source-atop')
            elif representation == 'overlay-tiles-v1':
                result['composite'] = 'source-atop'
            if not available(output):
                error = {'code': 'RESULT_UNAVAILABLE', 'message': '结果文件暂不可用，请稍后重试'}
    return {'id': row.id, 'state': state,
        'execution_resolved': bool(withdrawn and (entry and entry.id in context[3] or
            row.job_id is None and row.revoked_at and row.legacy_execution_resolved)),
        'mode': entry.mode if entry else descriptor['mode'],
        'target_language': entry.target_language if entry else descriptor['target_language'],
        'image_sha256': entry.source_sha256 if entry else descriptor['image']['sha256'],
        'input_expires_at': iso(upload.expires_at) if upload else None,
        'result': result, 'error': error, 'created_at': iso(row.created_at),
        'updated_at': iso(row.revoked_at or (entry.changed_at if entry else row.created_at))}


def accept_translation(db, user, request_id, body):
    content = body.model_dump(mode='json')
    if body.result_format != 'overlay-v1':
        content['result_format'] = body.result_format
    signature = digest(content)
    old = db.get(TranslationRequest, (user.id, request_id))
    if old:
        if old.request_hash != signature:
            problem('IDEMPOTENCY_CONFLICT', '请求编号已绑定其他翻译内容', 409)
        entry = db.get(Job, old.job_id) if old.job_id else None
        if unavailable(db, old, entry):
            problem('TRANSLATION_UNAVAILABLE', '翻译访问已撤销或过期', 410)
        return old
    image, mode, language = body.image, body.mode, body.target_language
    result_format = body.result_format
    previous_id = body.retry_of or body.regenerate_of
    if previous_id:
        previous = owned_translation(db, user.id, previous_id)
        entry = db.get(Job, previous.job_id) if previous.job_id else None
        if unavailable(db, previous, entry):
            problem('TRANSLATION_UNAVAILABLE', '来源翻译访问已撤销或过期', 410)
        unknown = entry.status in {'outcome_unknown', 'unknown_released'}
        if unknown and (body.retry_of or not body.acknowledge_unknown_cost):
            problem('UNKNOWN_COST_ACK_REQUIRED', '原调用结果待核实，不能自动重试', 409)
        if not unknown and body.retry_of and entry.status not in {'failed', 'cancelled'}:
            problem('RETRY_NOT_ALLOWED', '只有明确失败或取消的请求可以重试', 409)
        if not unknown and body.regenerate_of and entry.status not in {'succeeded', 'no_text'}:
            problem('REGENERATE_NOT_ALLOWED', '只有完成的请求可以重新翻译', 409)
        image = ImageDescriptor.model_validate(previous.descriptor['image'])
        mode, language = entry.mode, entry.target_language
        result_format = (previous.descriptor or {}).get('result_format', 'overlay-v1')
        if body.result_format != 'overlay-v1' and body.result_format != result_format:
            problem('IDEMPOTENCY_CONFLICT', '重试必须沿用原结果格式', 409)
    if mode != 'classic' and result_format != 'overlay-v1':
        problem('MODE_UNSUPPORTED', '分块覆盖仅用于常规翻译', 422)
    if image.byte_size > settings().max_upload_bytes:
        problem('IMAGE_TOO_LARGE', '图片大小超过限制', 413)
    asset = None  # Inputs are private to each actual job, never claimed by hash.
    entry = create_job(db, user, asset, mode, language, request_id, operation='translation',
        force=previous_id is not None, source_sha256=image.sha256, request_hash_override=signature, result_format=result_format)
    row = db.get(TranslationRequest, (user.id, request_id))
    row.descriptor = {'image': image.model_dump(), 'mode': mode, 'target_language': language,
        'retry_of': str(body.retry_of) if body.retry_of else None,
        'regenerate_of': str(body.regenerate_of) if body.regenerate_of else None,
        'acknowledge_unknown_cost': body.acknowledge_unknown_cost}
    if result_format != 'overlay-v1':
        row.descriptor = {**row.descriptor, 'result_format': result_format}
    if entry.status == 'awaiting_upload':
        create_upload(db, entry, {'sha256': image.sha256, 'byte_size': image.byte_size, 'mime': image.content_type})
    db.flush()
    return row


def response_status(payload):
    return 202 if payload['state'] in {'needs_input', 'queued', 'running', 'needs_attention'} else 200


@router.put('/v1/translations/{translation_id}', response_model=TranslationResponse,
    responses={202: {'model': TranslationResponse}})
def translate(translation_id: UUID, body: TranslationInput, request: Request, user: User = Depends(identity), db: Session = Depends(get_db)):
    owner_id = user.id
    db.rollback()
    token = acquire_control(owner_id)
    try:
        lock_scheduler(db)
        row = accept_translation(db, db.get(User, owner_id), str(translation_id), body)
        # Persist admission before building the client snapshot.
        db.commit()
        result = translation_json(db, row)
        return JSONResponse(result, status_code=response_status(result))
    finally:
        db.rollback()
        release_control(owner_id, token)


def read_snapshot(owner_id, request_ids, *, single=False):
    with session_factory()() as db:
        rows = {row.id: row for row in db.scalars(select(TranslationRequest).where(
            TranslationRequest.owner_id == owner_id, TranslationRequest.id.in_(request_ids)))}
        if single and not rows:
            problem('NOT_FOUND', '找不到此翻译请求', 404)
        context = snapshot_context(db, list(rows.values()))
        items = [translation_json(db, rows[key], context=context) for key in request_ids if key in rows]
        missing = [key for key in request_ids if key not in rows]
        payload = items[0] if single else {'items': items, 'missing_ids': missing}
        etag = '"' + digest({'owner': owner_id, 'ids': request_ids, 'snapshot': payload}) + '"'
        return etag, payload


async def snapshot_response(owner_id, ids, request, *, single=False):
    expected = request.headers.get('if-none-match')
    token = await run_in_threadpool(acquire_control, owner_id, "snapshot")
    try:
        etag, payload = await run_in_threadpool(read_snapshot, owner_id, ids, single=single)
        headers = {'ETag': etag, 'Cache-Control': 'private, no-store'}
        return JSONResponse(payload, headers=headers) if etag != expected else Response(status_code=304, headers=headers)
    finally:
        await run_in_threadpool(release_control, owner_id, token, "snapshot")


def parse_translation_ids(ids):
    try:
        request_ids = list(dict.fromkeys(str(UUID(value)) for value in ids.split(',')))
    except ValueError:
        problem('INVALID_REQUEST', '翻译编号必须为 UUID', 422, fields=[{'path': 'ids', 'code': 'uuid_parsing'}])
    if not 1 <= len(request_ids) <= 32:
        problem('INVALID_REQUEST', '一次最多读取 32 个翻译请求', 422, fields=[{'path': 'ids', 'code': 'too_many_items'}])
    return request_ids


@router.get('/v1/translations/events', response_class=Response, responses={200: {
    'description': 'SSE snapshot events containing TranslationsResponse; end signals completion or reauthentication.',
    'content': {'text/event-stream': {'schema': {'type': 'string'}}}}})
async def translation_event_stream(request: Request, ids: str = Query(..., max_length=1183),
    user: User = Depends(identity), db: Session = Depends(get_db)):
    from .translation_events import translation_events
    owner_id, request_ids = user.id, parse_translation_ids(ids)
    await run_in_threadpool(db.close)
    return await translation_events(owner_id, request_ids, request)


@router.get('/v1/translations', response_model=TranslationsResponse | TranslationHistoryResponse)
async def translations(request: Request, ids: str | None = Query(None, max_length=1183),
    offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100),
    user: User = Depends(identity), db: Session = Depends(get_db)):
    owner_id = user.id
    if ids is None:
        await run_in_threadpool(db.close)
        def history():
            token = acquire_control(owner_id, 'history')
            try:
                query = select(TranslationRequest).where(TranslationRequest.owner_id == owner_id)
                total = db.scalar(select(func.count()).select_from(query.subquery()))
                rows = db.scalars(query.order_by(TranslationRequest.created_at.desc(), TranslationRequest.id).offset(offset).limit(limit))
                result = {'items': translation_page(db, rows), 'total': total,
                    'next_offset': offset + limit if offset + limit < total else None}
                return result
            finally:
                db.close()
                release_control(owner_id, token, 'history')
        return await run_in_threadpool(history)
    request_ids = parse_translation_ids(ids)
    await run_in_threadpool(db.close)
    return await snapshot_response(owner_id, request_ids, request)


@router.get('/v1/translations/{translation_id}', response_model=TranslationResponse)
async def translation_get(translation_id: UUID, request: Request,
    user: User = Depends(identity), db: Session = Depends(get_db)):
    owner_id = user.id
    await run_in_threadpool(db.close)
    return await snapshot_response(owner_id, [str(translation_id)], request, single=True)


@router.put('/v1/translations/{translation_id}/input', response_model=TranslationResponse,
    responses={202: {'model': TranslationResponse}})
async def translation_input(translation_id: UUID, request: Request,
    user: User = Depends(identity), db: Session = Depends(get_db)):
    from .upload_ingress import (Ingress, begin_ingress, finish_thread, keep_ingress_alive,
        persist_received_upload, read_ingress_body, record_body_failure, release_ingress)
    from fastapi import HTTPException
    owner_id, key = user.id, str(translation_id)
    def find_input():
        row = owned_translation(db, owner_id, key)
        entry = db.get(Job, row.job_id) if row.job_id else None
        if unavailable(db, row, entry):
            problem('TRANSLATION_UNAVAILABLE', '翻译访问已撤销或过期', 410)
        receipt = db.scalar(select(UploadReservation).where(UploadReservation.job_id == row.job_id)) if row.job_id else None
        return receipt.id if receipt else None
    upload_id = await run_in_threadpool(find_input)
    await run_in_threadpool(db.close)
    if not upload_id:
        problem('INPUT_NOT_REQUIRED', '此翻译已绑定原图，无需上传', 409)
    admission = await begin_ingress(upload_id, owner_id)
    if isinstance(admission, Ingress):
        stopped, lost = asyncio.Event(), asyncio.Event()
        heartbeat = asyncio.create_task(keep_ingress_alive(admission, stopped, lost))
        data = None
        try:
            try:
                data = await read_ingress_body(request, admission, lost)
            except HTTPException as error:
                await finish_thread(record_body_failure, admission, error)
                raise
            if lost.is_set():
                problem('UPLOAD_LEASE_EXPIRED', '上传连接已失效，请重试', 409)
            await finish_thread(persist_received_upload, admission, data)
        finally:
            if data is not None:
                data.close()
            stopped.set()
            try:
                await asyncio.shield(heartbeat)
            finally:
                await finish_thread(release_ingress, admission)
    _, payload = await run_in_threadpool(read_snapshot, owner_id, [key], single=True)
    return JSONResponse(payload, status_code=response_status(payload))


@router.post('/v1/translations/{translation_id}/cancel', response_model=TranslationResponse)
def translation_cancel(translation_id: UUID, user: User = Depends(identity), db: Session = Depends(get_db)):
    lock_scheduler(db)
    row = owned_translation(db, user.id, translation_id)
    if row.job_id:
        cancel_job(db, db.get(Job, row.job_id))
    db.commit()
    result = translation_json(db, row)
    return result


@router.get('/v1/translations/{translation_id}/classic')
def classic_details(translation_id: UUID, user: User = Depends(identity), db: Session = Depends(get_db)):
    row = owned_translation(db, user.id, translation_id)
    entry = db.get(Job, row.job_id) if row.job_id else None
    if unavailable(db, row, entry):
        problem('TRANSLATION_UNAVAILABLE', '翻译访问已撤销或过期', 410)
    if entry.mode != 'classic':
        problem('MODE_UNSUPPORTED', '此翻译没有常规翻译数据', 422)
    if not entry.input_asset_id:
        problem('INPUT_NOT_READY', '原图尚未上传，请等待服务器受理', 409)
    state = db.get(ClassicState, row.job_id) if row.job_id else None
    if not state:
        return {'segments': [], 'translations': {}, 'artifacts': {}, 'timings': {}}
    return {'segments': (state.analysis or {}).get('segments', []), 'translations': state.translations,
        'unrecognized_regions': (state.analysis or {}).get('unrecognized_regions', []),
        'artifacts': {}, 'timings': state.timings}


@router.get('/v1/translations/{translation_id}/result', response_class=Response, responses={
    200: {'description': 'Authenticated immutable result bytes; original representation has no file.',
        'content': {mime: {'schema': {'type': 'string', 'format': 'binary'}} for mime in (
            'image/webp', 'image/png', 'image/jpeg', 'application/vnd.nodelane.overlay-tiles')}},
    304: {'description': 'Authorized If-None-Match matches the result SHA-256 ETag.'},
    409: {'description': 'Result is not ready or uses original representation.'},
    410: {'description': 'This translation authorization has been revoked.'},
    503: {'description': 'Committed result file is temporarily unavailable; no model call is restarted.'}})
def translation_result(translation_id: UUID, request: Request, user: User = Depends(identity), db: Session = Depends(get_db)):
    row = owned_translation(db, user.id, translation_id)
    entry = db.get(Job, row.job_id) if row.job_id else None
    if unavailable(db, row, entry):
        problem('TRANSLATION_UNAVAILABLE', '翻译访问已撤销', 410)
    if entry.status != 'succeeded' or not entry.output_asset_id:
        problem('RESULT_NOT_AVAILABLE', '此翻译没有结果文件', 409)
    output = db.get(Asset, entry.output_asset_id)
    if not available(output) or output.owner_id != user.id:
        problem('RESULT_UNAVAILABLE', '结果文件暂不可用', 503)
    try:
        handle = object_path(output.storage_key).open('rb')
        import os
        if os.fstat(handle.fileno()).st_size != output.byte_size:
            handle.close()
            problem('RESULT_UNAVAILABLE', '结果文件完整性异常', 503)
    except OSError:
        problem('RESULT_UNAVAILABLE', '结果文件暂不可用', 503)
    headers = {'ETag': '"' + output.sha256 + '"', 'Cache-Control': 'private, no-store',
        'Content-Length': str(output.byte_size), 'X-Content-Type-Options': 'nosniff'}
    try:
        db.commit()
    except BaseException:
        handle.close()
        raise
    if request.headers.get('if-none-match') == headers['ETag']:
        handle.close()
        return Response(status_code=304, headers={key: value for key, value in headers.items() if key != 'Content-Length'})
    def chunks():
        try:
            while chunk := handle.read(256 * 1024):
                yield chunk
        finally:
            handle.close()
    from starlette.background import BackgroundTask
    return StreamingResponse(chunks(), media_type=output.mime, headers=headers, background=BackgroundTask(handle.close))


@router.delete('/v1/translations/{translation_id}')
def translation_delete(translation_id: UUID, user: User = Depends(identity), db: Session = Depends(get_db)):
    lock_scheduler(db)
    row = owned_translation(db, user.id, translation_id)
    row.revoked_at = row.revoked_at or now()
    db.flush()
    other = db.scalar(select(TranslationRequest.id).where(TranslationRequest.owner_id == user.id,
        TranslationRequest.job_id == row.job_id, TranslationRequest.revoked_at.is_(None)).limit(1)) if row.job_id else None
    if not other and row.job_id:
        job = db.get(Job, row.job_id)
        cancel_job(db, job)
        if job.output_asset_id:
            output = db.get(Asset, job.output_asset_id)
            output.deleted_at = output.deleted_at or now()
        touch_job(db, job)
    db.commit()
    # Durable tombstones make interrupted unlink recoverable by maintenance.
    from .dispatcher import cleanup
    cleanup(db)
    return {'deleted': True, 'id': str(translation_id)}
