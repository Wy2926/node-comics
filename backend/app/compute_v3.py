"""Whole-page compute leases. Image work stays on the node; text stays here."""
import asyncio
from datetime import datetime, timedelta
import hmac
import random
from typing import Annotated, Literal
import time

from fastapi import APIRouter, Depends, Response, Request, Header, HTTPException
from starlette.responses import StreamingResponse
from starlette.datastructures import UploadFile
from pydantic import ValidationError, model_validator
from PIL import Image
import hashlib
from starlette.concurrency import run_in_threadpool
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .assets import available, asset_storage_key, create_asset
from .classic import validate_analysis
from .node_auth import node_auth
from .config import settings
from .db import get_db, session_factory
from .errors import ProcessingError, problem
from .languages import Language, LANGUAGES
from .models import Asset, Attempt, ClassicState, Job, now
from .node_config import NodeConfig
from .providers import digest
from .queue_models import ComputeClaim, ComputeNode, ExecutionLease, JobStage
from .request_models import RequestBody
from .scheduler import (claim_batch, current_lease, effective_languages, has_claimable_work, heartbeat_lease, lock_scheduler,
                        prepare_claim_candidates, release_lease, remaining_capacity, touch_job)
from .storage import get_store
from .workers import fail_stage, finish_job


def no_store(response: Response):
    response.headers['Cache-Control'] = 'no-store'


router = APIRouter(prefix='/internal/compute/v3', tags=['compute v3'], dependencies=[Depends(no_store)])


def stamp(value):
    return value.isoformat() + 'Z'


def parsed(value):
    return datetime.fromisoformat(value.removesuffix('Z'))


def config_payload(node):
    config = NodeConfig.model_validate(node.desired_config)
    keys = ('execution_slots', 'poll_seconds', 'heartbeat_seconds',
            'request_seconds', 'page_seconds', 'text_wait_seconds', 'delivery_seconds', 'allowed_languages')
    return {'version': node.config_version, 'enabled': node.enabled,
            **{key: getattr(config, key) for key in keys}}


def scoped_node(db, identity, node_id=None):
    if node_id is not None and identity != node_id:
        problem('NODE_SCOPE_MISMATCH', '节点身份不匹配', 403)
    return db.get(ComputeNode, identity, populate_existing=True)


def scoped_lease(db, lease_id, token, identity):
    lease = db.get(ExecutionLease, lease_id)
    if not lease or lease.node_id != identity or not hmac.compare_digest(lease.token, token):
        problem('NODE_SCOPE_MISMATCH', '租约未授权给此节点', 403)
    if db.get(JobStage, lease.stage_id).name != 'page':
        problem('PROTOCOL_MISMATCH', '此租约不属于整页协议', 409)
    return lease


def live_lease(db, lease_id, token, identity):
    scoped_lease(db, lease_id, token, identity)
    lease, stage, job = current_lease(db, lease_id, token)
    if not available(db.get(Asset, job.input_asset_id)):
        raise ProcessingError('ASSET_EXPIRED', '原图访问已失效')
    deadline = lease_deadline(db, lease)
    if deadline <= now():
        raise ProcessingError('PAGE_DEADLINE_EXCEEDED', '整页任务已达到处理时限')
    return lease, stage, job


def lease_deadline(db, lease):
    limits = lease.limits
    deadline = parsed(limits['deadline_at'])
    if limits.get('delivery_deadline_at'):
        deadline = min(deadline, parsed(limits['delivery_deadline_at']))
    state = db.get(ClassicState, lease.job_id)
    text = db.scalar(select(JobStage).where(JobStage.job_id == lease.job_id, JobStage.name == 'text'))
    if state and state.analysis and text and text.status != 'succeeded':
        accepted = (state.artifacts or {}).get('analysis_accepted_at')
        if accepted:
            deadline = min(deadline, parsed(accepted) + timedelta(seconds=limits['text_wait_seconds']))
    return deadline


def input_descriptor(db, lease, source):
    return {'path': f'/internal/compute/v3/leases/{lease.id}/input',
            'sha256': source.sha256, 'byte_size': source.byte_size, 'mime': source.mime,
            'width': source.width, 'height': source.height, 'normalization_version': source.normalization_version}


def translations_payload(db, job_id):
    state = db.get(ClassicState, job_id)
    text = db.scalar(select(JobStage).where(JobStage.job_id == job_id, JobStage.name == 'text'))
    if not state or not state.analysis or not text or text.status != 'succeeded':
        return None
    job = db.get(Job, job_id)
    result = {'analysis_hash': digest(state.analysis), 'language': job.target_language,
              'translations': state.translations}
    return {**result, 'revision': digest(result)}


