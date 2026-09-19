"""Whole-page compute leases. Image work stays on the node; text stays here."""
from datetime import datetime, timedelta
import hmac
from typing import Annotated, Literal
import time

from fastapi import APIRouter, Depends, Response
from starlette.concurrency import run_in_threadpool
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .assets import available, content_storage_key, create_asset
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
from .scheduler import claim_stage, current_lease, heartbeat_lease, lock_scheduler, release_lease, touch_job
from .storage import get_store
from .workers import fail_stage, finish_job


def no_store(response: Response):
    response.headers['Cache-Control'] = 'no-store'


router = APIRouter(prefix='/internal/compute/v2', tags=['compute v2'], dependencies=[Depends(no_store)])


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


def input_authorization(db, lease, source):
    # Presigning is local cryptography, not an object HEAD/GET. Never proxy bytes.
    ttl = min(60, int((lease.expires_at - now()).total_seconds()) - 2)
    if ttl < 1:
        raise ProcessingError('LEASE_EXPIRED', '下载窗口不足，请先续租')
    url = get_store(source.storage_backend).download_url(source.storage_key, ttl)
    if not url:
        raise ProcessingError('COMPUTE_STORAGE_UNSUPPORTED', '整页计算节点需要 R2 下载授权')
    source.last_accessed_at = now()
    return {'url': url, 'url_expires_at': stamp(now() + timedelta(seconds=ttl)), 'server_time': stamp(now()),
            'sha256': source.sha256, 'byte_size': source.byte_size, 'mime': source.mime,
            'width': source.width, 'height': source.height}


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
            'input': input_authorization(db, lease, source), 'config': {'engine': job.config['engine']},
            'language': job.target_language, 'analysis': analysis,
            'analysis_hash': digest(analysis) if analysis else None,
            'translations': translations_payload(db, job.id)}


class Registration(RequestBody):
    protocol_version: Literal[2]
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
    node.runtime_report = {'protocol_version': 2, 'ready': body.ready, 'languages': body.supported_languages}
    node.applied_config_version, node.config_error, node.heartbeat_at = node.config_version, None, now()
    result = {'protocol_version': 2, 'config': config_payload(node), 'server_time': stamp(now()),
              'leases': [lease_payload(db, lease) for lease in leases]}
    db.commit()
    return result


class ClaimRequest(RequestBody):
    request_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    config_version: int = Field(ge=1, strict=True)
    count: int = Field(ge=1, le=32, strict=True)


