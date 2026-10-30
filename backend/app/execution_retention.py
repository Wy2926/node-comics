"""Small indexed maintenance batches; receipts and accounting are not payloads."""
from datetime import timedelta
from sqlalchemy import and_, delete, func, null, or_, select, text, tuple_, update
from .models import ClassicState, Job, TextCall, now, EXECUTION_RETENTION_FILTER
from .queue_models import ComputeClaim, ExecutionLease, JobStage
from .scheduler import lock_scheduler
from .system_settings import get_request_limits

TERMINAL = ('succeeded', 'no_text', 'failed', 'cancelled')


def unresolved_text():
    return (select(TextCall.id).where(TextCall.job_id == Job.id,
        or_(TextCall.completed_at.is_(None), TextCall.cost_state.not_in(('reported', 'estimated', 'confirmed'))))
        .correlate(Job).exists())


def resolved_job():
    """Do not discard data still used by a running or uncertain supplier call."""
    return and_(Job.status.in_(TERMINAL), Job.completed_at.is_not(None),
        Job.settlement.in_(('settled', 'released', 'included')),
        ~select(ExecutionLease.id).where(ExecutionLease.job_id == Job.id,
            ExecutionLease.completed_at.is_(None)).exists(),
        ~unresolved_text())


def image_details_due(at, days):
    return or_(and_(Job.quota_kind == 'guest_trial', Job.completed_at <= at - timedelta(days=1)),
        and_(Job.quota_kind != 'guest_trial', Job.completed_at <= at - timedelta(days=days)))


def compact_checkpoints(db, at, limits, batch):
    base = select(ClassicState).join(Job, Job.id == ClassicState.job_id).where(
        Job.workflow_kind == 'image', resolved_job())
    compact = list(db.scalars(base.where(ClassicState.retention_stage == 0)
        .order_by(ClassicState.job_id).limit(batch)))
    for state in compact:
        analysis = state.analysis or {}
        # /classic reads only these fields; masks and detector tensors are execution-only.
        state.analysis = {key: analysis[key] for key in ('segments', 'unrecognized_regions') if key in analysis}
        state.artifacts = {}
        state.retention_stage = 1
    db.flush()
    expired = list(db.scalars(base.where(ClassicState.retention_stage < 2,
        image_details_due(at, limits.image_result_retention_days),
        or_(Job.discard_output.is_(True), Job.status.in_(('failed', 'cancelled'))))
        .order_by(ClassicState.retention_stage, ClassicState.job_id).limit(batch)))
    for state in expired:
        state.analysis, state.translations, state.artifacts = None, {}, {}
        state.retention_stage = 2
    if expired:
        db.execute(update(Job).where(Job.id.in_([state.job_id for state in expired]))
            .values(result_description={}, changed_at=Job.changed_at))
    return {'checkpoints': len(compact), 'image_details': len(expired)}


def delete_claims(db, at, limits, batch):
    empty_cutoff = at - timedelta(days=limits.empty_claim_retention_days)
    done_cutoff = at - timedelta(days=limits.completed_claim_retention_days)
    elements = (func.json_array_elements_text(ComputeClaim.lease_ids) if db.get_bind().dialect.name == 'postgresql'
        else func.json_each(ComputeClaim.lease_ids)).table_valued('value')
    lease_ids = select(elements.c.value).correlate(ComputeClaim)
    unfinished = (select(ExecutionLease.id).join(Job, Job.id == ExecutionLease.job_id).where(
        ExecutionLease.id.in_(lease_ids), or_(ExecutionLease.completed_at.is_(None),
            ExecutionLease.completed_at > done_cutoff, Job.status.not_in(TERMINAL),
            Job.settlement.not_in(('settled', 'released', 'included')),
            Job.completed_at.is_(None), Job.completed_at > done_cutoff, unresolved_text()))
        .correlate(ComputeClaim).exists())
    candidates = (select(ComputeClaim.node_id, ComputeClaim.request_id).where(
        ComputeClaim.created_at <= max(empty_cutoff, done_cutoff),
        or_(and_(func.json_array_length(ComputeClaim.lease_ids) == 0, ComputeClaim.created_at <= empty_cutoff),
            and_(func.json_array_length(ComputeClaim.lease_ids) > 0,
                ComputeClaim.created_at <= done_cutoff, ~unfinished)))
        .order_by(ComputeClaim.created_at, ComputeClaim.node_id, ComputeClaim.request_id).limit(batch))
    return db.execute(delete(ComputeClaim).where(tuple_(ComputeClaim.node_id, ComputeClaim.request_id)
        .in_(candidates)).execution_options(synchronize_session=False)).rowcount


