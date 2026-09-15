"""Read-only account queue limits, determined by current membership."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from .auth import admin, identity
from .config import settings
from .db import get_db
from .errors import problem
from .models import Job, User
from .queue_models import QueueAdmission
from .scheduler import concurrency_for

router = APIRouter(tags=["queue"])


class QueueResponse(BaseModel):
    concurrency: int
    max_active_jobs: int
    queued: int
    dispatched: int
    running: int
    available_slots: int


def queue_json(db, owner_id):
    counts = dict(db.execute(select(Job.status, func.count()).where(Job.owner_id == owner_id)
                             .group_by(Job.status)).all())
    active = sum(counts.get(status, 0) for status in ("queued", "running", "outcome_unknown"))
    return {"concurrency": concurrency_for(db, owner_id), "max_active_jobs": settings().max_active_jobs,
            "queued": counts.get("queued", 0), "running": counts.get("running", 0),
            "available_slots": max(0, settings().max_active_jobs - active),
            "dispatched": db.scalar(select(func.count()).select_from(QueueAdmission).join(Job, Job.id == QueueAdmission.job_id)
                                    .where(Job.owner_id == owner_id, Job.status == "queued"))}


@router.get("/v1/me/queue", response_model=QueueResponse)
def get_my_queue(user: User = Depends(identity), db: Session = Depends(get_db)):
    return queue_json(db, user.id)


@router.get("/v1/admin/users/{user_id}/queue", response_model=QueueResponse)
def get_user_queue(user_id: str, operator: User = Depends(admin), db: Session = Depends(get_db)):
    if db.get(User, user_id) is None:
        problem("NOT_FOUND", "找不到此用户", 404)
    return queue_json(db, user_id)
