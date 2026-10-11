"""Fixed document stages. SQL is authority; large objects never enter this module."""
from datetime import timedelta
from sqlalchemy import func, select, update
from ..config import settings
from ..db import session_factory
from ..errors import ProcessingError
from ..models import Attempt, Job, now
from ..providers import digest
from ..queue_models import ComputeNode, ExecutionLease, JobStage
from ..scheduler import current_lease, lock_scheduler, release_lease, remaining_capacity, touch_job
from .models import Document, DocumentPage

CONTROL_STAGES = ('doc_text',)
TERMINAL = frozenset({'succeeded', 'failed', 'cancelled'})
NODE_ID = 'control-document'


def current(db, lease_id, token=None):
    lease, stage, job = current_lease(db, lease_id, token)
    if job.workflow_kind != 'document':
        raise ProcessingError('LEASE_EXPIRED', '执行授权不属于文件任务')
    document = db.get(Document, job.id)
    if lease.limits.get('workspace_generation') != document.workspace_generation:
        raise ProcessingError('LEASE_EXPIRED', '文件工作目录代次已更新')
    return lease, stage, job


def stage_for(db, job_id, name, page_index=0):
    return db.scalar(select(JobStage).where(JobStage.job_id == job_id,
        JobStage.name == name, JobStage.page_index == page_index))


def ensure_prepare(db, job):
    if job.status in TERMINAL or job.cancel_requested:
        return
    if not stage_for(db, job.id, 'doc_prepare'):
        db.add(JobStage(job_id=job.id, name='doc_prepare', page_index=0, status='ready'))
    job.status, job.phase = 'preflight', 'doc_prepare'
    touch_job(db, job)


def install_pages(db, job, pages):
    """Commit a verified bounded manifest together, before any OCR admission."""
    document = db.get(Document, job.id)
    if not 1 <= len(pages) <= 200 or [p['page_index'] for p in pages] != list(range(1, len(pages) + 1)):
        raise ProcessingError('DOCUMENT_PAGE_COUNT', '文件必须包含 1–200 页')
    if job.cancel_requested:
        raise ProcessingError('LEASE_EXPIRED', '文件预检已结束')
    existing = list(db.scalars(select(DocumentPage).where(DocumentPage.job_id == job.id)))
    if existing:
        # Rebuilding a lost workspace keeps the original page allocations. The
        # same immutable source must reproduce exactly the frozen manifest.
        if document.manifest_sha256 != digest(pages) or len(existing) != len(pages):
            raise ProcessingError('DOCUMENT_MANIFEST_CONFLICT', '重建页面与已冻结清单不一致')
        return
    document.page_count = len(pages)
    document.manifest_sha256 = digest(pages)
    for page in pages:
        db.add(DocumentPage(job_id=job.id, page_index=page['page_index'],
            source_name=page['source_name'], input_ref=page['input_ref']))
        for name in ('doc_ocr', 'doc_render'):
            db.add(JobStage(job_id=job.id, name=name, page_index=page['page_index'], status='waiting'))
    for name in ('doc_text', 'doc_zip'):
        db.add(JobStage(job_id=job.id, name=name, page_index=0, status='waiting'))
    db.flush()


def start_pages(db, job):
    document = db.get(Document, job.id)
    if document.reserved_at is None or job.cancel_requested or job.status in TERMINAL:
        raise ProcessingError('DOCUMENT_NOT_RESERVED', '文件未预占额度，不能开始识别')
    for stage in db.scalars(select(JobStage).where(JobStage.job_id == job.id,
            JobStage.name == 'doc_ocr', JobStage.status == 'waiting')):
        stage.status, stage.available_at = 'ready', now()
    job.status, job.phase = 'queued', 'doc_ocr'
    touch_job(db, job)


def _all_done(db, job_id, name):
    db.flush()
    return not db.scalar(select(JobStage.id).where(JobStage.job_id == job_id,
        JobStage.name == name, JobStage.status != 'succeeded').limit(1))


def _ready(db, job, name):
    stage = stage_for(db, job.id, name)
    if stage.status == 'waiting':
        stage.status, stage.available_at = 'ready', now()
    job.phase = name


