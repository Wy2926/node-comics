"""Reading-window fencing, separate from durable task execution."""
from datetime import timedelta
from fastapi import HTTPException
from sqlalchemy import func, select
from .config import settings
from .errors import problem
from .models import Job, now
from .plan_models import ReadingSession
from .providers import digest
from .queue_models import UserModeQueue
from .scheduler import ACTIVE, queue_for, touch_job


def reading_window(db, owner_id, body):
    if not body.session_id:
        return None
    at = now()
    row = db.get(ReadingSession, (owner_id, body.session_id))
    if row and (row.fenced or row.expires_at <= at):
        problem('READING_SESSION_EXPIRED', '阅读会话已失效，请建立新会话', 409)
    if row is None:
        count = db.scalar(select(func.count()).select_from(ReadingSession).where(
            ReadingSession.owner_id == owner_id, ReadingSession.fenced.is_(False), ReadingSession.expires_at > at))
        if count >= settings().reading_session_limit:
            raise HTTPException(429, detail={'code': 'READING_SESSION_LIMIT', 'message': '活跃阅读会话过多，请关闭其他阅读页面',
                'retry_after_seconds': 30, 'scope': 'reading_session'}, headers={'Retry-After': '30'})
        row = ReadingSession(owner_id=owner_id, session_id=body.session_id, sequence=-1,
            window_hash='', window=[], expires_at=at + timedelta(seconds=settings().priority_ttl_seconds))
        db.add(row)
        db.flush()
    window = [item.model_dump() for item in body.items]
    signature = digest(window)
    if body.sequence < row.sequence:
        problem('STALE_READING_PLAN', '已有更新的阅读窗口', 409, applied_sequence=row.sequence)
    if body.sequence == row.sequence and signature != row.window_hash:
        problem('READING_SEQUENCE_CONFLICT', '同一阅读序号不能绑定不同窗口', 409)
    row.sequence, row.window_hash, row.window = body.sequence, signature, window
    row.expires_at = at + timedelta(seconds=settings().priority_ttl_seconds)
    return row


def claim_priority(db, session, modes, epochs, *, takeover=False):
    at = now()
    result = {}
    for mode in modes:
        queue = queue_for(db, session.owner_id, mode)
        active = bool(queue.session_id and queue.session_expires_at and queue.session_expires_at > at)
        supplied = epochs.get(mode)
        if queue.session_id == session.session_id:
            if supplied is not None and supplied != queue.session_epoch:
                problem('READING_SESSION_EXPIRED', '阅读控制权已更新', 409)
        elif not active or takeover:
            if takeover and supplied != queue.session_epoch:
                problem('READING_EPOCH_CONFLICT', '阅读控制权已更新，请刷新前台状态', 409, epoch=queue.session_epoch)
            if queue.session_id:
                old = db.get(ReadingSession, (session.owner_id, queue.session_id))
                if old:
                    old.fenced, old.window = True, []
                    owned_modes = list(db.scalars(select(UserModeQueue).where(
                        UserModeQueue.owner_id == session.owner_id, UserModeQueue.session_id == old.session_id)))
                    for previous in owned_modes:
                        if previous.mode != mode:
                            previous.session_id = previous.session_expires_at = None
                            previous.session_epoch += 1
                            previous.version += 1
                    for job in db.scalars(select(Job).where(Job.owner_id == session.owner_id,
                            Job.mode.in_([previous.mode for previous in owned_modes]),
                            Job.status.in_(ACTIVE), Job.realtime_until.is_not(None))):
                        job.realtime_until, job.priority_rank = None, 1000000
                        touch_job(db, job)
            queue.session_id, queue.session_epoch = session.session_id, queue.session_epoch + 1
            queue.version += 1
        owned = queue.session_id == session.session_id
        if owned:
            queue.session_expires_at = session.expires_at
        result[mode] = {'owned': owned, 'epoch': queue.session_epoch,
            'expires_at': queue.session_expires_at.isoformat() + 'Z' if queue.session_expires_at else None}
    db.flush()
    return result


def apply_priority(db, session, jobs_by_rank):
    """Only this session's modes are changed; outside-window work remains durable."""
    for queue in db.scalars(select(UserModeQueue).where(UserModeQueue.owner_id == session.owner_id,
            UserModeQueue.session_id == session.session_id)):
        desired = {job_id: rank for rank, (job_id, mode) in enumerate(jobs_by_rank) if mode == queue.mode}
        for job in db.scalars(select(Job).where(Job.owner_id == session.owner_id, Job.mode == queue.mode, Job.status.in_(ACTIVE))):
            rank = desired.get(job.id, 1000000)
            until = session.expires_at if job.id in desired and job.status != 'outcome_unknown' else None
            # Extending a lease does not make the task payload change. The first
            # classification/rank change does, and must advance its feed cursor.
            changed = job.priority_rank != rank or bool(job.realtime_until and job.realtime_until > now()) != bool(until)
            job.priority_rank, job.realtime_until = rank, until
            if changed:
                touch_job(db, job)
        queue.version += 1
    db.flush()
