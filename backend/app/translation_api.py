"""Per-image translation resources, immutable intents and resumable snapshots."""
import asyncio
from datetime import timedelta
import time
from typing import Literal
from uuid import UUID
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from .assets import access_json, available, find_shared_original, record_user_access
from .auth import identity
from .config import settings
from .db import get_db, session_factory
from .errors import problem
from .jobs import cancel_job, create_job
from .languages import Language
from .models import Asset, ClassicState, Job, User, now
from .providers import digest
from .request_models import RequestBody
from .results import ReaderEntry, get_entry
from .scheduler import ACTIVE, lock_scheduler, queue_for, touch_job
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


class TranslationInput(RequestBody):
    image: ImageDescriptor | None = None
    mode: Literal['classic', 'redraw'] | None = None
    target_language: Language | None = None
    retry_of: UUID | None = None
    regenerate_of: UUID | None = None
    acknowledge_unknown_cost: bool = False
    priority: Literal['current', 'prefetch'] = 'current'

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
    if row.revoked_at or entry is None:
        return True
    lookup = (lambda key: assets.get(key)) if assets is not None else (lambda key: db.get(Asset, key))
    if entry.input_asset_id and not available(lookup(entry.input_asset_id)):
        return True
    return bool(entry.output_asset_id and not available(lookup(entry.output_asset_id)))


def snapshot_context(db, rows):
    entries = {entry.id: entry for entry in db.scalars(select(ReaderEntry).where(
        ReaderEntry.id.in_({row.entry_id for row in rows})))} if rows else {}
    asset_ids = {asset_id for entry in entries.values()
        for asset_id in (entry.input_asset_id, entry.output_asset_id) if asset_id}
    assets = {asset.id: asset for asset in db.scalars(select(Asset).where(Asset.id.in_(asset_ids)))} if asset_ids else {}
    awaiting = {entry.id for entry in entries.values() if entry.status == 'awaiting_upload'}
    uploads = {upload.job_id: upload for upload in db.scalars(select(UploadReservation).where(
        UploadReservation.job_id.in_(awaiting)))} if awaiting else {}
    return entries, assets, uploads


def translation_page(db, rows, *, sign=True):
    rows = list(rows)
    context = snapshot_context(db, rows)
    items = [translation_json(db, row, sign=sign, context=context) for row in rows]
    if sign:
        record_snapshot_access(db, items, context)
    return items


def record_snapshot_access(db, items, context):
    # Batches may request the same images in opposite orders. Take all image
    # update locks in one global order, including their shared source grants.
    ids = {asset_id for item in items if item['state'] == 'succeeded' and item['result']['asset_id']
        for asset_id in (item['input_asset_id'], item['result']['asset_id']) if asset_id}
    for asset_id in sorted(ids):
        record_user_access(db, context[1][asset_id])


def translation_json(db, row, *, sign=True, context=None):
    entry = context[0].get(row.entry_id) if context else get_entry(db, row.entry_id)
    assets = context[1] if context else None
    asset_for = (lambda key: assets.get(key)) if assets is not None else (lambda key: db.get(Asset, key))
    descriptor = row.descriptor or {}
    state = ('needs_input' if entry.status == 'awaiting_upload' else
        'needs_attention' if entry.status in {'outcome_unknown', 'unknown_released'} else
        'succeeded' if entry.status in {'succeeded', 'no_text'} else
        'failed' if entry.status in {'failed', 'cancelled'} else
        'running' if entry.status == 'running' and entry.phase != 'validate_upload' else 'queued') if entry else 'failed'
    error = ({'code': entry.error_code, 'message': entry.error_message or '翻译失败'} if entry and entry.error_code else None)
    if unavailable(db, row, entry, assets):
        state, error = 'failed', {'code': 'TRANSLATION_UNAVAILABLE', 'message': '翻译访问已撤销或过期'}
    elif state == 'failed' and error is None:
        error = {'code': 'TRANSLATION_CANCELLED', 'message': '翻译已取消'}
    upload = (context[2].get(row.job_id) if context else db.scalar(select(UploadReservation).where(UploadReservation.job_id == row.job_id))) if state == 'needs_input' else None
    result = None
    if state == 'succeeded':
        output = asset_for(entry.output_asset_id) if entry.output_asset_id else None
        result = {'kind': 'no_text' if entry.status == 'no_text' else 'partial' if 'unrecognized_regions' in (entry.quality_flags or []) else 'translated',
            'asset_id': output.id if output else None, 'width': output.width if output else None,
            'height': output.height if output else None, 'download_url': None, 'download_expires_at': None,
            'authorization_required': False, 'quality_flags': entry.quality_flags or []}
        if sign and output:
            access = access_json(output)
            result.update(download_url=access['url'], download_expires_at=access['expires_at'],
                authorization_required=access['authorization_required'])
            if context is None:
                for asset in sorted((output, asset_for(entry.input_asset_id)), key=lambda value: value.id):
                    record_user_access(db, asset)
    return {'id': row.id, 'state': state,
        'mode': entry.mode if entry else descriptor['mode'],
        'target_language': entry.target_language if entry else descriptor['target_language'],
        'image_sha256': entry.source_sha256 if entry else descriptor['image']['sha256'],
        'input_asset_id': entry.input_asset_id if entry and state != 'failed' else None,
        'input_expires_at': iso(upload.expires_at) if upload else None,
        'result': result, 'error': error, 'created_at': iso(row.created_at),
        'updated_at': iso(row.revoked_at or (entry.changed_at if entry else row.created_at))}