def on_stage_completed(db, job, stage):
    """Called under the scheduler mutex after durable object validation."""
    document = db.get(Document, job.id)
    if stage.name == 'doc_prepare':
        from .quota import reserve_document
        if reserve_document(db, job):
            start_pages(db, job)
    elif stage.name == 'doc_ocr' and _all_done(db, job.id, 'doc_ocr'):
        pages = list(db.execute(select(DocumentPage.page_index, DocumentPage.status).where(DocumentPage.job_id == job.id)))
        silent = [page.page_index for page in pages if page.status == 'no_text']
        if silent:
            db.execute(update(JobStage).where(JobStage.job_id == job.id,
                JobStage.name == 'doc_render', JobStage.page_index.in_(silent))
                .values(status='succeeded', completed_at=now()))
        if any(page.status != 'no_text' for page in pages):
            _ready(db, job, 'doc_text')
        else:
            text_stage = stage_for(db, job.id, 'doc_text')
            text_stage.status, text_stage.completed_at = 'succeeded', now()
            document.text_state = 'skipped'
            _ready(db, job, 'doc_zip')
    elif stage.name == 'doc_text':
        missing = db.scalar(select(DocumentPage.page_index).where(DocumentPage.job_id == job.id,
            DocumentPage.status != 'no_text', DocumentPage.translations_ref['revision'].as_string().is_(None)).limit(1))
        if missing:
            raise ProcessingError('DOCUMENT_TEXT_MISSING', '整本译文尚未完整持久化')
        for render in db.scalars(select(JobStage).where(JobStage.job_id == job.id,
                JobStage.name == 'doc_render', JobStage.status == 'waiting')):
            render.status, render.available_at = 'ready', now()
        job.phase = 'doc_render'
        if _all_done(db, job.id, 'doc_render'):
            _ready(db, job, 'doc_zip')
    elif stage.name == 'doc_render' and _all_done(db, job.id, 'doc_render'):
        _ready(db, job, 'doc_zip')
    elif stage.name == 'doc_zip':
        from .config import get_document_settings
        from .quota import settle_document
        pages = list(db.execute(select(DocumentPage.status, DocumentPage.output_ref).where(DocumentPage.job_id == job.id)))
        if len(pages) != document.page_count or any(p.status not in {'translated', 'no_text'} or not p.output_ref for p in pages):
            raise ProcessingError('DOCUMENT_OUTPUT_INCOMPLETE', '译图不完整，不能发布压缩包')
        document.output_ref = stage.result['output_ref']
        document.expires_at = now() + timedelta(days=get_document_settings().output_retention_days)
        document.cleanup_after = now() + timedelta(hours=1)
        job.status, job.phase, job.completed_at = 'succeeded', 'completed', now()
        settle_document(db, job, success=True)
        if job.attempt_id:
            db.get(Attempt, job.attempt_id).completed_at = now()
    touch_job(db, job)


def finish_failed(db, job, error):
    from .quota import settle_document
    job.status, job.phase, job.completed_at = 'failed', 'failed', now()
    job.error_code, job.error_message = error.code, error.message
    for stage in db.scalars(select(JobStage).where(JobStage.job_id == job.id,
            JobStage.status.in_(['waiting', 'ready']))):
        stage.status = 'cancelled'
    settle_document(db, job, success=False)
    db.get(Document, job.id).cleanup_after = now() + timedelta(hours=1)
    if job.attempt_id:
        db.get(Attempt, job.attempt_id).completed_at = now()


def complete_control(lease_id, result):
    with session_factory()() as db:
        lock_scheduler(db)
        lease = db.get(ExecutionLease, lease_id)
        result_hash = digest(result)
        if lease and lease.completed_at and lease.outcome == 'succeeded' and lease.result_hash == result_hash:
            return
        lease, stage, job = current(db, lease_id)
        if stage.name not in CONTROL_STAGES:
            raise ProcessingError('LEASE_EXPIRED', '不是文件控制阶段')
        stage.result, stage.status, stage.completed_at = result, 'succeeded', now()
        lease.result_hash = result_hash
        release_lease(db, lease, 'succeeded')
        on_stage_completed(db, job, stage)
        db.commit()


def reset_workspace(db, job, document):
    """Before any LLM send, rebuild on the same owner without reserving twice."""
    prepare = stage_for(db, job.id, 'doc_prepare')
    if prepare is None or prepare.attempts >= settings().cluster_stage_attempts:
        return False
    document.workspace_generation += 1
    for lease in db.scalars(select(ExecutionLease).where(ExecutionLease.job_id == job.id,
            ExecutionLease.completed_at.is_(None))):
        release_lease(db, lease, 'failed')
    for stage in db.scalars(select(JobStage).where(JobStage.job_id == job.id)):
        stage.status = 'ready' if stage.name == 'doc_prepare' else 'waiting'
        stage.result, stage.completed_at, stage.available_at = {}, None, now()
    for page in db.scalars(select(DocumentPage).where(DocumentPage.job_id == job.id)):
        page.analysis_ref = page.text_ref = page.translations_ref = page.output_ref = None
        page.status, page.quality_flags, page.billable = 'pending', [], False
    job.status, job.phase, job.error_code, job.error_message = 'queued', 'doc_prepare', None, None
    return True


