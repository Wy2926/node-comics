"""Account task changes: one resumable long-poll, no client queue API."""
import time
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from .auth import identity
from .db import get_db, session_factory
from .jobs import job_json
from .models import Job, User
from .scheduler import lock_scheduler
from .plan_api import plan_snapshot
from .schemas import TranslationChangesResponse

router = APIRouter(tags=['translation changes'])


@router.get('/v1/me/translation-changes', response_model=TranslationChangesResponse)
async def changes(cursor: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=100),
                  wait_seconds: float = Query(0, ge=0, le=20, allow_inf_nan=False),
                  policy_revision: int | None = Query(None, ge=0),
                  user: User = Depends(identity), db: Session = Depends(get_db)):
    owner_id = user.id
    await run_in_threadpool(db.close)
    from .notifications import hub, changed
    end = time.monotonic() + wait_seconds
    with hub().subscribe('user:' + owner_id) as wake:
        while True:
            wake.clear()
            result = await run_in_threadpool(change_snapshot, owner_id, cursor, limit)
            if (result['items'] or time.monotonic() >= end or
                    (policy_revision is not None and int(result['policy_revision']) != policy_revision)):
                return result
            await changed(wake, end - time.monotonic())


def change_snapshot(owner_id, cursor, limit):
    with session_factory()() as db:
        return _changes(db, owner_id, cursor, limit)


def _changes(db, owner_id, cursor, limit):
    lock_scheduler(db)
    rows = list(db.scalars(select(Job).where(Job.owner_id == owner_id, Job.change_sequence > cursor)
        .order_by(Job.change_sequence, Job.id).limit(limit + 1)))
    selected = rows[:limit]
    result = {'items': [job_json(db, job) for job in selected], 'deleted_job_ids': [],
        'cursor': str(selected[-1].change_sequence if selected else cursor), 'has_more': len(rows) > limit,
        **plan_snapshot(db, db.get(User, owner_id))}
    db.commit()
    return result