def receipt(lease):
    return (lease.limits or {}).get('receipt') or {
        'lease_id': lease.id, 'status': 'terminal', 'outcome': lease.outcome,
        'result_hash': lease.result_hash, 'completed_at': stamp(lease.completed_at)}


def lease_payload(db, lease):
    if lease.completed_at:
        return receipt(lease)
    try:
        _, _, job = live_lease(db, lease.id, lease.token, lease.node_id)
    except ProcessingError as error:
        return {'lease_id': lease.id, 'lease_token': lease.token, 'status': 'stop', 'code': error.code}
    source = db.get(Asset, job.input_asset_id)
    state = db.get(ClassicState, job.id)
    analysis = state.analysis if state else None
    return {'lease_id': lease.id, 'lease_token': lease.token, 'job_id': job.id, 'generation': lease.generation,
            'status': 'active', 'expires_at': stamp(lease.expires_at), 'limits': lease.limits,
            'input': input_descriptor(db, lease, source), 'config': {'engine': job.config['engine']},
            'language': job.target_language, 'analysis': analysis,
            'analysis_hash': digest(analysis) if analysis else None,
            'translations': translations_payload(db, job.id)}


class Registration(RequestBody):
    protocol_version: Literal[3]
    engine_version: str = Field(min_length=1, max_length=120)
    resource_id: str = Field(min_length=1, max_length=120)
    device: str = Field(min_length=1, max_length=80)
    supported_languages: list[Language] = Field(min_length=1, max_length=16)
    ready: bool


@router.post('/nodes/register')
def register(body: Registration, identity=Depends(node_auth), db: Session = Depends(get_db)):
    lock_scheduler(db)
    node = scoped_node(db, identity)
    if body.resource_id != node.resource_id or body.engine_version == 'control':
        problem('NODE_RESOURCE_MISMATCH', '节点资源或引擎身份不匹配', 409)
    leases = list(db.scalars(select(ExecutionLease).where(
        ExecutionLease.node_id == identity, ExecutionLease.completed_at.is_(None))))
    node.engine_version, node.device = body.engine_version, body.device
    node.capabilities = ['page'] if body.ready else []
    allowed = config_payload(node)['allowed_languages']
    node.supported_languages = [lang for lang in dict.fromkeys(body.supported_languages) if lang in allowed]
    node.runtime_report = {'protocol_version': 3, 'ready': body.ready, 'languages': body.supported_languages}
    node.applied_config_version, node.config_error, node.heartbeat_at = node.config_version, None, now()
    result = {'protocol_version': 3, 'config': config_payload(node), 'server_time': stamp(now()),
              'leases': [lease_payload(db, lease) for lease in leases]}
    db.commit()
    return result


class ClaimRequest(RequestBody):
    request_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    config_version: int = Field(ge=1, strict=True)
    count: int = Field(ge=1, le=32, strict=True)