def apply_priority(db, job, priority):
    if not isinstance(job, Job) or job.status not in ACTIVE - {'outcome_unknown'}:
        return
    desired = 0 if priority == 'current' else 1
    # Initial hint and the one-way prefetch promotion each have a bounded lifetime.
    # Replaying a current request never renews its priority.
    if job.priority_rank > desired:
        job.priority_rank = desired
        job.realtime_until = now() + timedelta(seconds=settings().priority_ttl_seconds)
        queue_for(db, job.owner_id, job.mode).version += 1
        touch_job(db, job)


def accept_translation(db, user, request_id, body):
    signature = digest(body.model_dump(mode='json', exclude={'priority'}))
    old = db.get(TranslationRequest, (user.id, request_id))
    if old:
        if old.request_hash != signature:
            problem('IDEMPOTENCY_CONFLICT', '请求编号已绑定其他翻译内容', 409)
        entry = get_entry(db, old.entry_id)
        if unavailable(db, old, entry):
            problem('TRANSLATION_UNAVAILABLE', '翻译访问已撤销或过期', 410)
        apply_priority(db, entry, body.priority)
        return old
    image, mode, language = body.image, body.mode, body.target_language
    previous_id = body.retry_of or body.regenerate_of
    if previous_id:
        previous = owned_translation(db, user.id, previous_id)
        entry = get_entry(db, previous.entry_id)
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
    if image.byte_size > settings().max_upload_bytes:
        problem('IMAGE_TOO_LARGE', '图片大小超过限制', 413)
    asset = find_shared_original(db, user.id, image.sha256, byte_size=image.byte_size, mime=image.content_type)
    entry = create_job(db, user, asset, mode, language, request_id, operation='translation',
        force=previous_id is not None, source_sha256=image.sha256, request_hash_override=signature)
    row = db.get(TranslationRequest, (user.id, request_id))
    row.descriptor = {'image': image.model_dump(), 'mode': mode, 'target_language': language,
        'retry_of': str(body.retry_of) if body.retry_of else None,
        'regenerate_of': str(body.regenerate_of) if body.regenerate_of else None,
        'acknowledge_unknown_cost': body.acknowledge_unknown_cost}
    if isinstance(entry, Job) and entry.status == 'awaiting_upload':
        create_upload(db, entry, {'sha256': image.sha256, 'byte_size': image.byte_size, 'mime': image.content_type})
    apply_priority(db, entry, body.priority)
    db.flush()
    return row


def response_status(payload):
    return 202 if payload['state'] in {'needs_input', 'queued', 'running', 'needs_attention'} else 200


@router.put('/v1/translations/{translation_id}', response_model=TranslationResponse,
    responses={202: {'model': TranslationResponse}})
def translate(translation_id: UUID, body: TranslationInput, user: User = Depends(identity), db: Session = Depends(get_db)):
    owner_id = user.id
    db.rollback()
    token = acquire_control(owner_id)
    try:
        lock_scheduler(db)
        row = accept_translation(db, db.get(User, owner_id), str(translation_id), body)
        # Commit admission before generating delivery URLs; URL errors must not
        # lose an already accepted request or its frozen configuration.
        db.commit()
        result = translation_json(db, row)
        db.commit()
        return JSONResponse(result, status_code=response_status(result))
    finally:
        db.rollback()
        release_control(owner_id, token)


def read_snapshot(owner_id, request_ids, expected_etag=None, *, single=False):
    with session_factory()() as db:
        rows = {row.id: row for row in db.scalars(select(TranslationRequest).where(
            TranslationRequest.owner_id == owner_id, TranslationRequest.id.in_(request_ids)))}
        if single and not rows:
            problem('NOT_FOUND', '找不到此翻译请求', 404)
        context = snapshot_context(db, list(rows.values()))
        items = [translation_json(db, rows[key], sign=False, context=context) for key in request_ids if key in rows]
        missing = [key for key in request_ids if key not in rows]
        payload = items[0] if single else {'items': items, 'missing_ids': missing}
        etag = '"' + digest({'owner': owner_id, 'ids': request_ids, 'snapshot': payload}) + '"'
        if expected_etag != etag:
            items = [translation_json(db, rows[key], context=context) for key in request_ids if key in rows]
            payload = items[0] if single else {'items': items, 'missing_ids': missing}
            record_snapshot_access(db, items, context)
            db.commit()
        return etag, payload