def fail_lease(lease_id, error, *, token=None, node_id=None, recovering=False, workspace_generation=None):
    from ..workers import _scoped
    with session_factory()() as db:
        lock_scheduler(db)
        lease = db.get(ExecutionLease, lease_id)
        _scoped(lease, token, node_id)
        if lease.completed_at or (recovering and lease.expires_at > now()):
            return
        stage, job = db.get(JobStage, lease.stage_id), db.get(Job, lease.job_id)
        if stage.generation != lease.generation or job.workflow_kind != 'document':
            raise ProcessingError('LEASE_EXPIRED', '文件执行代次已更新')
        document = db.get(Document, job.id)
        if (lease.limits.get('workspace_generation') != document.workspace_generation
                or workspace_generation is not None and workspace_generation != document.workspace_generation):
            raise ProcessingError('LEASE_EXPIRED', '文件工作目录代次已更新')
        if job.status in TERMINAL or job.cancel_requested:
            stage.status = 'cancelled'
        elif error.code == 'DOCUMENT_WORKSPACE_MISSING':
            if document.text_state == 'pending' and document.text_call_id is None and reset_workspace(db, job, document):
                pass
            elif document.text_state in {'sending', 'unknown'}:
                stage.status = 'waiting'
                document.text_state = 'unknown'
                job.status, job.phase, job.unknown_since = 'outcome_unknown', 'doc_text', job.unknown_since or now()
                job.error_code, job.error_message = 'DOCUMENT_WORKSPACE_MISSING', '工作目录丢失，整本调用结果待核实，不会重复发送'
            else:
                stage.status = 'failed'
                finish_failed(db, job, error)
        elif stage.name == 'doc_text' and document.text_state in {'sending', 'unknown'}:
            # An upstream call may still exist. Never turn lease expiry into a
            # second full-document request, or release its quota speculatively.
            stage.status = 'waiting'
            document.text_state = 'unknown'
            job.status, job.phase, job.unknown_since = 'outcome_unknown', 'doc_text', job.unknown_since or now()
            job.error_code, job.error_message = 'DOCUMENT_TEXT_OUTCOME_UNKNOWN', '整本文本调用结果待核实，不会自动重复发送'
        elif (stage.name == 'doc_text' and document.text_state == 'pending'
                and error.code in {'TEXT_RATE_LIMITED', 'TEXT_PROVIDER_DISABLED', 'ADMISSION_UNAVAILABLE'}):
            stage.status, stage.available_at = 'ready', now() + timedelta(seconds=max(2, min(3600, getattr(error, 'retry_after', 5))))
            stage.attempts = max(0, stage.attempts - 1)
        elif ((error.code in {'STORAGE_UNAVAILABLE', 'DOCUMENT_STORAGE_UNAVAILABLE', 'WORKER_LEASE_EXPIRED',
                    'CLASSIC_ENGINE_UNAVAILABLE', 'CLASSIC_LOCAL_INTERRUPTED', 'CLASSIC_ANALYZE_FAILED',
                    'CLASSIC_INPAINT_FAILED', 'CLASSIC_RENDER_FAILED', 'ENGINE_UNAVAILABLE',
                    'LEASE_STOPPED', 'DOCUMENT_TRANSFER_FAILED'}
                or (stage.name == 'doc_text' and error.code == 'LEASE_EXPIRED'
                    and document.text_state == 'received' and document.text_call_id and document.text_output_ref
                    # The reply can commit just before current() notices expiry,
                    # before heartbeat/recovery has marked the lease lost. Reuse
                    # that same DB reply; its full hash is checked outside this lock.
                    and db.scalar(select(Document.text_output_payload['call_id'].as_string())
                        .where(Document.job_id == job.id)) == document.text_call_id))
                and stage.attempts < settings().cluster_stage_attempts):
            stage.status, stage.available_at = 'ready', now() + timedelta(seconds=min(30, stage.attempts * 2))
        else:
            stage.status = 'failed'
            finish_failed(db, job, error)
        release_lease(db, lease, 'cancelled' if job.cancel_requested else 'failed')
        touch_job(db, job)
        db.commit()


