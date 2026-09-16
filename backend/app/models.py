from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def uid():
    return str(uuid4())


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    subject: Mapped[str] = mapped_column(String(255), unique=True)
    name: Mapped[str] = mapped_column(String(80))
    role: Mapped[str] = mapped_column(String(20), default="user")
    membership_id: Mapped[str | None] = mapped_column(String(36))
    plus_started_at: Mapped[datetime | None] = mapped_column(DateTime)
    plus_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    plus_timezone: Mapped[str | None] = mapped_column(String(80))
    plus_monthly_pages: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (CheckConstraint("plus_monthly_pages >= 0"),)


class Asset(Base):
    __tablename__ = "assets"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="original")
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("assets.id"), index=True)
    storage_key: Mapped[str] = mapped_column(String(200))
    storage_backend: Mapped[str] = mapped_column(String(20), default="local", server_default="local")
    mime: Mapped[str] = mapped_column(String(30))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    byte_size: Mapped[int] = mapped_column(Integer)
    active_references: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    last_accessed_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime)
    purged_at: Mapped[datetime | None] = mapped_column(DateTime)
    __table_args__ = (Index("ix_assets_content_lookup", "kind", "sha256"),
                     Index("ix_assets_storage_key", "storage_backend", "storage_key"))


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    input_asset_id: Mapped[str | None] = mapped_column(ForeignKey("assets.id"), index=True)
    input_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    source_sha256: Mapped[str] = mapped_column(String(64), default="", index=True)
    file_hash: Mapped[str | None] = mapped_column(String(64))
    page_index: Mapped[int | None] = mapped_column(Integer)
    priority_rank: Mapped[int] = mapped_column(Integer, default=1000000)
    realtime_until: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    changed_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now, index=True)
    change_sequence: Mapped[int] = mapped_column(BigInteger, default=0, index=True)
    output_asset_id: Mapped[str | None] = mapped_column(ForeignKey("assets.id"))
    ordinal: Mapped[int] = mapped_column(Integer, default=0)
    mode: Mapped[str] = mapped_column(String(20))
    target_language: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    phase: Mapped[str] = mapped_column(String(40), default="queued")
    idempotency_key: Mapped[str] = mapped_column(String(128))
    operation: Mapped[str] = mapped_column(String(100))
    request_hash: Mapped[str] = mapped_column(String(64))
    cache_key: Mapped[str] = mapped_column(String(64), index=True)
    cache_hit: Mapped[bool] = mapped_column(Boolean, default=False)
    config: Mapped[dict] = mapped_column(JSON)
    quota_pages: Mapped[int] = mapped_column(Integer)
    quota_kind: Mapped[str] = mapped_column(String(30))
    quota_period_id: Mapped[str | None] = mapped_column(ForeignKey("quota_periods.id"), index=True)
    entitlement: Mapped[dict] = mapped_column(JSON, default=dict)
    settlement: Mapped[str] = mapped_column(String(20), default="reserved")
    version: Mapped[int] = mapped_column(Integer, default=1)
    attempt_id: Mapped[str | None] = mapped_column(String(36))
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    discard_output: Mapped[bool] = mapped_column(Boolean, default=False)
    error_code: Mapped[str | None] = mapped_column(String(60))
    error_message: Mapped[str | None] = mapped_column(String(300))
    quality_flags: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    unknown_since: Mapped[datetime | None] = mapped_column(DateTime)
    __table_args__ = (UniqueConstraint("owner_id", "operation", "idempotency_key"),
                     Index("ix_jobs_created_at", "created_at"), Index("ix_jobs_completed_at", "completed_at"),
                     Index("ix_jobs_content_result", "cache_key", "status", "completed_at"))


class Attempt(Base):
    __tablename__ = "attempts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
    provider_id: Mapped[str] = mapped_column(String(80))
    output_storage_backend: Mapped[str] = mapped_column(String(20), default="local", server_default="local")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    heartbeat_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    lease_expires_at: Mapped[datetime] = mapped_column(DateTime)
    call_started_at: Mapped[datetime | None] = mapped_column(DateTime)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    request_id: Mapped[str | None] = mapped_column(String(200))
    usage: Mapped[dict | None] = mapped_column(JSON)
    cost_state: Mapped[str] = mapped_column(String(20), default="unknown")
    error_code: Mapped[str | None] = mapped_column(String(60))
    recovered: Mapped[bool] = mapped_column(Boolean, default=False)


class Ledger(Base):
    __tablename__ = "usage_ledger"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id"))
    period_id: Mapped[str | None] = mapped_column(ForeignKey("quota_periods.id"), index=True)
    quota_kind: Mapped[str | None] = mapped_column(String(30))
    transaction_key: Mapped[str] = mapped_column(String(200), unique=True)
    kind: Mapped[str] = mapped_column(String(20))
    amount: Mapped[int] = mapped_column(Integer)
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (Index("ix_ledger_owner_created", "owner_id", "created_at"),)


class Provider(Base):
    __tablename__ = "providers"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    config: Mapped[dict] = mapped_column(JSON)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    validated_at: Mapped[datetime | None] = mapped_column(DateTime)
    validation_job_id: Mapped[str | None] = mapped_column(String(36))


class ClassicState(Base):
    __tablename__ = "classic_states"
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), primary_key=True)
    analysis: Mapped[dict | None] = mapped_column(JSON)
    translations: Mapped[dict] = mapped_column(JSON, default=dict)
    timings: Mapped[dict] = mapped_column(JSON, default=dict)
    artifacts: Mapped[dict] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class TextCall(Base):
    __tablename__ = "text_calls"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
    attempt_id: Mapped[str] = mapped_column(ForeignKey("attempts.id"))
    execution_lease_id: Mapped[str | None] = mapped_column(String(36), index=True)
    group_index: Mapped[int] = mapped_column(Integer)
    sequence: Mapped[int] = mapped_column(Integer)
    provider_id: Mapped[str] = mapped_column(String(80))
    model: Mapped[str] = mapped_column(String(120))
    request_id: Mapped[str | None] = mapped_column(String(200))
    usage: Mapped[dict | None] = mapped_column(JSON)
    reserved_micros: Mapped[int] = mapped_column(Integer)
    accounted_micros: Mapped[int] = mapped_column(Integer)
    cost_state: Mapped[str] = mapped_column(String(24), default="unknown")
    error_code: Mapped[str | None] = mapped_column(String(60))
    started_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    __table_args__ = (UniqueConstraint("job_id", "group_index", "sequence"), CheckConstraint("accounted_micros >= 0"),
                     Index("ix_text_calls_started_at", "started_at"))