async def wait_snapshot(owner_id, ids, request, wait_seconds, *, single=False):
    from .notifications import changed, hub
    expected = request.headers.get('if-none-match')
    end = time.monotonic() + wait_seconds
    token = await run_in_threadpool(acquire_control, owner_id, "snapshot")
    try:
        with hub().subscribe('user:' + owner_id) as wake:
            while True:
                wake.clear()
                etag, payload = await run_in_threadpool(read_snapshot, owner_id, ids, expected, single=single)
                headers = {'ETag': etag, 'Cache-Control': 'private, no-store'}
                if etag != expected:
                    return JSONResponse(payload, headers=headers)
                if time.monotonic() >= end:
                    return Response(status_code=304, headers=headers)
                await changed(wake, end - time.monotonic())
    finally:
        await run_in_threadpool(release_control, owner_id, token, "snapshot")


@router.get('/v1/translations', response_model=TranslationsResponse | TranslationHistoryResponse)
async def translations(request: Request, ids: str | None = Query(None, max_length=1183),
    wait_seconds: float = Query(0, ge=0, le=20, allow_inf_nan=False),
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
                db.commit()
                return result
            finally:
                db.close()
                release_control(owner_id, token, 'history')
        return await run_in_threadpool(history)
    try:
        request_ids = list(dict.fromkeys(str(UUID(value)) for value in ids.split(',')))
    except ValueError:
        problem('INVALID_REQUEST', '翻译编号必须为 UUID', 422, fields=[{'path': 'ids', 'code': 'uuid_parsing'}])
    if not 1 <= len(request_ids) <= 32:
        problem('INVALID_REQUEST', '一次最多读取 32 个翻译请求', 422, fields=[{'path': 'ids', 'code': 'too_many_items'}])
    await run_in_threadpool(db.close)
    return await wait_snapshot(owner_id, request_ids, request, wait_seconds)


@router.get('/v1/translations/{translation_id}', response_model=TranslationResponse)
async def translation_get(translation_id: UUID, request: Request,
    wait_seconds: float = Query(0, ge=0, le=20, allow_inf_nan=False),
    user: User = Depends(identity), db: Session = Depends(get_db)):
    owner_id = user.id
    await run_in_threadpool(db.close)
    return await wait_snapshot(owner_id, [str(translation_id)], request, wait_seconds, single=True)


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
        entry = get_entry(db, row.entry_id)
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
            stopped.set()
            try:
                await asyncio.shield(heartbeat)
            finally:
                await finish_thread(release_ingress, admission)
    _, payload = await run_in_threadpool(read_snapshot, owner_id, [key], None, single=True)
    return JSONResponse(payload, status_code=response_status(payload))


@router.post('/v1/translations/{translation_id}/cancel', response_model=TranslationResponse)
def translation_cancel(translation_id: UUID, user: User = Depends(identity), db: Session = Depends(get_db)):
    lock_scheduler(db)
    row = owned_translation(db, user.id, translation_id)
    if row.job_id:
        cancel_job(db, db.get(Job, row.job_id))
    db.commit()
    result = translation_json(db, row)
    db.commit()
    return result


@router.get('/v1/translations/{translation_id}/classic')
def classic_details(translation_id: UUID, user: User = Depends(identity), db: Session = Depends(get_db)):
    row = owned_translation(db, user.id, translation_id)
    entry = get_entry(db, row.entry_id)
    if unavailable(db, row, entry):
        problem('TRANSLATION_UNAVAILABLE', '翻译访问已撤销或过期', 410)
    if entry.mode != 'classic':
        problem('MODE_UNSUPPORTED', '此翻译没有常规翻译数据', 422)
    if not entry.input_asset_id:
        problem('INPUT_NOT_READY', '原图尚未上传，请等待服务器受理', 409)
    # Cached grants never reveal another account's private OCR text.
    state = db.get(ClassicState, row.job_id) if row.job_id else None
    if not state:
        return {'segments': [], 'translations': {}, 'artifacts': {}, 'timings': {}}
    return {'segments': (state.analysis or {}).get('segments', []), 'translations': state.translations,
        'unrecognized_regions': (state.analysis or {}).get('unrecognized_regions', []),
        'artifacts': {}, 'timings': state.timings}
