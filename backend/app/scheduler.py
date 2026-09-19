"""Work-conserving weighted stage scheduling. No broker, prefetch or local counters."""
from datetime import timedelta
import hmac
from sqlalchemy import and_, case, func, literal, or_, select, text, update
from sqlalchemy.orm import aliased
from .assets import available
from .config import settings
from .entitlements import is_plus
from .errors import ProcessingError
from .models import Asset, Attempt, ClassicState, Job, Provider, TextCall, User, now, uid
from .queue_models import ComputeNode, ExecutionLease, FairnessState, JobStage, SchedulerMutex, UserModeQueue
from .translation_models import TranslationProvider

ACTIVE = {"awaiting_upload", "validating_upload", "queued", "running", "outcome_unknown"}
IMAGE_STAGES = {"page"}


def lock_scheduler(db):
    # All scheduling/admission/priority transactions use this lock before User/Job.
    # Model work and remote I/O never execute while holding it.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(761349211)"))
    else:
        db.execute(update(SchedulerMutex).where(SchedulerMutex.id == 1).values(revision=SchedulerMutex.revision))


def limits_for(user):
    cfg, plus = settings(), is_plus(user)
    return {"capacity": min(cfg.plus_queue_capacity, 10) if plus else min(cfg.free_queue_capacity, 3),
            "realtime_limit": min(cfg.plus_realtime_slots, 10) if plus else min(cfg.free_realtime_slots, 3),
            "weight": cfg.plus_scheduler_weight if plus else cfg.free_scheduler_weight}


def queue_for(db, owner_id, mode):
    row = db.get(UserModeQueue, (owner_id, mode))
    if row is None:
        row = UserModeQueue(owner_id=owner_id, mode=mode)
        db.add(row)
        db.flush()
    return row


def active_count(db, owner_id, mode=None):
    query = select(func.count()).select_from(Job).where(Job.owner_id == owner_id, Job.status.in_(ACTIVE))
    if mode is not None:
        query = query.where(Job.mode == mode)
    return db.scalar(query)


