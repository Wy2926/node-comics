"""Bounded oldest-first claims, frozen service preference and fenced leases."""
from datetime import timedelta
from dataclasses import dataclass
import hmac
from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.orm import aliased
from .assets import available
from .config import settings
from .errors import ProcessingError
from .models import Asset, Attempt, ClassicState, Job, Provider, now, uid
from .queue_models import ComputeNode, ExecutionLease, JobStage, SchedulerMutex
from .translation_models import TranslationProvider
from .translation_provider_limits import unavailable_providers

ACTIVE = {"awaiting_upload", "validating_upload", "queued", "running", "outcome_unknown"}
IMAGE_STAGES = {"page"}
CLAIM_BATCH_LIMIT = 4
CANDIDATE_LIMIT = 32


def lock_scheduler(db):
    # All scheduling/admission transactions use this lock before User/Job.
    # Model work and remote I/O never execute while holding it.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(761349211)"))
    else:
        db.execute(update(SchedulerMutex).where(SchedulerMutex.id == 1).values(revision=SchedulerMutex.revision))


def touch_job(db, job):
    lock_scheduler(db)
    job.changed_at = now()
    db.execute(update(SchedulerMutex).where(SchedulerMutex.id == 1)
        .values(revision=SchedulerMutex.revision + 1).returning(SchedulerMutex.revision)).scalar_one()
    from .notifications import publish
    publish(db, 'user:' + job.owner_id)
    publish(db, 'compute')


def ensure_stages(db, job):
    if not job.input_asset_id or job.status not in {"queued", "running"}:
        return
    names = ["page", "text"] if job.mode == "classic" else ["redraw"]
    existing = {s.name for s in db.scalars(select(JobStage).where(JobStage.job_id == job.id))}
    for name in names:
        if name not in existing:
            db.add(JobStage(job_id=job.id, name=name, status="ready" if name == names[0] else "waiting"))
    if job.mode == "classic" and db.get(ClassicState, job.id) is None:
        db.add(ClassicState(job_id=job.id))
    touch_job(db, job)
    db.flush()


def current_lease(db, lease_id, lease_token=None):
    lease = db.get(ExecutionLease, lease_id)
    if not lease or lease.completed_at or lease.expires_at <= now() or (lease_token is not None and not hmac.compare_digest(lease.token, lease_token)):
        raise ProcessingError("LEASE_EXPIRED", "执行授权已失效")
    stage = db.get(JobStage, lease.stage_id)
    job = db.get(Job, lease.job_id)
    if (not stage or stage.generation != lease.generation or stage.status != "running" or not job
            or job.status != "running" or job.cancel_requested or job.discard_output):
        raise ProcessingError("LEASE_EXPIRED", "任务已停止或执行代次已更新")
    return lease, stage, job


def pool_for(stage):
    return "image" if stage.name in IMAGE_STAGES else "upload" if stage.name == "validate_upload" else stage.name


def _eligible_stages(node, stages, at, *, stage_ids=None, blocked_providers=()):
    """Shared admission predicates, without ordering."""
    image_stage = JobStage.name.in_(IMAGE_STAGES)
    eligible = (select(JobStage.id).select_from(JobStage).join(Job, Job.id == JobStage.job_id)
        .outerjoin(Asset, Asset.id == Job.input_asset_id)
        .where(JobStage.status == "ready", JobStage.name.in_(stages), JobStage.available_at <= at,
            Job.status.in_(["queued", "running", "validating_upload"]),
            Job.cancel_requested.is_(False), Job.discard_output.is_(False),
            or_(JobStage.name == "validate_upload", and_(Asset.id.is_not(None), Asset.deleted_at.is_(None),
                Asset.purged_at.is_(None), or_(Asset.expires_at.is_(None), Asset.expires_at > at, Asset.active_references > 0))),
            or_(~image_stage, and_(Job.target_language.in_(node.supported_languages),
                Job.config["engine"]["protocol_version"].as_integer() == 3))))
    if not (node.runtime_report or {}).get('overlay_tiles'):
        result_format = Job.config['result_format'].as_string()
        eligible = eligible.where(or_(JobStage.name != 'page', result_format.is_(None), result_format != 'overlay-tiles-v1'))
    if stage_ids is not None:
        eligible = eligible.where(JobStage.id.in_(stage_ids))
    if "text" in stages:
        eligible = (eligible.outerjoin(TranslationProvider, TranslationProvider.id == Job.config['text']['provider_id'].as_string())
            .where(or_(JobStage.name != 'text', and_(TranslationProvider.enabled.is_(True),
                TranslationProvider.id.not_in(blocked_providers)))))
    if "redraw" in stages:
        running_job, unknown_job = aliased(Job), aliased(Job)
        provider_id = Job.config["provider"]["id"].as_string()
        running = (select(func.count()).select_from(ExecutionLease).join(running_job, running_job.id == ExecutionLease.job_id)
            .where(ExecutionLease.resource_pool == "redraw", ExecutionLease.completed_at.is_(None),
                running_job.config["provider"]["id"].as_string() == Provider.id).correlate(Provider).scalar_subquery())
        unknown = select(func.count()).select_from(unknown_job).where(unknown_job.mode == "redraw",
            unknown_job.status == "outcome_unknown", unknown_job.config["provider"]["id"].as_string() == Provider.id).correlate(Provider).scalar_subquery()
        eligible = eligible.outerjoin(Provider, Provider.id == provider_id).where(or_(JobStage.name != "redraw",
            and_(Provider.enabled.is_(True), running + unknown < Provider.config["concurrency"].as_integer())))
    return eligible


