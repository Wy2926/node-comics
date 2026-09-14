"""Authenticated queue preferences; lower limits revoke only unclaimed slots."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from .auth import admin, identity
from .config import settings
from .db import get_db
from .request_models import RequestBody
from .errors import problem
from .models import Job, User
from .queue_models import QueueAdmission, UserQueueSettings
from .scheduler import concurrency_for, default_concurrency, lock_scheduler, trim_admissions

router = APIRouter(tags=["queue"])


class QueueSettingsRequest(RequestBody):
    concurrency: int | None = Field(ge=1, le=10, strict=True)


class QueueSettingsResponse(BaseModel):
    concurrency: int | None
    effective_concurrency: int
    default_concurrency: int
    max_concurrency: int
    queued: int
    dispatched: int
    running: int


def queue_json(db, owner_id):
    counts = dict(db.execute(select(Job.status, func.count()).where(Job.owner_id == owner_id)
                             .group_by(Job.status)).all())
    return {"concurrency": db.scalar(select(UserQueueSettings.concurrency).where(UserQueueSettings.owner_id == owner_id)),
            "effective_concurrency": concurrency_for(db, owner_id), "default_concurrency": default_concurrency(),
            "max_concurrency": settings().user_queue_max_concurrency, "queued": counts.get("queued", 0),
            "dispatched": db.scalar(select(func.count()).select_from(QueueAdmission).join(Job, Job.id == QueueAdmission.job_id)
                                    .where(Job.owner_id == owner_id, Job.status == "queued")),
            "running": counts.get("running", 0)}


def set_queue(db, owner_id, value):
    if value is not None and value > settings().user_queue_max_concurrency:
        problem("QUEUE_CONCURRENCY_LIMIT", "并发数超过服务端允许的上限", 422)
    lock_scheduler(db)
    preference = db.get(UserQueueSettings, owner_id)
    if preference is None:
        preference = UserQueueSettings(owner_id=owner_id)
        db.add(preference)
    preference.concurrency = value
    db.flush()
    trim_admissions(db, owner_id, concurrency_for(db, owner_id))
    db.commit()
    return queue_json(db, owner_id)


@router.get("/v1/me/queue", response_model=QueueSettingsResponse)
def get_my_queue(user: User = Depends(identity), db: Session = Depends(get_db)):
    return queue_json(db, user.id)


@router.put("/v1/me/queue", response_model=QueueSettingsResponse)
def put_my_queue(body: QueueSettingsRequest, user: User = Depends(identity), db: Session = Depends(get_db)):
    return set_queue(db, user.id, body.concurrency)


def require_user(db, owner_id):
    if db.get(User, owner_id) is None:
        problem("NOT_FOUND", "找不到此用户", 404)


@router.get("/v1/admin/users/{user_id}/queue", response_model=QueueSettingsResponse)
def get_user_queue(user_id: str, operator: User = Depends(admin), db: Session = Depends(get_db)):
    require_user(db, user_id)
    return queue_json(db, user_id)


@router.put("/v1/admin/users/{user_id}/queue", response_model=QueueSettingsResponse)
def put_user_queue(user_id: str, body: QueueSettingsRequest, operator: User = Depends(admin), db: Session = Depends(get_db)):
    require_user(db, user_id)
    return set_queue(db, user_id, body.concurrency)