def touch_job(db, job):
    lock_scheduler(db)
    job.changed_at = now()
    job.change_sequence = db.execute(update(SchedulerMutex).where(SchedulerMutex.id == 1)
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


def _state(db, key, baseline=0):
    row = db.get(FairnessState, key)
    if row is None:
        row = FairnessState(key=key, service=baseline)
        db.add(row)
        db.flush()
    return row


def pool_for(job, stage):
    if stage.name in IMAGE_STAGES:
        return "image:" + job.config.get("engine", {}).get("version", settings().classic_engine_version)
    return "upload" if stage.name == "validate_upload" else stage.name


def priority_of(job, at):
    return "realtime" if job.realtime_until and job.realtime_until > at else "preload"


def _estimate(db, pool, stage, records=None):
    key = "estimate:" + pool + ":" + stage.name
    record = records.get(key) if records is not None else db.get(FairnessState, key)
    return max(0.05, min(120, record.service if record else {"validate_upload": 1, "page": 30, "text": 10, "redraw": 60}[stage.name]))


def _election_rows(db, node, stages, at, *, stage_ids=None, materialize=True):
    """Elect in SQL before materializing: <= two owners per pool and class.

    Eligibility precedes ranking, so an arbitrarily deep paused/unsupported
    backlog cannot conceal a runnable user. Two heads preserve the virtual
    service floor after the winning account consumes its next quantum.
    """
    cfg = settings()
    source, account, clock = aliased(Asset), aliased(FairnessState), aliased(FairnessState)
    image_stage = JobStage.name.in_(IMAGE_STAGES)
    pool = case((image_stage, literal("image:") + func.coalesce(Job.config["engine"]["version"].as_string(), cfg.classic_engine_version)),
                (JobStage.name == "validate_upload", literal("upload")), else_=JobStage.name)
    cls = case((Job.realtime_until > at, literal("realtime")), else_=literal("preload"))
    page_order = [case((and_(Job.created_at < at - timedelta(minutes=30), cls == "preload"), 0), else_=1),
        case((UserModeQueue.session_expires_at > at, Job.priority_rank), else_=1000000),
        Job.created_at, Job.ordinal, JobStage.id]
    eligible = select(JobStage.id.label("stage_id"), Job.id.label("job_id"), Job.owner_id.label("owner_id"),
        pool.label("pool"), cls.label("priority_class"),
        func.row_number().over(partition_by=[pool, cls, Job.owner_id], order_by=page_order).label("page_rank"))
    eligible = (eligible.join(Job, Job.id == JobStage.job_id)
        .outerjoin(source, source.id == Job.input_asset_id)
        .outerjoin(UserModeQueue, and_(UserModeQueue.owner_id == Job.owner_id, UserModeQueue.mode == Job.mode))
        .where(JobStage.status == "ready", JobStage.name.in_(stages), JobStage.available_at <= at,
            Job.status.in_(["queued", "running", "validating_upload"]),
            Job.cancel_requested.is_(False), Job.discard_output.is_(False),
            or_(UserModeQueue.owner_id.is_(None), UserModeQueue.paused.is_(False)),
            or_(JobStage.name == "validate_upload", and_(source.id.is_not(None), source.deleted_at.is_(None),
                source.purged_at.is_(None), or_(source.expires_at.is_(None), source.expires_at > at, source.active_references > 0))),
            or_(~image_stage, and_(Job.target_language.in_(node.supported_languages),
                func.coalesce(Job.config["engine"]["version"].as_string(), cfg.classic_engine_version) == node.engine_version))))
    if stage_ids is not None:
        eligible = eligible.where(JobStage.id.in_(stage_ids))
    if "text" in stages:
        recent = (select(TextCall.provider_id, func.count().label('calls'))
            .where(TextCall.started_at > at - timedelta(minutes=1),
                   or_(TextCall.error_code.is_(None), TextCall.error_code != 'TEXT_PROVIDER_DISABLED'))
            .group_by(TextCall.provider_id).subquery())
        eligible = (eligible.outerjoin(TranslationProvider, TranslationProvider.id == Job.config['text']['provider_id'].as_string())
            .outerjoin(recent, recent.c.provider_id == TranslationProvider.id)
            .where(or_(JobStage.name != 'text', and_(TranslationProvider.enabled.is_(True),
                func.coalesce(recent.c.calls, 0) < TranslationProvider.requests_per_minute))))
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
    pages = eligible.subquery()
    floor = func.coalesce(clock.service, 0.0)
    service = case((account.key.is_(None), floor),
        (and_(account.updated_at < at - timedelta(seconds=60), account.service < floor), floor), else_=account.service)
    heads = (select(pages.c.stage_id, pages.c.job_id,
        func.row_number().over(partition_by=[pages.c.pool, pages.c.priority_class],
            order_by=[service, func.coalesce(account.updated_at, at), pages.c.owner_id]).label("owner_rank"))
        .outerjoin(account, account.key == literal("user:") + pages.c.pool + ":" + pages.c.priority_class + ":" + pages.c.owner_id)
        .outerjoin(clock, clock.key == literal("clock:") + pages.c.pool + ":" + pages.c.priority_class)
        .where(pages.c.page_rank == 1).subquery())
    projection = [JobStage, Job, func.coalesce(UserModeQueue.version, 0)] if materialize else [
        JobStage.id, JobStage.generation, Job.priority_rank, Job.realtime_until, func.coalesce(UserModeQueue.version, 0)]
    return db.execute(select(*projection).join(Job, Job.id == JobStage.job_id)
        .outerjoin(UserModeQueue, and_(UserModeQueue.owner_id == Job.owner_id, UserModeQueue.mode == Job.mode))
        .join(heads, heads.c.stage_id == JobStage.id).where(heads.c.owner_rank <= 2)
        .execution_options(populate_existing=True)).all()


def _candidate_signature(stage, job, queue_version):
    return stage.generation, job.priority_rank, job.realtime_until, queue_version


def _preselect(db, node, allowed_stages):
    # Reuse the caller's connection, including its uncommitted nodes/pages.
    # A second Session can deadlock a full pool while every claimant holds its
    # first connection. PostgreSQL READ COMMITTED rechecks after the mutex;
    # our SQLite driver does not BEGIN on SELECT, while pending DML already
    # owns its writer lock. Transaction ownership always stays with the caller.
    stages = set(node.capabilities) & set(allowed_stages or node.capabilities)
    if not node.enabled or not stages:
        return {}
    rows = _election_rows(db, node, stages, now(), materialize=False)
    return {row[0]: tuple(row[1:]) for row in rows}


def claim_stage(db, node_id, allowed_stages=None, *, executor_id=None, config_version=None):
    if db.new or db.dirty or db.deleted:
        # Internal callers may bring pending changes. Acquire the mutex before
        # their first autoflush; normal read-only claimers still elect outside it.
        with db.no_autoflush:
            lock_scheduler(db)
    observed_node = db.get(ComputeNode, node_id)
    candidates_before_lock = _preselect(db, observed_node, allowed_stages) if observed_node else {}
    lock_scheduler(db)
    node = db.get(ComputeNode, node_id, populate_existing=True)
    at = now()
    if not node or not node.enabled:
        return None
    if config_version is not None and config_version != node.config_version:
        raise ProcessingError('NODE_CONFIG_CONFLICT', '领取前需要同步配置')
    node.heartbeat_at = at
    busy = db.scalar(select(func.count()).select_from(ExecutionLease).where(ExecutionLease.node_id == node.id, ExecutionLease.completed_at.is_(None)))
    if busy >= node.capacity:
        return None
    if not candidates_before_lock:
        return None
    stages = set(node.capabilities) & set(allowed_stages or node.capabilities)
    # The full election ran without the mutex. Recheck only this bounded set
    # under the lock, using current queue/provider/asset/node and stage state.
    candidates = [(stage, job) for stage, job, version in _election_rows(db, node, stages, at, stage_ids=candidates_before_lock)
        if _candidate_signature(stage, job, version) == candidates_before_lock[stage.id]]
    if not candidates:
        return None
    sources = {job.input_asset_id for stage, job in candidates if stage.name != "validate_upload"}
    assets = {row.id: row for row in db.scalars(select(Asset).where(Asset.id.in_(sources)).execution_options(populate_existing=True))}
    available_sources = {asset_id: available(asset) for asset_id, asset in assets.items()}
    failed_jobs = set()
    for stage, job in candidates:
        source = assets.get(job.input_asset_id)
        if (stage.name != "validate_upload" and source and source.storage_backend == "local"
                and not available_sources[source.id] and job.id not in failed_jobs):
            # SQL cannot test the isolated local filesystem. Retiring this
            # bounded invalid head lets the next election reach later pages;
            # silently skipping it would select the same missing head forever.
            from .workers import finish_job
            finish_job(db, job, "failed", error=ProcessingError("LOCAL_SOURCE_MISSING", "本地原图已丢失，请重新导入后重试"))
            stage.status, stage.completed_at = "failed", at
            failed_jobs.add(job.id)
    candidates = [(stage, job) for stage, job in candidates if job.id not in failed_jobs
        and (stage.name == "validate_upload" or available_sources.get(job.input_asset_id, False))]
    if not candidates:
        return None
    owners = {job.owner_id for _, job in candidates}
    queues = {(row.owner_id, row.mode): row for row in db.scalars(select(UserModeQueue)
        .where(UserModeQueue.owner_id.in_(owners)).execution_options(populate_existing=True))}
    for _, job in candidates:
        if (job.owner_id, job.mode) not in queues:
            queues[(job.owner_id, job.mode)] = queue_for(db, job.owner_id, job.mode)
    snapshot = {"users": {row.id: row for row in db.scalars(select(User).where(User.id.in_(owners)).execution_options(populate_existing=True))},
                "queues": queues}
    # Resource pools are independent; users cannot gain share by opening more batches.
    groups = {}
    for stage, job in candidates:
        pool = pool_for(job, stage)
        groups.setdefault(pool, []).append((stage, job))
    keys = set()
    for pool, entries in groups.items():
        for cls in ("realtime", "preload"):
            keys.update((f"class:{pool}:{cls}", f"clock:{pool}:{cls}"))
        for stage, job in entries:
            keys.update((f"estimate:{pool}:{stage.name}", f"user:{pool}:{priority_of(job, at)}:{job.owner_id}"))
    records = {row.key: row for row in db.scalars(select(FairnessState).where(FairnessState.key.in_(keys)))}

    def state(key, baseline=0):
        if key not in records:
            records[key] = FairnessState(key=key, service=baseline, updated_at=at)
            db.add(records[key])
        return records[key]

    choices = []
    cfg = settings()
    for pool, entries in groups.items():
        classes = {priority_of(job, at) for _, job in entries}
        cls_states = {c: state(f"class:{pool}:{c}") for c in ("realtime", "preload")}
        if len(classes) == 1:
            only = next(iter(classes))
            other = "preload" if only == "realtime" else "realtime"
            # No accumulated inactive credit. One quantum permits prompt realtime re-entry.
            cls_states[other].service = cls_states[only].service
        chosen_class = min(classes, key=lambda c: (cls_states[c].service, 0 if c == "realtime" else 1))
        selected = [(s, j) for s, j in entries if priority_of(j, at) == chosen_class]
        floor = state(f"clock:{pool}:{chosen_class}")
        by_user = {}
        for stage, job in selected:
            by_user.setdefault(job.owner_id, []).append((stage, job))
        accounts = {}
        for owner_id in by_user:
            record = state(f"user:{pool}:{chosen_class}:{owner_id}", floor.service)
            # An idle account never accumulates more than one estimated task of credit.
            if record.updated_at < at - timedelta(seconds=60):
                record.service = max(record.service, floor.service)
            accounts[owner_id] = record
        owner = min(accounts, key=lambda key: (accounts[key].service, accounts[key].updated_at, key))
        stage, job = min(by_user[owner], key=lambda pair: (
            0 if pair[1].created_at < at - timedelta(minutes=30) and chosen_class == "preload" else 1,
            pair[1].priority_rank if snapshot["queues"][(owner, pair[1].mode)].session_expires_at and snapshot["queues"][(owner, pair[1].mode)].session_expires_at > at else 1000000,
            pair[1].created_at, pair[1].ordinal, pair[0].id))
        choices.append((0 if chosen_class == "realtime" else 1, cls_states[chosen_class].updated_at,
                        stage, job, pool, chosen_class, accounts[owner], cls_states[chosen_class], floor, accounts))
    _, _, stage, job, pool, cls, user_state, class_state, floor, accounts = min(choices, key=lambda v: (v[0], v[1]))
    weight = limits_for(snapshot["users"][job.owner_id])["weight"]
    estimate = _estimate(db, pool, stage, records)
    share = cfg.realtime_share if cls == "realtime" else 1 - cfg.realtime_share
    user_state.service += estimate / weight
    class_state.service += estimate / share
    user_state.updated_at = class_state.updated_at = at
    floor.service = min(row.service for row in accounts.values())
    if not job.attempt_id:
        job.attempt_id = uid()
        db.add(Attempt(id=job.attempt_id, job_id=job.id, provider_id=job.config["provider"]["id"],
                       lease_expires_at=at + timedelta(seconds=cfg.cluster_lease_seconds), output_storage_backend=cfg.result_storage_backend))
    job.status, job.phase = "running", "analyze" if stage.name == "page" else stage.name
    stage.status, stage.generation, stage.attempts = "running", stage.generation + 1, stage.attempts + 1
    lease = ExecutionLease(id=uid(), stage_id=stage.id, job_id=job.id, node_id=node.id, owner_id=job.owner_id,
        executor_id=executor_id or (node.id if node.engine_version != "control" else None),
        generation=stage.generation, resource_pool=pool, mode=job.mode, priority_class=cls,
        weight=weight, estimated_seconds=estimate, expires_at=at + timedelta(seconds=cfg.cluster_lease_seconds))
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
    elapsed = max(0.001, ((at if stage.name == 'page' else min(at, lease.expires_at)) - lease.started_at).total_seconds())
    delta = elapsed - lease.estimated_seconds
    user_state = _state(db, f"user:{lease.resource_pool}:{lease.priority_class}:{lease.owner_id}")
    class_state = _state(db, f"class:{lease.resource_pool}:{lease.priority_class}")
    share = settings().realtime_share if lease.priority_class == "realtime" else 1 - settings().realtime_share
    user_state.service = max(0, user_state.service + delta / lease.weight)
    class_state.service = max(0, class_state.service + delta / share)
    floor = _state(db, f"clock:{lease.resource_pool}:{lease.priority_class}")
    floor.service = min(floor.service, user_state.service)
    stage = db.get(JobStage, lease.stage_id)
    estimate = _state(db, "estimate:" + lease.resource_pool + ":" + stage.name, elapsed)
    estimate.service = estimate.service * .8 + min(elapsed, 120) * .2
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