def _candidate_rows(db, node, stages, at, *, stage_ids=None, materialize=True, blocked_providers=()):
    # Match ix_stage_ready: FIFO by ready/retry time, then a stable tie-breaker.
    # Fetch a small surplus so cancellations and missing inputs do not block a batch.
    query = _eligible_stages(node, stages, at, stage_ids=stage_ids, blocked_providers=blocked_providers)
    projection = (JobStage, Job) if materialize else (JobStage.id, JobStage.generation)
    query = query.with_only_columns(*projection).order_by(JobStage.available_at, JobStage.id).limit(CANDIDATE_LIMIT)
    rows = db.execute(query.execution_options(populate_existing=True)).all()
    if materialize and rows:
        # Service was purchased at admission, not at claim time. The last
        # reserved page, expiry and later membership changes cannot change it.
        # Legacy jobs already froze plan; no account/history lookup is needed.
        rows.sort(key=lambda row: -job_priority(row[1]))
    return rows


def job_priority(job):
    entitlement = job.entitlement or {}
    return int(entitlement.get('priority', entitlement.get('plan') not in (None, 'free', 'guest')))


def _preselect(db, node, allowed_stages, blocked_providers=()):
    # Reuse the caller's connection, including its uncommitted nodes/pages.
    # A second Session can deadlock a full pool while every claimant holds its
    # first connection. PostgreSQL READ COMMITTED rechecks after the mutex;
    # our SQLite driver does not BEGIN on SELECT, while pending DML already
    # owns its writer lock. Transaction ownership always stays with the caller.
    stages = set(node.capabilities) & set(allowed_stages or node.capabilities)
    if not node.enabled or not stages:
        return {}
    rows = _candidate_rows(db, node, stages, now(), materialize=False, blocked_providers=blocked_providers)
    return {row[0]: tuple(row[1:]) for row in rows}


def _blocked_providers(db, node, allowed_stages):
    if not node or 'text' not in (set(node.capabilities) & set(allowed_stages or node.capabilities)):
        return []
    return unavailable_providers(db.scalars(select(TranslationProvider).where(TranslationProvider.enabled.is_(True))).all())


def remaining_capacity(db, node):
    if not node or not node.enabled:
        return 0
    busy = db.scalar(select(func.count()).select_from(ExecutionLease).where(
        ExecutionLease.node_id == node.id, ExecutionLease.completed_at.is_(None)))
    return max(0, node.capacity - busy)


def has_claimable_work(db, node_id, allowed_stages=None, *, config_version=None):
    """An advisory read for long-poll wakeups; claim_batch remains authoritative."""
    with db.no_autoflush:
        node = db.get(ComputeNode, node_id)
        if not node or not node.enabled or (config_version is not None and config_version != node.config_version):
            return False
        stages = set(node.capabilities) & set(allowed_stages or node.capabilities)
        if not stages or not remaining_capacity(db, node):
            return False
        eligible = _eligible_stages(node, stages, now(), blocked_providers=_blocked_providers(db, node, stages))
        # Advisory only: claim retires missing local inputs. Never stat an entire backlog here.
        return bool(db.scalar(select(eligible.exists())))