@router.post('/nodes/{node_id}/claim')
def claim(node_id: str, body: ClaimRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    lock_scheduler(db)
    node = scoped_node(db, identity, node_id)
    if node.runtime_report.get('protocol_version') != 2:
        problem('PROTOCOL_MISMATCH', '请先注册整页协议', 409)
    request_hash = digest(body.model_dump())
    saved = db.get(ComputeClaim, (identity, body.request_id))
    if saved:
        if saved.request_hash != request_hash:
            problem('CLAIM_CONFLICT', '同一领取编号不能修改内容', 409)
        leases = [db.get(ExecutionLease, key) for key in saved.lease_ids]
    else:
        if body.config_version != node.config_version:
            problem('NODE_CONFIG_CONFLICT', '领取前需要同步配置', 409)
        config = config_payload(node)
        node.supported_languages = [lang for lang in node.runtime_report.get('languages', [])
                                    if lang in config['allowed_languages']]
        leases = []
        for _ in range(body.count):
            lease = claim_stage(db, identity, ['page'], config_version=body.config_version)
            if not lease:
                break
            leases.append(lease)
            db.flush()  # Every page runs a fresh fairness election in this transaction.
        db.add(ComputeClaim(node_id=identity, request_id=body.request_id,
                            request_hash=request_hash, lease_ids=[lease.id for lease in leases]))
    result = {'request_id': body.request_id, 'server_time': stamp(now()),
              'config': config_payload(node), 'leases': [lease_payload(db, lease) for lease in leases]}
    db.commit()
    return result


class LeaseRequest(RequestBody):
    lease_token: str = Field(min_length=1, max_length=64)


class UpdatesRequest(RequestBody):
    revision: int = Field(default=0, ge=0, strict=True)
    wait_seconds: float = Field(default=20, ge=0, le=20, allow_inf_nan=False)


@router.post('/nodes/{node_id}/updates')
async def updates(node_id: str, body: UpdatesRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    scoped_node(db, identity, node_id)
    await run_in_threadpool(db.close)
    from .notifications import hub, changed
    from .queue_models import SchedulerMutex
    def snapshot():
        with session_factory()() as session:
            scoped_node(session, identity, node_id)
            return session.get(SchedulerMutex, 1).revision
    end = time.monotonic() + body.wait_seconds
    with hub().subscribe('compute') as wake:
        while True:
            wake.clear()
            revision = await run_in_threadpool(snapshot)
            if revision != body.revision or time.monotonic() >= end:
                return {'revision': revision}
            await changed(wake, end - time.monotonic())


class HeartbeatItem(LeaseRequest):
    lease_id: str = Field(min_length=1, max_length=36)
    translations_revision: str | None = Field(default=None, max_length=64)
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
            lease.expires_at = min(lease.expires_at, lease_deadline(db, lease))
        except ProcessingError as error:
            # One rejected item must not roll back unrelated renewals.
            replies.append({'lease_id': lease.id, 'status': 'stop', 'code': error.code})
            continue
        db.get(Asset, job.input_asset_id).last_accessed_at = now()
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


@router.post('/leases/{lease_id}/input/authorize')
def authorize(lease_id: str, body: LeaseRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    lock_scheduler(db)
    lease, _, job = live_lease(db, lease_id, body.lease_token, identity)
    result = input_authorization(db, lease, db.get(Asset, job.input_asset_id))
    db.commit()
    return result


ErrorCode = Literal['LEASE_STOPPED', 'ENGINE_UNAVAILABLE', 'CLASSIC_LOCAL_INTERRUPTED',
    'INPUT_INVALID', 'INPUT_HASH_MISMATCH', 'STORAGE_AUTH_FAILED', 'STORAGE_UNAVAILABLE',
    'CLASSIC_ANALYZE_FAILED', 'CLASSIC_INPAINT_FAILED', 'CLASSIC_RENDER_FAILED',
    'ENGINE_VERSION_MISMATCH', 'TEXT_DEADLINE_EXCEEDED', 'DELIVERY_DEADLINE_EXCEEDED', 'PAGE_DEADLINE_EXCEEDED']


class NodeError(RequestBody):
    code: ErrorCode


class OutputInfo(RequestBody):
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    md5: str = Field(pattern=r'^[a-f0-9]{32}$')
    byte_size: int = Field(ge=1, le=24 * 1024 * 1024, strict=True)
    width: int = Field(ge=1, strict=True)
    height: int = Field(ge=1, strict=True)
    mime: Literal['image/png']


class PageResult(RequestBody):
    version: str = Field(min_length=1, max_length=120)
    input_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    analysis_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    translations_revision: str = Field(pattern=r'^[a-f0-9]{64}$')
    output: OutputInfo


class OutputRequest(LeaseRequest):
    result: PageResult


@router.post('/leases/{lease_id}/output/authorize')
def authorize_output(lease_id: str, body: OutputRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    result = body.result.model_dump()
    result_hash = digest(result)
    lock_scheduler(db)
    lease = scoped_lease(db, lease_id, body.lease_token, identity)
    if lease.completed_at:
        if lease.result_hash == result_hash:
            return {'receipt': receipt(lease)}
        problem('COMPLETION_CONFLICT', '租约已交付另一份结果', 409)
    lease, _, job = live_lease(db, lease_id, body.lease_token, identity)
    if lease.result_hash is not None and lease.result_hash != result_hash:
        problem('COMPLETION_CONFLICT', '交付摘要已冻结', 409)
    source = db.get(Asset, job.input_asset_id)
    info, cfg = result['output'], settings()
    if result['input_hash'] != source.sha256 or result['version'] != job.config['engine']['version']:
        problem('ENGINE_RESULT_MISMATCH', '结果与输入或引擎版本不一致', 409)
    if ((info['width'], info['height']) != (source.width, source.height)
            or info['width'] * info['height'] > cfg.max_pixels or max(info['width'], info['height']) > cfg.max_dimension
            or info['byte_size'] > cfg.max_upload_bytes):
        problem('INVALID_PROVIDER_OUTPUT', '结果元数据超出图片限制', 422)
    translated = translations_payload(db, job.id)
    if (not translated or result['analysis_hash'] != translated['analysis_hash']
            or result['translations_revision'] != translated['revision']):
        problem('TRANSLATIONS_MISMATCH', '结果未绑定当前分析与译文版本', 409)
    if 'delivery_deadline_at' not in lease.limits:
        lease.limits = {**lease.limits, 'delivery_deadline_at': stamp(now() + timedelta(seconds=lease.limits['delivery_seconds']))}
    ttl = min(60, int((min(lease.expires_at, lease_deadline(db, lease)) - now()).total_seconds()) - 2)
    if ttl < 1:
        raise ProcessingError('LEASE_EXPIRED', '上传窗口不足，请先续租')
    key = content_storage_key(info['sha256'])
    backend = db.get(Attempt, job.attempt_id).output_storage_backend
    upload = get_store(backend).upload_url(key, info, ttl)
    if not upload:
        raise ProcessingError('COMPUTE_STORAGE_UNSUPPORTED', '计算节点需要 R2 上传授权')
    lease.result_hash, lease.output_key = result_hash, key
    db.commit()
    return {'receipt': None, 'result_hash': result_hash,
            **upload, 'server_time': stamp(now()), 'url_expires_at': stamp(now() + timedelta(seconds=ttl))}


class CompletionRequest(LeaseRequest):
    result: PageResult | None = None
    etag: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')
    error: NodeError | None = None
    timings: dict[Literal['download', 'download_queue', 'analyze', 'analyze_queue', 'inpaint',
        'inpaint_queue', 'render', 'render_queue', 'analysis_submit', 'text_wait', 'local_total', 'upload_authorize', 'output_put'],
        Annotated[float, Field(ge=0, le=86400, allow_inf_nan=False)]] = Field(default_factory=dict)


@router.post('/leases/{lease_id}/complete')
def complete(lease_id: str, body: CompletionRequest, identity=Depends(node_auth)):
    started = time.monotonic()
    if (body.result is None) == (body.error is None):
        problem('INVALID_COMPLETION', '结果与固定错误码必须二选一', 422)
    result = body.result.model_dump() if body.result is not None else None
    result_hash = digest(result if result is not None else {'error': body.error.model_dump()})
    with session_factory()() as db:
        lock_scheduler(db)
        lease = scoped_lease(db, lease_id, body.lease_token, identity)
        if lease.completed_at:
            if body.error and body.error.code == 'LEASE_STOPPED' or lease.result_hash == result_hash:
                return receipt(lease)
            problem('COMPLETION_CONFLICT', '租约已交付另一份结果', 409)
        if body.error and body.error.code == 'LEASE_STOPPED':
            stage, job = db.get(JobStage, lease.stage_id), db.get(Job, lease.job_id)
            if stage.generation != lease.generation:
                release_lease(db, lease, 'cancelled')
                db.commit()
                return receipt(lease)
            invalid = lease.expires_at <= now() or job.status != 'running' or job.cancel_requested or job.discard_output
            invalid = invalid or not available(db.get(Asset, job.input_asset_id)) or lease_deadline(db, lease) <= now()
            if not invalid:
                problem('LEASE_ACTIVE', '执行授权仍有效', 409)
            # Let normal recovery decide retries. Never alter a newer generation.
            lease.expires_at = min(lease.expires_at, now())
            db.commit()
        else:
            lease, stage, job = live_lease(db, lease_id, body.lease_token, identity)
            if result is not None:
                if lease.result_hash != result_hash or lease.output_key != content_storage_key(result['output']['sha256']):
                    problem('COMPLETION_CONFLICT', '请先取得此结果的上传授权', 409)
                if body.etag != result['output']['md5']:
                    problem('UPLOAD_RECEIPT_MISMATCH', '上传回执与授权内容不一致', 409)
                translated = translations_payload(db, lease.job_id)
                if (not translated or result['analysis_hash'] != translated['analysis_hash']
                        or result['translations_revision'] != translated['revision']):
                    problem('TRANSLATIONS_MISMATCH', '结果未绑定当前分析与译文版本', 409)
                # Trusted compute nodes attest upload success. Only metadata is
                # committed here: no image bytes, object probe, decode or PUT.
                backend = db.get(Attempt, job.attempt_id).output_storage_backend
                info = {key: value for key, value in result['output'].items() if key != 'md5'}
                output = create_asset(db, job.owner_id, b'', kind='classic', parent_id=job.input_asset_id,
                    stable_id=lease_id, storage_backend=backend, prewritten=True, verified_info=info)
                job.output_asset_id = output.id
                state = db.get(ClassicState, job.id)
                job.quality_flags = (state.analysis or {}).get('quality_flags', [])
                stage.status, stage.completed_at = 'succeeded', now()
                finish_job(db, job, 'succeeded')
                release_lease(db, lease, 'succeeded')
                touch_job(db, job)
                state.timings = {'node': body.timings, 'delivery': {'total': time.monotonic() - started}}
            lease.result_hash = result_hash
            db.commit()
    if body.error and body.error.code == 'LEASE_STOPPED':
        # An expired page is retried with its existing analysis and text.
        from .dispatcher import recover_lease
        recover_lease(lease_id)
    elif body.error:
        fail_stage(lease_id, ProcessingError(body.error.code, '计算节点未能完成此页'), token=body.lease_token, node_id=identity)
    with session_factory()() as db:
        lease = scoped_lease(db, lease_id, body.lease_token, identity)
        if not lease.completed_at:
            raise ProcessingError('STORAGE_UNAVAILABLE', '完成状态尚未确认，请重试同一请求')
        return receipt(lease)
