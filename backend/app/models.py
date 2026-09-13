from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint
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
    balance: Mapped[int] = mapped_column(Integer, default=100)
    reserved: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (CheckConstraint("balance >= 0"), CheckConstraint("reserved >= 0"), CheckConstraint("balance >= reserved"))


class Asset(Base):
    __tablename__ = "assets"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="original")
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("assets.id"), index=True)
    storage_key: Mapped[str] = mapped_column(String(200))
    mime: Mapped[str] = mapped_column(String(30))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    byte_size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime)
    purged_at: Mapped[datetime | None] = mapped_column(DateTime)


class Batch(Base):
    __tablename__ = "batches"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    quote_id: Mapped[str] = mapped_column(String(36), unique=True)
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    total_cost: Mapped[int] = mapped_column(Integer)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (UniqueConstraint("owner_id", "idempotency_key"),)


class Quote(Base):
    __tablename__ = "quotes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    asset_ids: Mapped[list] = mapped_column(JSON)
    mode: Mapped[str] = mapped_column(String(20))
    language: Mapped[str] = mapped_column(String(20))
    config_version: Mapped[str] = mapped_column(String(64))
    total_cost: Mapped[int] = mapped_column(Integer)
    unit_cost: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    input_asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"), index=True)
    output_asset_id: Mapped[str | None] = mapped_column(ForeignKey("assets.id"))
    batch_id: Mapped[str | None] = mapped_column(ForeignKey("batches.id"), index=True)
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
    cost: Mapped[int] = mapped_column(Integer)
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
    __table_args__ = (UniqueConstraint("owner_id", "operation", "idempotency_key"),)


class Attempt(Base):
    __tablename__ = "attempts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
    provider_id: Mapped[str] = mapped_column(String(80))
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
    transaction_key: Mapped[str] = mapped_column(String(200), unique=True)
    kind: Mapped[str] = mapped_column(String(20))
    amount: Mapped[int] = mapped_column(Integer)
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Outbox(Base):
    __tablename__ = "outbox"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), unique=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime)
    publish_attempts: Mapped[int] = mapped_column(Integer, default=0)


class Provider(Base):
    __tablename__ = "providers"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    config: Mapped[dict] = mapped_column(JSON)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    validated_at: Mapped[datetime | None] = mapped_column(DateTime)
    validation_job_id: Mapped[str | None] = mapped_column(String(36))
