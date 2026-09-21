"""Versioned administrator settings shared by every API and worker process."""
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import ConfigDict, Field, model_validator
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, JSON, select, update
from sqlalchemy.orm import Mapped, Session, mapped_column

from .auth import admin
from .admin_audit import record_audit
from .config import settings
from .db import Base, get_db
from .errors import problem
from .models import User, now
from .request_models import RequestBody

router = APIRouter(prefix="/v1/admin/system-settings", tags=["system settings"])


class RequestLimits(RequestBody):
    """One immutable operation snapshot; PUT requires every supported field."""
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, allow_inf_nan=False)

    free_daily_pages: int = Field(ge=0, le=1000000)
    plus_monthly_redraw_pages: int = Field(ge=0, le=1000000)
    free_scheduler_weight: float = Field(ge=0.1, le=100)
    plus_scheduler_weight: float = Field(ge=0.1, le=100)

    free_images_per_minute: int = Field(ge=1, le=10000)
    plus_images_per_minute: int = Field(ge=1, le=10000)
    upload_user_concurrency: int = Field(ge=1, le=32)
    upload_global_concurrency: int = Field(ge=1, le=128)
    upload_idle_timeout_seconds: float = Field(ge=0.1, le=120)
    upload_body_timeout_seconds: float = Field(ge=0.1, le=900)
    upload_ingress_lease_seconds: int = Field(ge=15, le=300)
    feedback_requests_per_minute: int = Field(ge=1, le=1000)
    feedback_request_burst: int = Field(ge=1, le=100)
    feedback_receipts_per_day: int = Field(ge=1, le=10000)

    @model_validator(mode="after")
    def consistent_limits(self):
        if self.upload_user_concurrency > self.upload_global_concurrency:
            problem("SYSTEM_SETTINGS_INVALID", "每用户上传并发数不能大于全局上传并发数", 422)
        if self.upload_idle_timeout_seconds > self.upload_body_timeout_seconds:
            problem("SYSTEM_SETTINGS_INVALID", "上传空闲超时不能大于上传总超时", 422)
        return self


class SystemSettings(Base):
    __tablename__ = "system_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    values: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
    updated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    __table_args__ = (CheckConstraint("id = 1", name="ck_system_settings_singleton"),
                      CheckConstraint("version >= 1", name="ck_system_settings_version"))


class SystemSettingsUpdate(RequestBody):
    expected_version: int = Field(ge=1, strict=True)
    values: RequestLimits


def initialize_system_settings(db):
    """Seed once, including concurrent startups; the caller owns the commit."""
    row = db.scalar(select(SystemSettings).where(SystemSettings.id == 1)
                    .execution_options(populate_existing=True))
    if row is not None:
        return row
    cfg = settings()
    values = RequestLimits.model_validate({name: getattr(cfg, name) for name in RequestLimits.model_fields})
    if db.get_bind().dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    db.execute(insert(SystemSettings).values(id=1, version=1, values=values.model_dump(),
        updated_at=now(), updated_by=None).on_conflict_do_nothing(index_elements=["id"]))
    return db.scalar(select(SystemSettings).where(SystemSettings.id == 1)
                     .execution_options(populate_existing=True))


def get_request_limits(db):
    """Use the supplied transaction/connection; never cache across requests."""
    return RequestLimits.model_validate(initialize_system_settings(db).values)


def settings_json(row):
    return {"version": row.version, "values": RequestLimits.model_validate(row.values).model_dump(),
            "updated_at": row.updated_at.isoformat() + "Z", "updated_by": row.updated_by}


@router.get("")
def get_system_settings(user: User = Depends(admin), db: Session = Depends(get_db)):
    result = settings_json(initialize_system_settings(db))
    db.commit()
    return result


@router.put("")
def put_system_settings(body: SystemSettingsUpdate, user: User = Depends(admin), db: Session = Depends(get_db)):
    from .scheduler import lock_scheduler
    lock_scheduler(db)
    previous = initialize_system_settings(db)
    before = settings_json(previous)
    row = db.scalar(update(SystemSettings).where(SystemSettings.id == 1,
        SystemSettings.version == body.expected_version).values(
            version=SystemSettings.version + 1, values=body.values.model_dump(),
            updated_at=now(), updated_by=user.id).returning(SystemSettings)
        .execution_options(populate_existing=True))
    if row is None:
        current = db.scalar(select(SystemSettings.version).where(SystemSettings.id == 1))
        problem("SYSTEM_SETTINGS_CONFLICT", "系统设置已被其他管理员更新，请刷新后重试", 409,
                current_version=current)
    result = settings_json(row)
    record_audit(db, user.id, 'system_settings.update', 'system_settings', '1', before=before, after=result)
    from .notifications import publish
    publish(db, 'policy')
    db.commit()
    return result
