"""Database-authoritative, non-preemptive per-user round-robin admission.

The singleton row serializes admissions, worker claims and limit changes across
processes. It is never held during provider calls. PostgreSQL row locks are the
production mechanism; a no-op UPDATE also acquires SQLite's writer lock before
reading counts in isolated tests. Completion only reduces occupancy and does not
need this lock. No account row is used as a scheduler mutex.
"""
from sqlalchemy import case, delete, func, or_, select, update
from .config import settings
from .db import session_factory
from .models import Job, Outbox, User
from .queue_models import QueueAdmission, SchedulerState, UserQueueSettings


def lock_scheduler(db):
    db.execute(update(SchedulerState).where(SchedulerState.id == 1)
               .values(sequence=SchedulerState.sequence).execution_options(synchronize_session=False))
    state = db.scalar(select(SchedulerState).where(SchedulerState.id == 1).execution_options(populate_existing=True))
    if state is None:
        raise RuntimeError("Scheduler migration is required")
    return state


def default_concurrency():
    return min(settings().user_queue_concurrency, settings().user_queue_max_concurrency)


def concurrency_for(db, owner_id):
    configured = db.scalar(select(UserQueueSettings.concurrency).where(UserQueueSettings.owner_id == owner_id))
    return min(configured or default_concurrency(), settings().user_queue_max_concurrency)


def release_admission(db, job_id):
    """Caller holds the job row. A recovered/revoked job gets a NEW token later."""
    db.execute(delete(QueueAdmission).where(QueueAdmission.job_id == job_id))
    db.execute(update(Outbox).where(Outbox.job_id == job_id).values(published_at=None))


def trim_admissions(db, owner_id, limit):
    """Under scheduler lock: keep running work, revoke newest pending slots."""
    running = db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == owner_id, Job.status == "running"))
    pending = db.scalars(select(Job).join(QueueAdmission, QueueAdmission.job_id == Job.id)
                        .where(Job.owner_id == owner_id, Job.status == "queued")
                        .order_by(QueueAdmission.sequence).with_for_update(of=Job, key_share=True)).all()
    for job in pending[max(0, limit - running):]:
        release_admission(db, job.id)


def queued_condition():
    return (Job.status == "queued", Job.cancel_requested.is_(False), Job.discard_output.is_(False))


def admit_jobs(limit=None):
    """Commit bounded durable slots before ANY broker publish; return job IDs.

    Each turn admits one oldest job for the next eligible owner, regardless of
    batch or mode. The cursor survives ticks, crashes, and competing dispatchers.
    Occupancy includes running jobs plus admitted queued jobs across both modes.
    """
    maximum = min(limit if limit is not None else settings().dispatch_max_jobs, settings().dispatch_max_jobs)
    with session_factory()() as db:
        state = lock_scheduler(db)
        db.execute(delete(QueueAdmission).where(QueueAdmission.job_id.in_(
            select(Job.id).where(Job.status.not_in(["queued", "running"])))))
        owners = db.scalars(select(Job.owner_id).join(QueueAdmission, QueueAdmission.job_id == Job.id)
                           .where(Job.status == "queued").distinct()).all()
        for owner_id in owners:
            trim_admissions(db, owner_id, concurrency_for(db, owner_id))

        occupancy = (select(Job.owner_id, func.count().label("count"))
                     .outerjoin(QueueAdmission, QueueAdmission.job_id == Job.id)
                     .where(or_(Job.status == "running", (Job.status == "queued") & QueueAdmission.job_id.is_not(None)))
                     .group_by(Job.owner_id).subquery())
        configured = func.coalesce(UserQueueSettings.concurrency, default_concurrency())
        effective_limit = case((configured > settings().user_queue_max_concurrency, settings().user_queue_max_concurrency), else_=configured)
        pending = (select(Job.id).join(Outbox, Outbox.job_id == Job.id)
                   .outerjoin(QueueAdmission, QueueAdmission.job_id == Job.id)
                   .where(Job.owner_id == User.id, *queued_condition(), QueueAdmission.job_id.is_(None)).exists())
        admitted, blocked = [], []
        while len(admitted) < maximum:
            owner_id = db.scalar(select(User.id)
                                 .outerjoin(UserQueueSettings, UserQueueSettings.owner_id == User.id)
                                 .outerjoin(occupancy, occupancy.c.owner_id == User.id)
                                 .where(pending, func.coalesce(occupancy.c.count, 0) < effective_limit, User.id.not_in(blocked))
                                 .order_by(case((User.id > state.last_owner_id, 0), else_=1), User.id).limit(1))
            if owner_id is None:
                break
            job = db.scalar(select(Job).join(Outbox, Outbox.job_id == Job.id)
                            .outerjoin(QueueAdmission, QueueAdmission.job_id == Job.id)
                            .where(Job.owner_id == owner_id, *queued_condition(), QueueAdmission.job_id.is_(None))
                            .order_by(Job.created_at, Job.ordinal, Job.id).limit(1)
                            .with_for_update(skip_locked=True, of=Job, key_share=True))
            if job is None:
                blocked.append(owner_id)
                continue
            state.last_owner_id, state.sequence = owner_id, state.sequence + 1
            db.add(QueueAdmission(job_id=job.id, sequence=state.sequence))
            db.flush()
            admitted.append(job.id)
        db.commit()
        return admitted