def next_control_delay(db, maximum=5):
    """Bound idle reconciliation by retry deadlines and shared supplier RPM."""
    at = now()
    stages = ('text', 'redraw', 'validate_upload')
    pending = (select(JobStage.available_at).join(Job, Job.id == JobStage.job_id)
        .where(JobStage.name.in_(stages), JobStage.status == 'ready', JobStage.available_at > at,
            Job.status.in_(['queued', 'running', 'validating_upload']),
            Job.cancel_requested.is_(False), Job.discard_output.is_(False)))
    first = db.scalar(pending.order_by(JobStage.available_at).limit(1))
    delay = min(maximum, max(0, (first - at).total_seconds())) if first else maximum
    providers = db.execute(select(TranslationProvider.id, TranslationProvider.requests_per_minute).join(Job,
        Job.config['text']['provider_id'].as_string() == TranslationProvider.id)
        .join(JobStage, JobStage.job_id == Job.id).where(TranslationProvider.enabled.is_(True),
            JobStage.name == 'text', JobStage.status == 'ready', JobStage.available_at <= at,
            Job.status.in_(['queued', 'running']), Job.cancel_requested.is_(False), Job.discard_output.is_(False))
        .distinct()).all()
    from .redis_state import AdmissionUnavailable, window
    try:
        for provider in providers:
            retry = window('provider', provider.id, provider.requests_per_minute)['retry_after_seconds']
            if retry:
                delay = min(delay, retry)
    except AdmissionUnavailable:
        delay = min(delay, 1)
    return max(0, delay)


def claim_stage(db, node_id, allowed_stages=None, *, executor_id=None, config_version=None):
    leases = claim_batch(db, node_id, allowed_stages, limit=1, executor_id=executor_id, config_version=config_version)
    return leases[0] if leases else None


@dataclass(frozen=True)
class ClaimCandidates:
    node_id: str
    stages: tuple | None
    limit: int
    signatures: dict
    blocked_providers: tuple


def prepare_claim_candidates(db, node_id, allowed_stages=None, *, limit=CLAIM_BATCH_LIMIT):
    """A bounded, non-authoritative snapshot, usable before a receipt transaction."""
    limit = max(0, min(CLAIM_BATCH_LIMIT, limit))
    if db.new or db.dirty or db.deleted:
        # Internal callers may bring pending changes. Acquire the mutex before
        # their first autoflush; normal read-only claimers still elect outside it.
        with db.no_autoflush:
            lock_scheduler(db)
    observed_node = db.get(ComputeNode, node_id)
    can_prepare = bool(limit and remaining_capacity(db, observed_node))
    blocked = _blocked_providers(db, observed_node, allowed_stages) if can_prepare else ()
    candidates_before_lock = _preselect(db, observed_node, allowed_stages, blocked) if can_prepare else {}
    return ClaimCandidates(node_id, tuple(sorted(allowed_stages)) if allowed_stages is not None else None,
        limit, candidates_before_lock, tuple(blocked))


def claim_batch(db, node_id, allowed_stages=None, *, limit=CLAIM_BATCH_LIMIT, executor_id=None,
                config_version=None, prepared=None):
    """Select once outside the mutex, then dispatch a bounded batch.

    The caller owns commit/rollback. Recheck the bounded snapshot under the
    mutex, then account for this batch's capacity and provider usage.
    Receipt-based callers may prepare before acquiring their atomic receipt lock.
    """
    limit = max(0, min(CLAIM_BATCH_LIMIT, limit))
    if not limit:
        return []
    prepared = prepared or prepare_claim_candidates(db, node_id, allowed_stages, limit=limit)
    stages = tuple(sorted(allowed_stages)) if allowed_stages is not None else None
    if prepared.node_id != node_id or prepared.stages != stages:
        raise ValueError('Claim snapshot scope does not match the claimant')
    limit = min(limit, prepared.limit)
    candidates_before_lock, blocked = dict(prepared.signatures), prepared.blocked_providers
    with db.no_autoflush:
        lock_scheduler(db)
    node = db.get(ComputeNode, node_id, populate_existing=True)
    at = now()
    if not node or not node.enabled:
        return []
    if config_version is not None and config_version != node.config_version:
        raise ProcessingError('NODE_CONFIG_CONFLICT', '领取前需要同步配置')
    node.heartbeat_at = at
    limit = min(limit, remaining_capacity(db, node))
    if not limit or not candidates_before_lock:
        return []
    leases = []
    for stage, job in _claimable_candidates(db, node, allowed_stages, at, candidates_before_lock, blocked):
        if len(leases) == limit:
            break
        # Only supplier concurrency can change eligibility as this transaction
        # adds leases; recheck that one stage instead of reloading every job,
        # membership and source file for every page of the same batch.
        if stage.name == 'redraw' and leases and not db.scalar(select(
                _eligible_stages(node, {'redraw'}, at, stage_ids=[stage.id]).exists())):
            continue
        leases.append(_start_lease(db, node, stage, job, at, executor_id))
    return leases


