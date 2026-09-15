"""Work-conserving weighted stage scheduling. No broker, prefetch or local counters."""
from datetime import timedelta
import hmac
from sqlalchemy import func, select, text, update
from .assets import available
from .config import settings
from .entitlements import is_plus
from .errors import ProcessingError
from .models import Asset, Attempt, ClassicState, Job, Provider, TextCall, User, now, uid
from .queue_models import ComputeNode, ExecutionLease, FairnessState, JobStage, SchedulerMutex, UserModeQueue

ACTIVE = {"awaiting_upload", "validating_upload", "queued", "running", "outcome_unknown"}
IMAGE_STAGES = {"analyze", "inpaint", "render"}


def lock_scheduler(db):
    # All scheduling/admission/priority transactions use this lock before User/Job.
    # Model work and remote I/O never execute while holding it.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(761349211)"))
    else:
        db.execute(update(SchedulerMutex).where(SchedulerMutex.id == 1).values(revision=SchedulerMutex.revision + 1))


def limits_for(user):
    cfg, plus = settings(), is_plus(user)
    return {"capacity": cfg.plus_queue_capacity if plus else cfg.free_queue_capacity,
            "realtime_limit": cfg.plus_realtime_slots if plus else cfg.free_realtime_slots,
            "weight": cfg.plus_scheduler_weight if plus else cfg.free_scheduler_weight}


def queue_for(db, owner_id, mode):
    row = db.get(UserModeQueue, (owner_id, mode))
    if row is None:
        row = UserModeQueue(owner_id=owner_id, mode=mode)
        db.add(row)
        db.flush()
    return row


def active_count(db, owner_id, mode):
    return db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == owner_id, Job.mode == mode, Job.status.in_(ACTIVE)))


def touch_job(db, job):
    lock_scheduler(db)
    job.changed_at = now()
    job.change_sequence = db.execute(update(SchedulerMutex).where(SchedulerMutex.id == 1)
        .values(revision=SchedulerMutex.revision + 1).returning(SchedulerMutex.revision)).scalar_one()


def ensure_stages(db, job):
    if not job.input_asset_id or job.status not in {"queued", "running"}:
        return
    names = ["analyze", "text", "inpaint", "render"] if job.mode == "classic" else ["redraw"]
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
    return max(0.05, min(120, record.service if record else {"validate_upload": 1, "analyze": 10, "inpaint": 15, "render": 5, "text": 10, "redraw": 60}[stage.name]))


def _eligibility_snapshot(db, rows):
    """Read each dependency once per election, not once per queued page."""
    owners = {job.owner_id for _, job in rows}
    sources = {job.input_asset_id for _, job in rows if job.input_asset_id}
    pairs = {(job.owner_id, job.mode) for _, job in rows}
    queues = {(row.owner_id, row.mode): row for row in db.scalars(
        select(UserModeQueue).where(UserModeQueue.owner_id.in_(owners)))}
    for owner_id, mode in pairs - queues.keys():
        queues[(owner_id, mode)] = UserModeQueue(owner_id=owner_id, mode=mode, paused=False)
        db.add(queues[(owner_id, mode)])
    users = {row.id: row for row in db.scalars(select(User).where(User.id.in_(owners)))}
    assets = {row.id: available(row) for row in db.scalars(select(Asset).where(Asset.id.in_(sources)))}
    names = {stage.name for stage, _ in rows}
    pending = 0
    if "analyze" in names:
        from sqlalchemy.orm import aliased
        analyzed = aliased(JobStage)
        pending = db.scalar(select(func.count()).select_from(JobStage).join(analyzed, analyzed.job_id == JobStage.job_id)
            .where(JobStage.name == "render", JobStage.status.in_(["waiting", "ready", "running"]),
                   analyzed.name == "analyze", analyzed.status == "succeeded"))
    recent = 0
    if "text" in names:
        recent = db.scalar(select(func.count()).select_from(TextCall).where(TextCall.started_at > now() - timedelta(minutes=1)))
    providers, running, unknown = {}, {}, {}
    if "redraw" in names:
        provider_ids = {job.config["provider"]["id"] for stage, job in rows if stage.name == "redraw"}
        providers = {row.id: row for row in db.scalars(select(Provider).where(Provider.id.in_(provider_ids)))}
        provider_key = Job.config["provider"]["id"].as_string()
        running = dict(db.execute(select(provider_key, func.count()).select_from(ExecutionLease)
            .join(Job, Job.id == ExecutionLease.job_id).where(ExecutionLease.resource_pool == "redraw",
                ExecutionLease.completed_at.is_(None), provider_key.in_(provider_ids)).group_by(provider_key)).all())
        unknown = dict(db.execute(select(provider_key, func.count()).select_from(Job).where(
            Job.mode == "redraw", Job.status == "outcome_unknown", provider_key.in_(provider_ids)).group_by(provider_key)).all())
    return {"users": users, "assets": assets, "queues": queues, "pending": pending, "recent": recent,
            "providers": providers, "running": running, "unknown": unknown}


