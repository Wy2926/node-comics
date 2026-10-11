"""Fenced node-local document work; only source and final ZIP cross R2."""
from datetime import datetime, timedelta
import hmac
import json
import logging
from time import perf_counter
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, model_validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ..compute_v3 import config_payload, no_store, stamp
from ..config import settings
from ..db import get_db
from ..errors import ProcessingError, problem
from ..models import Job, now
from ..node_auth import node_auth
from ..node_config import NodeConfig
from ..providers import digest
from ..queue_models import ComputeClaim, ComputeNode, ExecutionLease, JobStage
from ..request_models import RequestBody
from ..scheduler import (current_lease, has_claimable_work, lock_scheduler, release_lease,
                         remaining_capacity, start_lease, touch_job)
from .config import get_document_settings
from .models import Document, DocumentPage
from .storage import DocumentStoreError, get_document_store

router = APIRouter(prefix='/internal/documents/compute/v2', tags=['document compute'],
                   dependencies=[Depends(no_store)])
log = logging.getLogger('uvicorn.error.documents')
NODE_STAGES = ('doc_prepare', 'doc_ocr', 'doc_render', 'doc_zip')
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_ZIP_BYTES = 4 * 1024 ** 3
FILE_LIMITS = ('max_page_pixels', 'max_page_dimension', 'max_page_bytes', 'max_expanded_bytes',
               'max_output_bytes', 'max_spool_bytes', 'parser_memory_bytes', 'parser_timeout_seconds', 'pdf_dpi')


class Reference(RequestBody):
    """Identity of an immutable local file, never a path or remote object key."""
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    byte_size: int = Field(ge=1, le=512 * 1024 * 1024, strict=True)
    mime: Literal['application/json', 'image/png']
    width: int | None = Field(default=None, ge=1, le=100000, strict=True)
    height: int | None = Field(default=None, ge=1, le=100000, strict=True)


class ZipReference(RequestBody):
    key: str = Field(min_length=1, max_length=300)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    byte_size: int = Field(ge=1, le=MAX_ZIP_BYTES, strict=True)
    mime: Literal['application/zip']


class PreparedPage(RequestBody):
    page_index: int = Field(ge=1, le=200, strict=True)
    source_name: str = Field(max_length=300)
    input_ref: Reference


class Segment(RequestBody):
    id: str = Field(min_length=1, max_length=80)
    source: str = Field(min_length=1, max_length=4000)


class OCRText(RequestBody):
    page_index: int = Field(ge=1, le=200, strict=True)
    analysis_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    segments: list[Segment] = Field(max_length=200)

    @model_validator(mode='after')
    def identities(self):
        if len({row.id for row in self.segments}) != len(self.segments) or any(not row.source.strip() for row in self.segments):
            raise ValueError('OCR identities must be unique and source text nonempty')
        return self


class ClaimRequest(RequestBody):
    request_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    config_version: int = Field(ge=1, strict=True)
    count: Literal[1] = 1


class LeaseRequest(RequestBody):
    lease_token: str = Field(min_length=1, max_length=64)
    workspace_generation: int = Field(ge=1, strict=True)


class ArtifactsRequest(LeaseRequest):
    output_ref: ZipReference


class CompletionRequest(LeaseRequest):
    pages: list[PreparedPage] | None = Field(default=None, min_length=1, max_length=200)
    analysis_ref: Reference | None = None
    text: OCRText | None = None
    output_ref: Reference | ZipReference | None = None
    no_text: bool = False
    quality_flags: list[Annotated[str, Field(pattern=r'^[a-z_]{1,60}$')]] = Field(default_factory=list, max_length=8)
    error: Annotated[str, Field(pattern=r'^[A-Z][A-Z0-9_]{0,59}$')] | None = None

    @model_validator(mode='after')
    def exactly_one_result(self):
        result = any(value is not None for value in (self.pages, self.analysis_ref, self.text, self.output_ref))
        if bool(self.error) == result or self.error and (self.no_text or self.quality_flags):
            raise ValueError('Provide a stage result or an error')
        return self


class HeartbeatEntry(LeaseRequest):
    lease_id: str = Field(min_length=1, max_length=64)


class HeartbeatRequest(RequestBody):
    leases: list[HeartbeatEntry] = Field(max_length=32)


class SyncRequest(RequestBody):
    workspace_ids: list[Annotated[str, Field(min_length=1, max_length=36)]] = Field(default_factory=list, max_length=200)