def expire_offline_workspaces(limit=50):
    """Bound a fixed owner's recovery wait without guessing an upstream result."""
    from .config import get_document_settings
    cutoff = now() - timedelta(hours=get_document_settings().waiting_retention_hours)
    with session_factory()() as db:
        candidate_ids = list(db.scalars(select(Job.id).join(Document, Document.job_id == Job.id)
            .join(ComputeNode, ComputeNode.id == Document.owner_node_id).where(
                Job.workflow_kind == 'document', Job.status.not_in((*TERMINAL, 'outcome_unknown')),
                Document.reserved_at.is_not(None),
                func.coalesce(ComputeNode.heartbeat_at, Document.reserved_at) <= cutoff,
                ~select(ExecutionLease.id).where(ExecutionLease.job_id == Job.id,
                    ExecutionLease.completed_at.is_(None)).exists())
            .order_by(Document.reserved_at, Job.id).limit(limit)))
    changed = 0
    for job_id in candidate_ids:
        with session_factory()() as db:
            lock_scheduler(db)
            job, document = db.get(Job, job_id), db.get(Document, job_id)
            node = db.get(ComputeNode, document.owner_node_id) if document.owner_node_id else None
            if (job.status in TERMINAL or job.status == 'outcome_unknown' or not document.reserved_at or not node
                    or (node.heartbeat_at or document.reserved_at) > cutoff
                    or db.scalar(select(ExecutionLease.id).where(ExecutionLease.job_id == job_id,
                        ExecutionLease.completed_at.is_(None)).limit(1))):
                continue
            error = ProcessingError('DOCUMENT_OWNER_UNAVAILABLE', '文件宿主超过恢复宽限仍未上线，无法继续交付')
            if document.text_state in {'sending', 'unknown'} or document.text_state == 'pending' and document.text_call_id:
                document.text_state = 'unknown'
                job.status, job.phase, job.unknown_since = 'outcome_unknown', 'doc_text', job.unknown_since or now()
                job.error_code, job.error_message = error.code, '文件宿主长期失联，整本调用结果待核实，不会重复发送'
                stage = stage_for(db, job_id, 'doc_text')
                if stage and stage.status != 'succeeded':
                    stage.status = 'waiting'
            else:
                finish_failed(db, job, error)
            touch_job(db, job)
            db.commit()
            changed += 1
    return changed


def claim_control(db, executor_id):
    """One shared, bounded background pool, independent of API upload/text pools."""
    from ..scheduler import start_lease
    from .config import get_document_settings
    cfg = get_document_settings()
    # Indexed bounded candidate election outside the global admission lock.
    candidate_ids = list(db.scalars(select(JobStage.id).join(Job, Job.id == JobStage.job_id)
        .join(Document, Document.job_id == Job.id).where(
        Job.workflow_kind == 'document', Job.status.in_(['preflight', 'queued', 'running']),
        Document.owner_node_id.is_not(None),
        Job.cancel_requested.is_(False), JobStage.name.in_(CONTROL_STAGES),
        JobStage.status == 'ready', JobStage.available_at <= now())
        .order_by(JobStage.available_at, JobStage.id).limit(32)))
    lock_scheduler(db)
    node = db.get(ComputeNode, NODE_ID, populate_existing=True)
    if node is None:
        node = ComputeNode(id=NODE_ID, name='文件后台处理', resource_id=NODE_ID,
            capabilities=list(CONTROL_STAGES), capacity=cfg.worker_slots, engine_version='control', device='network',
            desired_config={'execution_slots': cfg.worker_slots}, applied_config_version=1)
        db.add(node)
        db.flush()
    node.heartbeat_at = now()
    if not candidate_ids or not remaining_capacity(db, node):
        return None
    row = db.execute(select(JobStage, Job).join(Job, Job.id == JobStage.job_id).where(
        JobStage.id.in_(candidate_ids), JobStage.status == 'ready', JobStage.available_at <= now(),
        Job.cancel_requested.is_(False), Job.status.in_(['preflight', 'queued', 'running']))
        .order_by(JobStage.available_at, JobStage.id).limit(1).execution_options(populate_existing=True)).first()
    if not row:
        return None
    lease = start_lease(db, node, row[0], row[1], now(), executor_id)
    lease.limits = {'workspace_generation': db.get(Document, row[1].id).workspace_generation}
    return lease