def _runnable(snapshot, node, stage, job, at):
    if job.cancel_requested or job.discard_output:
        return False
    if stage.name != "validate_upload" and not snapshot["assets"].get(job.input_asset_id, False):
        return False
    queue = snapshot["queues"][(job.owner_id, job.mode)]
    if queue.paused:
        return False
    if stage.name in IMAGE_STAGES:
        if node.engine_version != job.config.get("engine", {}).get("version", settings().classic_engine_version):
            return False
        if stage.name == "analyze":
            if snapshot["pending"] >= settings().cluster_max_image_stages and priority_of(job, at) != "realtime":
                return False
    if stage.name == "redraw":
        provider = snapshot["providers"].get(job.config["provider"]["id"])
        if not provider or not provider.enabled:
            return False
        # Unknown upstream requests conservatively occupy a provider slot until reconciliation deadline.
        if snapshot["running"].get(provider.id, 0) + snapshot["unknown"].get(provider.id, 0) >= provider.config["concurrency"]:
            return False
    if stage.name == "text":
        if snapshot["recent"] >= settings().cluster_text_requests_per_minute:
            return False
    return True


def claim_stage(db, node_id, allowed_stages=None):
    lock_scheduler(db)
    node = db.get(ComputeNode, node_id)
    at = now()
    if not node or not node.enabled:
        return None
    node.heartbeat_at = at
    busy = db.scalar(select(func.count()).select_from(ExecutionLease).where(ExecutionLease.node_id == node.id, ExecutionLease.completed_at.is_(None)))
    if busy >= node.capacity:
        return None
    stages = set(node.capabilities) & set(allowed_stages or node.capabilities)
    rows = db.execute(select(JobStage, Job).join(Job, Job.id == JobStage.job_id).where(
        JobStage.status == "ready", JobStage.name.in_(stages), JobStage.available_at <= at,
        Job.status.in_(["queued", "running", "validating_upload"])).order_by(Job.created_at, Job.id, JobStage.name)).all()
    if not rows:
        return None
    snapshot = _eligibility_snapshot(db, rows)
    candidates = [(stage, job) for stage, job in rows if _runnable(snapshot, node, stage, job, at)]
    if not candidates:
        return None
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
            0 if pair[0].name == "render" else 1, pair[1].created_at, pair[1].ordinal, pair[0].id))
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
    job.status, job.phase = "running", stage.name
    stage.status, stage.generation, stage.attempts = "running", stage.generation + 1, stage.attempts + 1
    lease = ExecutionLease(id=uid(), stage_id=stage.id, job_id=job.id, node_id=node.id, owner_id=job.owner_id,
        generation=stage.generation, resource_pool=pool, mode=job.mode, priority_class=cls,
        weight=weight, estimated_seconds=estimate, expires_at=at + timedelta(seconds=cfg.cluster_lease_seconds))
    db.add(lease)
    touch_job(db, job)
    db.flush()
    return lease


def release_lease(db, lease, outcome):
    if lease.completed_at:
        return
    at = now()
    elapsed = max(0.001, (min(at, lease.expires_at) - lease.started_at).total_seconds())
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


def heartbeat_lease(db, lease_id, token):
    lock_scheduler(db)
    lease, stage, job = current_lease(db, lease_id, token)
    lease.expires_at = now() + timedelta(seconds=settings().cluster_lease_seconds)
    attempt = db.get(Attempt, job.attempt_id)
    attempt.heartbeat_at, attempt.lease_expires_at = now(), lease.expires_at
    db.get(ComputeNode, lease.node_id).heartbeat_at = now()
    return lease