def _claimable_candidates(db, node, allowed_stages, at, candidates_before_lock, blocked):
    stages = set(node.capabilities) & set(allowed_stages or node.capabilities)
    # The full election ran without the mutex. Recheck only this bounded set
    # under the lock, using current queue/provider/asset/node and stage state.
    candidates = [(stage, job) for stage, job in _candidate_rows(db, node, stages, at,
        stage_ids=candidates_before_lock, blocked_providers=blocked)
        if (stage.generation,) == candidates_before_lock[stage.id]]
    if not candidates:
        return []
    sources = {job.input_asset_id for stage, job in candidates if stage.name != "validate_upload"}
    assets = {row.id: row for row in db.scalars(select(Asset).where(Asset.id.in_(sources)).execution_options(populate_existing=True))}
    available_sources = {asset_id: available(asset) for asset_id, asset in assets.items()}
    failed_jobs = set()
    for stage, job in candidates:
        source = assets.get(job.input_asset_id)
        if (stage.name != "validate_upload" and source
                and not available_sources[source.id] and job.id not in failed_jobs):
            # SQL cannot test the isolated local filesystem. Retiring this
            # bounded invalid head lets the next election reach later pages;
            # silently skipping it would select the same missing head forever.
            from .uploads import pause_missing_input
            pause_missing_input(db, job)
            failed_jobs.add(job.id)
    return [(stage, job) for stage, job in candidates if job.id not in failed_jobs
        and (stage.name == "validate_upload" or available_sources.get(job.input_asset_id, False))]


def _start_lease(db, node, stage, job, at, executor_id):
    cfg = settings()
    if not job.attempt_id:
        job.attempt_id = uid()
        db.add(Attempt(id=job.attempt_id, job_id=job.id, provider_id=job.config["provider"]["id"],
                       lease_expires_at=at + timedelta(seconds=cfg.cluster_lease_seconds)))
    job.status, job.phase = "running", "analyze" if stage.name == "page" else stage.name
    stage.status, stage.generation, stage.attempts = "running", stage.generation + 1, stage.attempts + 1
    lease = ExecutionLease(id=uid(), stage_id=stage.id, job_id=job.id, node_id=node.id, owner_id=job.owner_id,
        executor_id=executor_id or (node.id if node.engine_version != "control" else None),
        generation=stage.generation, resource_pool=pool_for(stage), mode=job.mode, expires_at=at + timedelta(seconds=cfg.cluster_lease_seconds))
    if stage.name == 'page':
        from .node_config import NodeConfig
        config = NodeConfig.model_validate(node.desired_config)
        lease.limits = {'deadline_at': (at + timedelta(seconds=config.page_seconds)).isoformat() + 'Z',
                        'text_wait_seconds': config.text_wait_seconds, 'delivery_seconds': config.delivery_seconds,
                        'max_attempts': job.config.get('stage_attempts', cfg.cluster_stage_attempts)}
        lease.expires_at = min(lease.expires_at, at + timedelta(seconds=config.page_seconds))
    db.add(lease)
    touch_job(db, job)
    db.flush()
    return lease


def release_lease(db, lease, outcome):
    if lease.completed_at:
        return
    at = now()
    stage = db.get(JobStage, lease.stage_id)
    lease.completed_at, lease.outcome = at, outcome
    if stage.name == 'page':
        lease.limits = {**lease.limits, 'receipt': {'lease_id': lease.id, 'status': 'terminal',
            'outcome': outcome, 'result_hash': lease.result_hash, 'completed_at': at.isoformat() + 'Z',
            'job_status': db.get(Job, lease.job_id).status}}


def heartbeat_lease(db, lease_id, token):
    lock_scheduler(db)
    lease, stage, job = current_lease(db, lease_id, token)
    lease.expires_at = now() + timedelta(seconds=settings().cluster_lease_seconds)
    attempt = db.get(Attempt, job.attempt_id)
    attempt.heartbeat_at, attempt.lease_expires_at = now(), lease.expires_at
    db.get(ComputeNode, lease.node_id).heartbeat_at = now()
    return lease