def node_for(db, identity, node_id):
    if identity != node_id:
        problem('NODE_SCOPE_MISMATCH', '节点身份不匹配', 403)
    node = db.get(ComputeNode, node_id, populate_existing=True)
    if not node or (node.runtime_report or {}).get('document_protocol') != 2:
        problem('PROTOCOL_MISMATCH', '节点未启用本地文件工作协议', 409)
    return node


def scoped(db, lease_id, token, identity, workspace_generation=None):
    lease = db.get(ExecutionLease, lease_id, populate_existing=True)
    if not lease or lease.node_id != identity or not hmac.compare_digest(lease.token, token):
        problem('NODE_SCOPE_MISMATCH', '租约未授权给此节点', 403)
    stage = db.get(JobStage, lease.stage_id)
    if stage.name not in NODE_STAGES or lease.limits.get('document_protocol') != 2:
        problem('PROTOCOL_MISMATCH', '非本地文件执行租约', 409)
    if workspace_generation is not None and workspace_generation != lease.limits.get('workspace_generation'):
        problem('LEASE_EXPIRED', '文件工作目录代次不匹配', 409)
    return lease, stage


def receipt(lease):
    return {'lease_id': lease.id, 'status': 'terminal', 'outcome': lease.outcome,
            'result_hash': lease.result_hash, 'completed_at': stamp(lease.completed_at)}


def live(db, lease):
    lease, stage, job = current_lease(db, lease.id, lease.token)
    deadline = datetime.fromisoformat(lease.limits['deadline_at'].removesuffix('Z'))
    document = db.get(Document, job.id)
    if (deadline <= now() or job.workflow_kind != 'document' or document.owner_node_id != lease.node_id
            or document.workspace_generation != lease.limits.get('workspace_generation')):
        raise ProcessingError('LEASE_EXPIRED', '文件执行期限已结束或工作目录已更新')
    return lease, stage, job


def payload(db, lease):
    if lease.completed_at:
        return receipt(lease)
    try:
        lease, stage, job = live(db, lease)
    except ProcessingError:
        return {'lease_id': lease.id, 'status': 'stop', 'code': 'LEASE_STOPPED'}
    document = db.get(Document, job.id)
    result = {'lease_id': lease.id, 'lease_token': lease.token, 'job_id': job.id,
        'page_index': stage.page_index, 'generation': lease.generation, 'action': stage.name,
        'workspace_generation': document.workspace_generation, 'status': 'active',
        'expires_at': stamp(lease.expires_at), 'language': job.target_language, 'limits': lease.limits,
        'file_limits': lease.limits['file_limits']}
    if stage.name == 'doc_prepare':
        ref = {'key': document.source_key, 'sha256': document.source_sha256,
            'byte_size': document.source_size, 'mime': 'application/pdf' if document.source_type == 'pdf' else 'application/zip'}
        result.update(source={'ref': ref, 'transfer': get_document_store().presign_get(ref)},
                      source_type=document.source_type)
    elif stage.name == 'doc_zip':
        result.update(pages=[{'page_index': page.page_index, 'output_ref': page.output_ref} for page in db.execute(
            select(DocumentPage.page_index, DocumentPage.output_ref).where(DocumentPage.job_id == job.id).order_by(DocumentPage.page_index))],
            output_key=lease.limits['output_key'])
    else:
        page = db.get(DocumentPage, (job.id, stage.page_index))
        result['input'] = page.input_ref
        if stage.name == 'doc_render':
            result.update(analysis_ref=page.analysis_ref, translations=page.translations_ref)
    return result