@router.post('/nodes/{node_id}/claim')
def claim(node_id: str, body: ClaimRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    node = scoped_node(db, identity, node_id)
    request_hash = digest(body.model_dump())
    candidate_needed = True
    for attempt in range(2):
        # Receipt replay and known configuration conflicts need no queue election.
        saved = db.get(ComputeClaim, (identity, body.request_id))
        prepared = (prepare_claim_candidates(db, identity, ['page'], limit=body.count)
            if candidate_needed and not saved and node.config_version == body.config_version else None)
        lock_scheduler(db)
        node = scoped_node(db, identity, node_id)
        if node.runtime_report.get('protocol_version') != 3:
            problem('PROTOCOL_MISMATCH', '请先注册整页协议', 409)
        saved = db.get(ComputeClaim, (identity, body.request_id), populate_existing=True)
        if saved:
            if saved.request_hash != request_hash:
                problem('CLAIM_CONFLICT', '同一领取编号不能修改内容', 409)
            leases = [db.get(ExecutionLease, key) for key in saved.lease_ids]
            break
        if body.config_version != node.config_version:
            problem('NODE_CONFIG_CONFLICT', '领取前需要同步配置', 409)
        node.supported_languages = effective_languages(node)
        leases = (claim_batch(db, identity, ['page'], limit=body.count,
                             config_version=body.config_version, prepared=prepared) if prepared else [])
        if not leases and prepared and prepared.signatures and attempt == 0 and remaining_capacity(db, node):
            # Other nodes may have taken the entire bounded snapshot. Release
            # the mutex before one fresh election, preserving any invalid-source
            # cleanup. No lease or receipt exists for this request yet. Recheck
            # its receipt/version next time: a concurrent replay may win meanwhile.
            db.commit()
            candidate_needed = has_claimable_work(db, identity, ['page'], config_version=body.config_version)
            continue
        db.add(ComputeClaim(node_id=identity, request_id=body.request_id,
                            request_hash=request_hash, lease_ids=[lease.id for lease in leases]))
        break
    result = {'request_id': body.request_id, 'server_time': stamp(now()),
              'config': config_payload(node), 'leases': [lease_payload(db, lease) for lease in leases]}
    db.commit()
    if not leases:
        # A competing claimant may have consumed this bounded snapshot while
        # other pages remain ready. Recheck after releasing the receipt lock;
        # the hint authorizes no work and never changes the durable receipt.
        with session_factory()() as ready_db:
            if has_claimable_work(ready_db, identity, ['page'], config_version=body.config_version):
                result['retry_after_seconds'] = round(random.uniform(.1, .3), 3)
    return result


class LeaseRequest(RequestBody):
    lease_token: str = Field(min_length=1, max_length=64)


class UpdateLease(LeaseRequest):
    lease_id: str = Field(min_length=1, max_length=36)
    translations_revision: str | None = Field(default=None, max_length=64)


class UpdatesRequest(RequestBody):
    revision: int = Field(default=0, ge=0, strict=True)
    wait_seconds: float = Field(default=20, ge=0, le=20, allow_inf_nan=False)
    config_version: int = Field(ge=1, strict=True)
    can_claim: bool = Field(strict=True)
    leases: list[UpdateLease] = Field(max_length=32)


def lease_updates(db, identity, items):
    """Read fenced text/terminal changes without renewing or authorizing input."""
    replies = []
    for item in items:
        lease = db.get(ExecutionLease, item.lease_id)
        stage = db.get(JobStage, lease.stage_id) if lease and lease.node_id == identity else None
        if (not stage or stage.name != 'page' or not hmac.compare_digest(lease.token, item.lease_token)):
            replies.append({'lease_id': item.lease_id, 'status': 'stop', 'code': 'NODE_SCOPE_MISMATCH'})
            continue
        if lease.completed_at:
            replies.append(receipt(lease))
            continue
        try:
            _, _, job = live_lease(db, lease.id, item.lease_token, identity)
        except ProcessingError as error:
            replies.append({'lease_id': lease.id, 'status': 'stop', 'code': error.code})
            continue
        translated = translations_payload(db, job.id)
        if translated and translated['revision'] != item.translations_revision:
            replies.append({'lease_id': lease.id, 'status': 'active', 'translations': translated})
    return replies


@router.post('/nodes/{node_id}/updates')
async def updates(node_id: str, body: UpdatesRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    scoped_node(db, identity, node_id)
    await run_in_threadpool(db.close)
    from .notifications import hub, changed
    from .queue_models import SchedulerMutex
    known_leases = {item.lease_id for item in body.leases}

    def snapshot():
        with session_factory()() as session:
            node = scoped_node(session, identity, node_id)
            config = config_payload(node) if node.config_version != body.config_version else None
            claimable = bool(not config and has_claimable_work(
                session, identity, ['page'], config_version=body.config_version))
            result = {'revision': session.get(SchedulerMutex, 1).revision,
                      'claim_ready': body.can_claim and claimable, 'leases': lease_updates(session, identity, body.leases)}
            if config:
                result['config'] = config
            active_leases = set(session.scalars(select(ExecutionLease.id).join(
                JobStage, JobStage.id == ExecutionLease.stage_id).where(
                    ExecutionLease.node_id == identity, ExecutionLease.completed_at.is_(None), JobStage.name == 'page')))
            return result, active_leases != known_leases, claimable

    end = time.monotonic() + body.wait_seconds
    initial_claimable = None
    with hub().subscribe('compute') as wake:
        while True:
            wake.clear()
            result, leases_changed, claimable = await run_in_threadpool(snapshot)
            queue_changed = initial_claimable is not None and initial_claimable != claimable
            if (leases_changed or queue_changed or result['claim_ready'] or result['leases']
                    or 'config' in result or time.monotonic() >= end):
                return result
            initial_claimable = claimable
            # A concurrent claim can add leases after this request's snapshot;
            # finish that poll so the node can subscribe with their tokens.
            # A real queue edge also refreshes a stale can_claim=False snapshot
            # after local buffers free. A steady backlog never spins that poll.
            # A global change is only a hint to reread; unrelated work must not
            # create an immediate heartbeat/claim round trip on every node.
            await changed(wake, end - time.monotonic())


class HeartbeatItem(UpdateLease):
    phase: Literal['queued', 'download', 'analyze', 'inpaint', 'text', 'render', 'deliver', 'stopped'] = 'queued'


class HeartbeatRequest(RequestBody):
    config_version: int = Field(ge=1, strict=True)
    leases: list[HeartbeatItem] = Field(max_length=32)


@router.post('/nodes/{node_id}/heartbeat')
def heartbeat(node_id: str, body: HeartbeatRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    lock_scheduler(db)
    node = scoped_node(db, identity, node_id)
    node.heartbeat_at = now()
    replies = []
    for item in body.leases:
        lease = db.get(ExecutionLease, item.lease_id)
        if (not lease or lease.node_id != identity or not hmac.compare_digest(lease.token, item.lease_token)
                or db.get(JobStage, lease.stage_id).name != 'page'):
            replies.append({'lease_id': item.lease_id, 'status': 'stop', 'code': 'NODE_SCOPE_MISMATCH'})
            continue
        if lease.completed_at:
            replies.append(receipt(lease))
            continue
        try:
            _, _, job = live_lease(db, lease.id, item.lease_token, identity)
            heartbeat_lease(db, lease.id, item.lease_token)
            lease.expires_at = (parsed(lease.limits['delivery_persist_deadline_at'])
                if accepted_delivery(lease) else min(lease.expires_at, lease_deadline(db, lease)))
        except ProcessingError as error:
            # One rejected item must not roll back unrelated renewals.
            replies.append({'lease_id': lease.id, 'status': 'stop', 'code': error.code})
            continue
        reply = {'lease_id': lease.id, 'status': 'active', 'expires_at': stamp(lease.expires_at)}
        translated = translations_payload(db, job.id)
        if translated and translated['revision'] != item.translations_revision:
            reply['translations'] = translated
        replies.append(reply)
    result = {'server_time': stamp(now()), 'leases': replies, 'config': config_payload(node)}
    db.commit()
    return result


class AnalysisRequest(LeaseRequest):
    analysis_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    analysis: dict


@router.post('/leases/{lease_id}/analysis')
def analysis(lease_id: str, body: AnalysisRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    lease = scoped_lease(db, lease_id, body.lease_token, identity)
    job = db.get(Job, lease.job_id)
    source = db.get(Asset, job.input_asset_id)
    if digest(body.analysis) != body.analysis_hash:
        problem('ANALYSIS_HASH_MISMATCH', '分析摘要不匹配', 422)
    if body.analysis.get('version') != job.config['engine']['version'] or body.analysis.get('input_hash') != source.sha256:
        problem('ENGINE_RESULT_MISMATCH', '分析与输入或配置版本不一致', 422)
    validate_analysis(body.analysis, source.width, source.height)  # Decode outside scheduler locks.
    db.rollback()
    lock_scheduler(db)
    lease = scoped_lease(db, lease_id, body.lease_token, identity)
    stage = db.get(JobStage, lease.stage_id)
    state = db.get(ClassicState, lease.job_id)
    # A completed no-text submission can retrieve its original receipt.
    if lease.completed_at and lease.outcome == 'succeeded' and state and state.analysis == body.analysis:
        return {'analysis_hash': body.analysis_hash, 'receipt': receipt(lease)}
    _, _, job = live_lease(db, lease_id, body.lease_token, identity)
    if state.analysis:
        if digest(state.analysis) != body.analysis_hash:
            problem('ANALYSIS_CONFLICT', '已持久化的分析不可替换', 409)
    else:
        state.analysis, state.timings = body.analysis, body.analysis.get('timings', {})
        state.artifacts = {'analysis_accepted_at': stamp(now())}
        stage.result = {'analysis_hash': body.analysis_hash, 'analysis_generation': lease.generation}
        if not body.analysis['segments']:
            finish_job(db, job, 'no_text')
            stage.status, stage.completed_at = 'succeeded', now()
            lease.result_hash = body.analysis_hash
            release_lease(db, lease, 'succeeded')
        else:
            text = db.scalar(select(JobStage).where(JobStage.job_id == job.id, JobStage.name == 'text'))
            text.status = 'ready'
            job.phase = 'text'
        touch_job(db, job)
    result = {'analysis_hash': body.analysis_hash, 'receipt': receipt(lease) if lease.completed_at else None}
    db.commit()
    return result


@router.get('/leases/{lease_id}/input')
def read_input(lease_id: str, x_lease_token: str = Header(max_length=64,
               description='Current lease token; also requires the node Authorization and X-Node-Id headers.'),
               identity=Depends(node_auth), db: Session = Depends(get_db)):
    lock_scheduler(db)
    lease, _, job = live_lease(db, lease_id, x_lease_token, identity)
    source = db.get(Asset, job.input_asset_id)
    try:
        handle = get_store().path(source.storage_key).open('rb')
    except OSError:
        raise ProcessingError('INPUT_UNAVAILABLE', '临时原图不可用，请恢复输入') from None
    mime, size = source.mime, source.byte_size
    try:
        db.commit()
    except BaseException:
        handle.close()
        raise

    def chunks():
        try:
            while chunk := handle.read(64 * 1024):
                yield chunk
        finally:
            handle.close()
    return StreamingResponse(chunks(), media_type=mime,
                             headers={'Content-Length': str(size), 'Cache-Control': 'private, no-store'})


ErrorCode = Literal['LEASE_STOPPED', 'ENGINE_UNAVAILABLE', 'CLASSIC_LOCAL_INTERRUPTED',
    'INPUT_INVALID', 'INPUT_HASH_MISMATCH', 'INPUT_UNAVAILABLE', 'STORAGE_AUTH_FAILED', 'STORAGE_UNAVAILABLE',
    'CLASSIC_ANALYZE_FAILED', 'CLASSIC_INPAINT_FAILED', 'CLASSIC_RENDER_FAILED',
    'ENGINE_VERSION_MISMATCH', 'TEXT_DEADLINE_EXCEEDED', 'DELIVERY_DEADLINE_EXCEEDED', 'PAGE_DEADLINE_EXCEEDED']


class NodeError(RequestBody):
    code: ErrorCode


class OutputInfo(RequestBody):
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    byte_size: int = Field(ge=1, le=128 * 1024 * 1024, strict=True)
    width: int = Field(ge=1, le=8192, strict=True)
    height: int = Field(ge=1, le=8192, strict=True)
    mime: Literal['image/webp']


class BBox(RequestBody):
    x: int = Field(ge=0, strict=True)
    y: int = Field(ge=0, strict=True)
    width: int = Field(ge=1, strict=True)
    height: int = Field(ge=1, strict=True)


class PageResult(RequestBody):
    version: str = Field(min_length=1, max_length=120)
    input_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    analysis_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    translations_revision: str = Field(pattern=r'^[a-f0-9]{64}$')
    representation: Literal['overlay-v1', 'original']
    normalization_version: Literal[1]
    width: int = Field(ge=1, le=8192, strict=True)
    height: int = Field(ge=1, le=8192, strict=True)
    bbox: BBox | None
    output: OutputInfo | None

    @model_validator(mode='after')
    def shape(self):
        if self.representation == 'original':
            if self.bbox is not None or self.output is not None:
                raise ValueError('Original representation must not have an artifact')
        elif (self.bbox is None or self.output is None
              or self.bbox.x + self.bbox.width > self.width
              or self.bbox.y + self.bbox.height > self.height
              or (self.bbox.width, self.bbox.height) != (self.output.width, self.output.height)):
            raise ValueError('Overlay bounds must match the artifact and input canvas')
        return self


Timings = dict[Literal['download', 'download_queue', 'analyze', 'analyze_queue', 'inpaint',
    'inpaint_queue', 'render', 'render_queue', 'analysis_submit', 'text_wait', 'local_total', 'output_put'],
    Annotated[float, Field(ge=0, le=86400, allow_inf_nan=False)]]


class OutputRequest(LeaseRequest):
    result: PageResult
    timings: Timings = Field(default_factory=dict)


def result_multipart_schema():
    """Describe the JSON string without duplicating its validation model."""
    schema = OutputRequest.model_json_schema()
    definitions = schema.pop('$defs', {})

    def inline(value):
        if isinstance(value, list):
            return [inline(item) for item in value]
        if isinstance(value, dict):
            if '$ref' in value:
                return inline(definitions[value['$ref'].removeprefix('#/$defs/')])
            return {key: inline(item) for key, item in value.items()}
        return value

    return {'type': 'object', 'additionalProperties': False, 'required': ['metadata'], 'properties': {
        'metadata': {'type': 'string', 'contentMediaType': 'application/json', 'contentSchema': inline(schema),
            'description': 'JSON-encoded OutputRequest: lease_token, result and optional timings; at most 64 KiB.'},
        'output': {'type': 'string', 'format': 'binary',
            'description': 'Lossless WebP overlay; required for overlay-v1 and forbidden for original.'}}}


def validate_result(db, job, result):
    source = db.get(Asset, job.input_asset_id)
    if (result['input_hash'] != source.sha256 or result['version'] != job.config['engine']['version']
            or result['normalization_version'] != source.normalization_version):
        problem('ENGINE_RESULT_MISMATCH', '结果与输入或引擎版本不一致', 409)
    if ((result['width'], result['height']) != (source.width, source.height)
            or result['width'] * result['height'] > settings().max_pixels
            or max(result['width'], result['height']) > settings().max_dimension
            or result['output'] and result['output']['byte_size'] > settings().cluster_max_result_bytes):
        problem('INVALID_PROVIDER_OUTPUT', '结果元数据超出图片限制', 422)
    translated = translations_payload(db, job.id)
    if (not translated or result['analysis_hash'] != translated['analysis_hash']
            or result['translations_revision'] != translated['revision']):
        problem('TRANSLATIONS_MISMATCH', '结果未绑定当前分析与译文版本', 409)


def verify_output(handle, result):
    info = result['output']
    if info is None:
        if handle is not None:
            problem('INVALID_PROVIDER_OUTPUT', '原图表示不能包含文件', 422)
        return
    if handle is None:
        problem('INVALID_PROVIDER_OUTPUT', '缺少覆盖文件', 422)
    handle.seek(0)
    sha, size = hashlib.sha256(), 0
    while chunk := handle.read(64 * 1024):
        size += len(chunk)
        if size > min(info['byte_size'], settings().cluster_max_result_bytes):
            problem('INVALID_PROVIDER_OUTPUT', '结果长度超过声明或限制', 422)
        sha.update(chunk)
    if size != info['byte_size'] or sha.hexdigest() != info['sha256']:
        problem('RESULT_HASH_MISMATCH', '结果字节与冻结摘要不符', 422)
    handle.seek(0)
    try:
        with Image.open(handle) as decoded:
            if (decoded.format != 'WEBP' or decoded.size != (info['width'], info['height'])
                    or getattr(decoded, 'n_frames', 1) != 1 or decoded.width * decoded.height > settings().max_pixels):
                raise ValueError('Invalid overlay image')
            decoded.load()
            if decoded.mode != 'RGBA':
                # Fully covered rectangular patches can be encoded as RGB.
                decoded = decoded.convert('RGBA')
            histogram = decoded.getchannel('A').histogram()
            if any(histogram[1:255]) or not histogram[255]:
                raise ValueError('Overlay alpha must be a nonempty binary replacement mask')
    except (OSError, ValueError, Image.DecompressionBombError):
        problem('INVALID_PROVIDER_OUTPUT', '覆盖文件格式或透明度无效', 422)
    handle.seek(0)


def commit_result(db, lease, stage, job, result, timings):
    """Only called with the scheduler lock and verified durable artifact bytes."""
    validate_result(db, job, result)
    if result['output'] is not None:
        output = create_asset(db, job.owner_id, b'', kind='classic', parent_id=job.input_asset_id,
            stable_id=lease.id, prewritten=True, verified_info=result['output'],
            representation=result['representation'], bbox=result['bbox'], normalization_version=1,
            storage_key=lease.output_key)
        job.output_asset_id = output.id
    job.result_description = result
    state = db.get(ClassicState, job.id)
    job.quality_flags = (state.analysis or {}).get('quality_flags', [])
    stage.status, stage.completed_at = 'succeeded', now()
    finish_job(db, job, 'succeeded')
    release_lease(db, lease, 'succeeded')
    touch_job(db, job)
    state.timings = {'node': timings, 'delivery': {'protocol': 3}}
    return receipt(lease)


def accepted_delivery(lease):
    """Only a fully verified body received before its frozen cutoff may publish.

    This receipt is committed before writing the immutable artifact. Disk fsync
    and the final SQL transaction may finish later, without making a late body
    valid or leaving a file-before-receipt crash window.
    """
    limits = lease.limits or {}
    try:
        received = parsed(limits['delivery_received_at'])
        cutoff = min(parsed(limits['delivery_accept_deadline_at']), parsed(limits['deadline_at']),
                     parsed(limits['delivery_deadline_at']))
        return received < cutoff
    except (KeyError, TypeError, ValueError):
        return False


def delivery_target(db, lease):
    stage = db.get(JobStage, lease.stage_id, populate_existing=True)
    job = db.get(Job, lease.job_id, populate_existing=True)
    if (lease.completed_at or not stage or stage.generation != lease.generation or stage.status != 'running'
            or not job or job.status != 'running' or job.cancel_requested or job.discard_output):
        raise ProcessingError('LEASE_EXPIRED', '任务已停止或执行代次已更新')
    if not accepted_delivery(lease):
        raise ProcessingError('PAGE_DEADLINE_EXCEEDED', '结果未在处理时限内完成接收')
    return stage, job


def receive_result(lease_id, body, handle, identity):
    result = body.result.model_dump()
    result_hash = digest(result)
    with session_factory()() as db:
        lock_scheduler(db)
        lease = scoped_lease(db, lease_id, body.lease_token, identity)
        if lease.completed_at:
            if lease.result_hash == result_hash:
                return receipt(lease)
            problem('COMPLETION_CONFLICT', '租约已结束或交付另一份结果', 409)
        lease, _, job = live_lease(db, lease_id, body.lease_token, identity)
        validate_result(db, job, result)
        if lease.result_hash is not None and lease.result_hash != result_hash:
            problem('COMPLETION_CONFLICT', '交付摘要已冻结', 409)
        if 'delivery_deadline_at' not in lease.limits:
            lease.limits = {**lease.limits,
                'delivery_deadline_at': stamp(now() + timedelta(seconds=lease.limits['delivery_seconds']))}
        lease.result_hash = result_hash
        lease.output_key = asset_storage_key(lease.id, 'classic') if result['output'] else None
        lease.limits = {**lease.limits, 'delivery_result': result, 'delivery_timings': body.timings}
        key = lease.output_key
        db.commit()  # Intent precedes bytes; network/file I/O never holds this lock.
    verify_output(handle, result)
    with session_factory()() as db:
        lock_scheduler(db)
        lease = scoped_lease(db, lease_id, body.lease_token, identity)
        if lease.completed_at:
            if lease.result_hash == result_hash:
                return receipt(lease)
            problem('COMPLETION_CONFLICT', '租约已结束', 409)
        lease, _, _ = live_lease(db, lease_id, body.lease_token, identity)
        accepted_at = now()
        cutoff = min(lease.expires_at, lease_deadline(db, lease))
        if accepted_at >= cutoff:
            raise ProcessingError('PAGE_DEADLINE_EXCEEDED', '结果未在处理时限内完成接收')
        if not lease.limits.get('delivery_received_at'):
            persist_deadline = max(lease.expires_at,
                accepted_at + timedelta(seconds=settings().upload_body_timeout_seconds))
            lease.limits = {**lease.limits, 'delivery_received_at': stamp(accepted_at),
                            'delivery_accept_deadline_at': stamp(cutoff),
                            'delivery_persist_deadline_at': stamp(persist_deadline)}
            lease.expires_at = persist_deadline
        db.commit()
    if key is not None:
        get_store().put_file(key, handle, 'image/webp', kind='classic')
    with session_factory()() as db:
        lock_scheduler(db)
        lease = scoped_lease(db, lease_id, body.lease_token, identity)
        if lease.completed_at:
            if lease.result_hash == result_hash:
                return receipt(lease)
            problem('COMPLETION_CONFLICT', '租约已结束', 409)
        stage, job = delivery_target(db, lease)
        reply = commit_result(db, lease, stage, job, result, body.timings)
        db.commit()
        return reply


@router.put('/leases/{lease_id}/result', openapi_extra={
    'requestBody': {'required': True, 'content': {'multipart/form-data': {
        'schema': result_multipart_schema(), 'encoding': {
            'metadata': {'contentType': 'application/json'}, 'output': {'contentType': 'image/webp'}}}}},
    'responses': {
        '200': {'description': 'Stable terminal receipt; replaying the same result never settles twice.'},
        '408': {'description': 'Multipart total body timeout; retry the same frozen result.'},
        '409': {'description': 'Lease or generation is no longer active, or the frozen result conflicts.'},
        '422': {'description': 'Invalid metadata, file hash/size/dimensions/alpha, or processing deadline exceeded.'},
        '503': {'description': 'Result ingress capacity or storage is unavailable; retry the same frozen result.'}}})
async def deliver_result(lease_id: str, request: Request, identity=Depends(node_auth)):
    from .result_ingress import begin_result_ingress, release_result_ingress
    from .storage import StorageError
    from .upload_ingress import finish_thread
    try:
        slot = await begin_result_ingress()
    except StorageError as error:
        raise HTTPException(503, detail={'code': error.code, 'message': '结果接收暂时繁忙，请重试'},
                            headers={'Retry-After': '2'}) from None
    form = None
    try:
        try:
            async with asyncio.timeout(settings().upload_body_timeout_seconds):
                form = await request.form(max_files=1, max_fields=1, max_part_size=65536)
        except TimeoutError:
            problem('UPLOAD_TIMEOUT', '结果接收超时，请重试同一结果', 408)
        if set(form) - {'metadata', 'output'} or len(form.getlist('metadata')) != 1 or len(form.getlist('output')) > 1:
            problem('INVALID_COMPLETION', '结果请求只能包含 metadata 与一个 output', 422)
        raw = form.get('metadata')
        if not isinstance(raw, str) or len(raw.encode('utf-8')) > 65536:
            problem('INVALID_COMPLETION', '结果描述无效或超过限制', 422)
        try:
            body = OutputRequest.model_validate_json(raw)
        except ValidationError:
            problem('INVALID_COMPLETION', '结果描述字段无效', 422)
        upload = form.get('output')
        if upload is not None and not isinstance(upload, UploadFile):
            problem('INVALID_COMPLETION', 'output 必须为二进制文件', 422)
        return await finish_thread(receive_result, lease_id, body, upload.file if upload else None, identity)
    finally:
        try:
            if form is not None:
                await form.close()
        finally:
            await finish_thread(release_result_ingress, slot)


def recover_compute_results(db, *, limit=100):
    """Restore expired, current-generation durable deliveries; caller commits.

    Validate bounded local files outside the scheduler lock, then fence again.
    This never gives an expired node permission to complete or starts new work.
    """
    candidates = list(db.scalars(select(ExecutionLease).join(JobStage, JobStage.id == ExecutionLease.stage_id).where(
        JobStage.name == 'page', ExecutionLease.completed_at.is_(None),
        ExecutionLease.expires_at <= now(), ExecutionLease.result_hash.is_not(None)).limit(limit)))
    valid = []
    for lease in candidates:
        result = (lease.limits or {}).get('delivery_result')
        if not result or digest(result) != lease.result_hash or not accepted_delivery(lease):
            continue
        try:
            if result['output'] is not None:
                with get_store().path(lease.output_key).open('rb') as handle:
                    verify_output(handle, result)
            valid.append((lease.id, result, lease.result_hash))
        except (OSError, ValueError, HTTPException):
            continue
    if not valid:
        return 0
    lock_scheduler(db)
    count = 0
    for lease_id, result, result_hash in valid:
        lease = db.get(ExecutionLease, lease_id, populate_existing=True)
        if lease.result_hash != result_hash:
            continue
        try:
            stage, job = delivery_target(db, lease)
        except ProcessingError:
            continue
        commit_result(db, lease, stage, job, result, lease.limits.get('delivery_timings', {}))
        count += 1
    return count


class CompletionRequest(LeaseRequest):
    error: NodeError
    timings: Timings = Field(default_factory=dict)


@router.post('/leases/{lease_id}/complete')
def complete(lease_id: str, body: CompletionRequest, identity=Depends(node_auth)):
    result_hash = digest({'error': body.error.model_dump()})
    with session_factory()() as db:
        lock_scheduler(db)
        lease = scoped_lease(db, lease_id, body.lease_token, identity)
        if lease.completed_at:
            if body.error.code == 'LEASE_STOPPED' or lease.result_hash == result_hash:
                return receipt(lease)
            problem('COMPLETION_CONFLICT', '租约已结束', 409)
        if body.error.code == 'LEASE_STOPPED':
            stage, job = db.get(JobStage, lease.stage_id), db.get(Job, lease.job_id)
            if stage.generation != lease.generation:
                release_lease(db, lease, 'cancelled')
                db.commit()
                return receipt(lease)
            invalid = lease.expires_at <= now() or job.status != 'running' or job.cancel_requested or job.discard_output
            invalid = invalid or not available(db.get(Asset, job.input_asset_id)) or lease_deadline(db, lease) <= now()
            if not invalid:
                problem('LEASE_ACTIVE', '执行授权仍有效', 409)
            if (accepted_delivery(lease) and parsed(lease.limits['delivery_persist_deadline_at']) > now()
                    and job.status == 'running' and not job.cancel_requested and not job.discard_output):
                # A node's stop acknowledgement cannot cancel a body already
                # accepted by the center while its bounded disk publish runs.
                raise ProcessingError('STORAGE_UNAVAILABLE', '已受理结果正在持久化，请重试完成确认')
            lease.expires_at = min(lease.expires_at, now())
        else:
            live_lease(db, lease_id, body.lease_token, identity)
            lease.result_hash = result_hash
        db.commit()
    if body.error.code == 'LEASE_STOPPED':
        from .dispatcher import recover_lease
        recover_lease(lease_id)
    else:
        fail_stage(lease_id, ProcessingError(body.error.code, '计算节点未能完成此页'), token=body.lease_token, node_id=identity)
    with session_factory()() as db:
        lease = scoped_lease(db, lease_id, body.lease_token, identity)
        if not lease.completed_at:
            raise ProcessingError('STORAGE_UNAVAILABLE', '完成状态尚未确认，请重试同一请求')
        return receipt(lease)
