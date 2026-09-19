"""Whole-page compute leases. Image work stays on the node; text stays here."""
from datetime import datetime, timedelta
import hmac
from typing import Literal

from fastapi import APIRouter, Depends, Response
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .assets import available
from .classic import validate_analysis
from .cluster_api import node_auth
from .config import settings
from .db import get_db, session_factory
from .errors import ProcessingError, problem
from .languages import Language, LANGUAGES
from .models import Asset, ClassicState, Job, now
from .node_config import NodeConfig
from .providers import digest
from .queue_models import ComputeClaim, ComputeNode, ExecutionLease, JobStage
from .request_models import RequestBody
from .scheduler import claim_stage, current_lease, heartbeat_lease, lock_scheduler, release_lease, touch_job
from .storage import get_store
from .workers import complete_stage, fail_stage, finish_job


def no_store(response: Response):
    response.headers['Cache-Control'] = 'no-store'


router = APIRouter(prefix='/internal/compute/v2', tags=['compute v2'], dependencies=[Depends(no_store)])


def stamp(value):
    return value.isoformat() + 'Z'


def parsed(value):
    return datetime.fromisoformat(value.removesuffix('Z'))


def config_payload(node):
    config = NodeConfig.model_validate(node.desired_config)
    keys = ('execution_slots', 'poll_seconds', 'heartbeat_seconds', 'waiting_heartbeat_seconds',
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
    if any(db.get(JobStage, lease.stage_id).name != 'page' for lease in leases):
        problem('PROTOCOL_DRAIN_REQUIRED', '切换协议前请排空旧图像租约', 409)
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
            lease.limits = {'deadline_at': stamp(lease.started_at + timedelta(seconds=config['page_seconds'])),
                            'text_wait_seconds': config['text_wait_seconds'],
                            'delivery_seconds': config['delivery_seconds'],
                            'max_attempts': db.get(Job, lease.job_id).config.get('stage_attempts', settings().cluster_stage_attempts)}
            lease.expires_at = min(lease.expires_at, parsed(lease.limits['deadline_at']))
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


class CompletionRequest(LeaseRequest):
    result: dict | None = None
    error: NodeError | None = None


@router.post('/leases/{lease_id}/complete')
def complete(lease_id: str, body: CompletionRequest, identity=Depends(node_auth)):
    if (body.result is None) == (body.error is None):
        problem('INVALID_COMPLETION', '结果与固定错误码必须二选一', 422)
    result_hash = digest(body.result if body.result is not None else {'error': body.error.model_dump()})
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
            live_lease(db, lease_id, body.lease_token, identity)
            if lease.result_hash is not None and lease.result_hash != result_hash:
                problem('COMPLETION_CONFLICT', '交付摘要已冻结', 409)
            if body.result is not None:
                translated = translations_payload(db, lease.job_id)
                if (not translated or body.result.get('analysis_hash') != translated['analysis_hash']
                        or body.result.get('translations_revision') != translated['revision']):
                    problem('TRANSLATIONS_MISMATCH', '结果未绑定当前分析与译文版本', 409)
                if 'delivery_deadline_at' not in lease.limits:
                    lease.limits = {**lease.limits, 'delivery_deadline_at': stamp(now() + timedelta(seconds=lease.limits['delivery_seconds']))}
            lease.result_hash = result_hash
            db.commit()
    if body.error and body.error.code == 'LEASE_STOPPED':
        # Recovery handles a validated, possibly already uploaded immutable result.
        from .dispatcher import recover_lease
        recover_lease(lease_id)
    elif body.error:
        fail_stage(lease_id, ProcessingError(body.error.code, '计算节点未能完成此页'), token=body.lease_token, node_id=identity)
    else:
        try:
            complete_stage(lease_id, body.result, token=body.lease_token, node_id=identity)
        except ProcessingError as error:
            if error.code in {'LEASE_EXPIRED', 'COMPLETION_CONFLICT'}:
                raise
            fail_stage(lease_id, error, token=body.lease_token, node_id=identity)
    with session_factory()() as db:
        lease = scoped_lease(db, lease_id, body.lease_token, identity)
        if not lease.completed_at:
            raise ProcessingError('STORAGE_UNAVAILABLE', '完成状态尚未确认，请重试同一请求')
        return receipt(lease)