@router.post('/nodes/{node_id}/sync')
def sync(node_id: str, body: SyncRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    node = node_for(db, identity, node_id)
    leases = list(db.scalars(select(ExecutionLease).join(JobStage).where(
        ExecutionLease.node_id == node.id, ExecutionLease.completed_at.is_(None), JobStage.name.in_(NODE_STAGES))))
    ids = set(body.workspace_ids) | {lease.job_id for lease in leases}
    rows = db.execute(select(Document.job_id, Document.owner_node_id, Document.workspace_generation, Job.status, Job.phase)
        .join(Job, Job.id == Document.job_id).where(Document.job_id.in_(ids))).all()
    owned = {row.job_id: {'job_id': row.job_id, 'workspace_generation': row.workspace_generation,
             'status': row.status, 'phase': row.phase} for row in rows if row.owner_node_id == node.id}
    # An explicit revocation authorizes cleanup; omission never does. Do not
    # disclose another node/user's task metadata in an inventory response.
    workspaces = [owned.get(job_id, {'job_id': job_id, 'workspace_generation': None,
                   'status': 'revoked', 'phase': 'revoked'}) for job_id in sorted(ids)]
    return {'server_time': stamp(now()), 'config': config_payload(node), 'leases': [payload(db, lease) for lease in leases],
            'workspaces': workspaces}


@router.post('/nodes/{node_id}/claim')
def claim(node_id: str, body: ClaimRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    lock_scheduler(db)
    node = node_for(db, identity, node_id)
    key = (node_id, body.request_id)
    request_hash = digest({'document_protocol': 2, **body.model_dump()})
    saved = db.get(ComputeClaim, key)
    if saved:
        if saved.request_hash != request_hash:
            problem('CLAIM_CONFLICT', '领取编号已用于其他内容', 409)
        leases = [db.get(ExecutionLease, value) for value in saved.lease_ids]
    else:
        if node.config_version != body.config_version:
            problem('NODE_CONFIG_CONFLICT', '节点配置已更新', 409)
        cfg = NodeConfig.model_validate(node.desired_config)
        busy = db.scalar(select(func.count()).select_from(ExecutionLease).join(JobStage).where(
            ExecutionLease.node_id == node_id, ExecutionLease.completed_at.is_(None), JobStage.name.in_(NODE_STAGES)))
        leases = []
        # Ownership is not a capacity lease. Every short operation competes
        # through the existing node gate; no GPU slot is held while text runs.
        if (node.enabled and busy < cfg.document_slots and remaining_capacity(db, node)
                and not has_claimable_work(db, node_id, ['page'])):
            row = db.execute(select(JobStage, Job, Document).join(Job, Job.id == JobStage.job_id)
                .join(Document, Document.job_id == Job.id).where(
                    Job.workflow_kind == 'document', Job.status.in_(['preflight', 'queued', 'running']),
                    or_(Document.owner_node_id == node_id,
                        and_(Document.owner_node_id.is_(None), JobStage.name == 'doc_prepare')),
                    or_(JobStage.name == 'doc_prepare', Document.reserved_at.is_not(None)),
                    Job.cancel_requested.is_(False), Job.discard_output.is_(False),
                    JobStage.name.in_(NODE_STAGES), JobStage.name.in_(node.capabilities), JobStage.status == 'ready',
                    JobStage.available_at <= now(), Job.target_language.in_(node.supported_languages))
                .order_by(JobStage.available_at, JobStage.id).limit(1)).first()
            if row:
                stage, job, document = row
                document.owner_node_id = node.id
                at, limits = now(), get_document_settings()
                seconds = (limits.prepare_timeout_seconds if stage.name == 'doc_prepare' else
                           limits.package_timeout_seconds if stage.name == 'doc_zip' else cfg.page_seconds)
                lease = start_lease(db, node, stage, job, at)
                lease.limits = {'document_protocol': 2, 'workspace_generation': document.workspace_generation,
                    'deadline_at': stamp(at + timedelta(seconds=seconds)), 'max_spool_bytes': limits.max_spool_bytes,
                    'max_output_bytes': min(MAX_ZIP_BYTES, limits.max_output_bytes),
                    'file_limits': {name: getattr(limits, name) for name in FILE_LIMITS}}
                if stage.name == 'doc_zip':
                    lease.limits = {**lease.limits, 'output_key': get_document_store().key('output', job.id, lease.id, 'translated.zip')}
                lease.expires_at = min(lease.expires_at, at + timedelta(seconds=seconds))
                leases.append(lease)
        db.add(ComputeClaim(node_id=node_id, request_id=body.request_id, request_hash=request_hash,
                            lease_ids=[lease.id for lease in leases]))
    db.commit()
    return {'request_id': body.request_id, 'server_time': stamp(now()), 'config': config_payload(node),
            'leases': [payload(db, lease) for lease in leases]}


@router.post('/nodes/{node_id}/heartbeat')
def heartbeat(node_id: str, body: HeartbeatRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    lock_scheduler(db)
    node = node_for(db, identity, node_id)
    replies = []
    for item in body.leases:
        try:
            lease, _ = scoped(db, item.lease_id, item.lease_token, identity, item.workspace_generation)
            if lease.completed_at:
                replies.append(receipt(lease))
                continue
            live(db, lease)
            deadline = datetime.fromisoformat(lease.limits['deadline_at'].removesuffix('Z'))
            lease.expires_at = min(now() + timedelta(seconds=settings().cluster_lease_seconds), deadline)
            replies.append({'lease_id': lease.id, 'status': 'active', 'expires_at': stamp(lease.expires_at)})
        except (ProcessingError, HTTPException):
            replies.append({'lease_id': item.lease_id, 'status': 'stop', 'code': 'LEASE_STOPPED'})
    node.heartbeat_at = now()
    db.commit()
    return {'server_time': stamp(now()), 'config': config_payload(node), 'leases': replies}


@router.post('/leases/{lease_id}/inputs')
def inputs(lease_id: str, body: LeaseRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    lease, stage = scoped(db, lease_id, body.lease_token, identity, body.workspace_generation)
    live(db, lease)
    if stage.name != 'doc_prepare':
        problem('DOCUMENT_ARTIFACT_INVALID', '仅源文件需要下载签名', 422)
    return {'source': payload(db, lease)['source']}


def image_reference(ref, expected=None):
    cfg = get_document_settings()
    if (not isinstance(ref, Reference) or ref.mime != 'image/png' or not ref.width or not ref.height
            or ref.byte_size > cfg.max_page_bytes or max(ref.width, ref.height) > cfg.max_page_dimension
            or ref.width * ref.height > cfg.max_page_pixels
            or expected and any(getattr(ref, name) != expected[name] for name in ('width', 'height'))):
        problem('DOCUMENT_ARTIFACT_INVALID', '页面描述超出工作目录限制', 422)
    return ref.model_dump(exclude_none=True)


def zip_reference(lease, stage, ref):
    if (stage.name != 'doc_zip' or not isinstance(ref, ZipReference) or ref.key != lease.limits.get('output_key')
            or ref.byte_size > lease.limits['max_output_bytes']):
        problem('DOCUMENT_ARTIFACT_INVALID', '仅最终压缩包允许上传', 422)
    return ref.model_dump()


def checked_result(db, lease, stage, body):
    actual = {name for name in ('pages', 'analysis_ref', 'text', 'output_ref') if getattr(body, name) is not None}
    expected = {'doc_prepare': {'pages'}, 'doc_ocr': {'analysis_ref', 'text'},
                'doc_render': {'output_ref'}, 'doc_zip': {'output_ref'}}[stage.name]
    if actual != expected or body.no_text and stage.name != 'doc_ocr' or body.quality_flags and stage.name not in ('doc_ocr', 'doc_render'):
        problem('DOCUMENT_ARTIFACT_INVALID', '阶段产物不完整或不匹配', 422)
    if stage.name == 'doc_prepare':
        pages = [dict(page_index=row.page_index, source_name=row.source_name, input_ref=image_reference(row.input_ref)) for row in body.pages]
        if (sum(row['input_ref']['byte_size'] for row in pages) > get_document_settings().max_expanded_bytes
                or [row['page_index'] for row in pages] != list(range(1, len(pages) + 1))):
            problem('DOCUMENT_ARTIFACT_INVALID', '页面清单不连续或超出大小限制', 422)
        return {'pages': pages}
    if stage.name == 'doc_zip':
        ref = zip_reference(lease, stage, body.output_ref)
        if ref != lease.limits.get('output_ref'):
            problem('COMPLETION_CONFLICT', '压缩包结果未按该租约冻结', 409)
        return {'output_ref': ref}
    page = db.get(DocumentPage, (lease.job_id, stage.page_index))
    if stage.name == 'doc_render':
        return {'output_ref': image_reference(body.output_ref, page.input_ref)}
    if (body.analysis_ref.mime != 'application/json' or body.analysis_ref.byte_size > MAX_JSON_BYTES
            or body.analysis_ref.width is not None or body.analysis_ref.height is not None
            or body.text.page_index != stage.page_index or body.no_text != (not body.text.segments)):
        problem('DOCUMENT_ARTIFACT_INVALID', 'OCR 检查点与页面不匹配', 422)
    # analysis_hash identifies canonical analysis, not necessarily the exact
    # serialization bytes represented by analysis_ref.sha256.
    return {'analysis_ref': body.analysis_ref.model_dump(exclude_none=True), 'text': body.text.model_dump()}


@router.post('/leases/{lease_id}/uploads')
def uploads(lease_id: str, body: ArtifactsRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    lock_scheduler(db)
    lease, stage = scoped(db, lease_id, body.lease_token, identity, body.workspace_generation)
    ref = zip_reference(lease, stage, body.output_ref)
    previous = lease.limits.get('output_ref')
    if lease.completed_at:
        if lease.outcome == 'succeeded' and previous == ref:
            return {'receipt': receipt(lease)}
        problem('LEASE_EXPIRED', '该执行代次已结束', 409)
    live(db, lease)
    if previous is not None and previous != ref:
        problem('COMPLETION_CONFLICT', '该租约已冻结另一组产物', 409)
    lease.limits = {**lease.limits, 'output_ref': ref}
    db.commit()
    return {'uploads': {'output': get_document_store().presign_put(ref)}}


@router.post('/leases/{lease_id}/complete')
def complete(lease_id: str, body: CompletionRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    from .workflow import fail_lease, install_pages, on_stage_completed
    started = perf_counter()
    metrics = {'outcome': 'error', 'phase': 'validate', 'artifact_count': 0, 'head_ms': 0.0, 'lock_wait_ms': 0.0}
    try:
        lease, stage = scoped(db, lease_id, body.lease_token, identity, body.workspace_generation)
        metrics.update(lease_id=lease.id, job_id=stage.job_id, node_id=lease.node_id,
                       stage=stage.name, page_index=stage.page_index)
        if body.error:
            db.rollback()
            fail_lease(lease_id, ProcessingError(body.error, '文件节点执行失败'), token=body.lease_token,
                       node_id=identity, workspace_generation=body.workspace_generation)
            db.expire_all()
            metrics['outcome'] = 'failed'
            return receipt(db.get(ExecutionLease, lease_id))
        result_hash = digest(body.model_dump(exclude={'lease_token'}, exclude_none=True))
        if lease.completed_at:
            if lease.outcome == 'succeeded' and lease.result_hash == result_hash:
                metrics['outcome'] = 'replayed'
                return receipt(lease)
            problem('COMPLETION_CONFLICT', '该租约已完成其他结果', 409)
        live(db, lease)
        result = checked_result(db, lease, stage, body)
        needs_head = stage.name == 'doc_zip'
        db.rollback()  # Final R2 verification never holds a DB transaction/mutex.
        if needs_head:
            metrics.update(phase='head', artifact_count=1)
            head_started = perf_counter()
            try:
                result['output_ref'] = get_document_store().verify(result['output_ref'])
            finally:
                metrics['head_ms'] = round((perf_counter() - head_started) * 1000, 3)
        metrics['phase'] = 'lock'
        lock_started = perf_counter()
        try:
            lock_scheduler(db)
        finally:
            metrics['lock_wait_ms'] = round((perf_counter() - lock_started) * 1000, 3)
        metrics['phase'] = 'commit'
        lease, stage = scoped(db, lease_id, body.lease_token, identity, body.workspace_generation)
        if lease.completed_at:
            if lease.outcome == 'succeeded' and lease.result_hash == result_hash:
                metrics['outcome'] = 'replayed'
                return receipt(lease)
            problem('COMPLETION_CONFLICT', '该租约已完成其他结果', 409)
        _, _, job = live(db, lease)
        if stage.name == 'doc_prepare':
            install_pages(db, job, result['pages'])
            result = {'page_count': len(result['pages'])}
        elif stage.name in ('doc_ocr', 'doc_render'):
            page = db.get(DocumentPage, (job.id, stage.page_index))
            if stage.name == 'doc_ocr':
                page.analysis_ref, page.text_ref = result['analysis_ref'], result['text']
                page.status = 'no_text' if body.no_text else 'ocr_done'
                if body.no_text:
                    page.output_ref, page.billable = page.input_ref, False
            else:
                page.output_ref, page.status = result['output_ref'], 'translated'
                page.billable = 'unrecognized_regions' not in body.quality_flags
            page.quality_flags = list(dict.fromkeys(body.quality_flags))
            result = {}  # Private OCR text is stored once in DocumentPage, not receipts.
        stage.status, stage.completed_at, stage.result = 'succeeded', now(), result
        lease.result_hash = result_hash
        release_lease(db, lease, 'succeeded')
        db.flush()
        on_stage_completed(db, job, stage)
        touch_job(db, job)
        db.commit()
        metrics['outcome'] = 'accepted'
        return receipt(lease)
    except DocumentStoreError:
        metrics['outcome'] = 'storage_error'
        raise
    except (HTTPException, ProcessingError):
        metrics['outcome'] = 'rejected'
        raise
    finally:
        metrics['total_ms'] = round((perf_counter() - started) * 1000, 3)
        log.info('document_compute_complete %s', json.dumps(metrics, separators=(',', ':')))