def purge_document_text(db, at, batch):
    from .documents.models import Document, DocumentPage
    has_text = or_(Document.text_input_payload.is_not(None), Document.text_output_payload.is_not(None),
        Document.text_input_ref.is_not(None), Document.text_output_ref.is_not(None),
        select(DocumentPage.job_id).where(DocumentPage.job_id == Document.job_id,
            or_(DocumentPage.text_ref.is_not(None), DocumentPage.translations_ref.is_not(None))).exists())
    ids = list(db.scalars(select(Document.job_id).join(Job, Job.id == Document.job_id).where(
        resolved_job(), Document.expires_at <= at, has_text).order_by(Document.expires_at).limit(batch)))
    if ids:
        db.execute(update(Document).where(Document.job_id.in_(ids)).values(text_input_payload=null(),
            text_output_payload=null(), text_input_ref=null(), text_output_ref=null()))
        db.execute(update(DocumentPage).where(DocumentPage.job_id.in_(ids))
            .values(text_ref=null(), translations_ref=null()))
    return len(ids)


def compact_history(db, at, limits, batch):
    from .documents.models import Document, DocumentPage
    cutoff = at - timedelta(days=limits.execution_detail_retention_days)
    ids = list(db.scalars(select(Job.id).where(text(EXECUTION_RETENTION_FILTER), resolved_job(),
        Job.completed_at <= cutoff,
        or_(Job.workflow_kind != 'image', and_(image_details_due(at, limits.image_result_retention_days),
            or_(Job.discard_output.is_(True), Job.status.in_(('failed', 'cancelled'))))),
        ~select(Document.job_id).where(Document.job_id == Job.id, Document.expires_at > at).exists())
        .order_by(Job.completed_at, Job.id).limit(batch)))
    for job in db.scalars(select(Job).where(Job.id.in_(ids))):
        # Keep identities, state, timestamps, quota and billing columns. No frozen prompts/config trees.
        config = {key: job.config[key] for key in ('font_id', 'result_format') if key in job.config}
        if job.workflow_kind == 'document':
            config.update(text={'provider_id': job.config['text']['provider_id']},
                document={'model_name': job.config['document']['model_name']})
        db.execute(update(Job).where(Job.id == job.id).values(config=config,
            result_description={}, details_compacted_at=at, changed_at=Job.changed_at))
    if ids:
        db.execute(delete(ClassicState).where(ClassicState.job_id.in_(ids)))
        # Minimal execution and cost receipts remain for duplicate acknowledgements and accounting.
        for lease in db.scalars(select(ExecutionLease).where(ExecutionLease.job_id.in_(ids))):
            lease.limits = {key: lease.limits[key] for key in ('receipt', 'document_protocol',
                'workspace_generation', 'output_key', 'max_output_bytes', 'output_ref') if key in lease.limits}
        for stage in db.scalars(select(JobStage).where(JobStage.job_id.in_(ids))):
            stage.result = {key: stage.result[key] for key in ('analysis_hash', 'analysis_generation', 'result_hash')
                if key in stage.result}
        # Attempt/TextCall usage and accounted_micros are financial evidence, not OCR/translation bodies.
        db.execute(update(DocumentPage).where(DocumentPage.job_id.in_(ids)).values(source_name='',
            input_ref=null(), analysis_ref=null(), text_ref=null(), translations_ref=null(), output_ref=null()))
    return len(ids)


def cleanup_execution_data(db, *, at=None, batch=20, claim_batch=1000):
    """One transaction per pass. No files, network calls, VACUUM or readiness dependencies."""
    lock_scheduler(db)
    at = at or now()
    limits = get_request_limits(db)
    counts = compact_checkpoints(db, at, limits, batch)
    counts['claims'] = delete_claims(db, at, limits, claim_batch)
    counts['document_text'] = purge_document_text(db, at, batch)
    counts['history'] = compact_history(db, at, limits, batch)
    return counts
