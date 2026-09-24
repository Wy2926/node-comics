"""Database authority for mode queues, weighted scheduling and fenced stage leases."""
from datetime import datetime
from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now, uid


class UserModeQueue(Base):
    __tablename__ = "user_mode_queues"
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    mode: Mapped[str] = mapped_column(String(20), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, default=0)


class ComputeNode(Base):
    __tablename__ = "compute_nodes"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    capabilities: Mapped[list] = mapped_column(JSON)
    capacity: Mapped[int] = mapped_column(Integer)
    resource_id: Mapped[str] = mapped_column(String(120), unique=True)
    engine_version: Mapped[str] = mapped_column(String(120))
    device: Mapped[str] = mapped_column(String(80))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime().evaluates_none(), default=now)
    credential_hash: Mapped[str | None] = mapped_column(String(64))
    config_version: Mapped[int] = mapped_column(Integer, default=1)
    applied_config_version: Mapped[int] = mapped_column(Integer, default=0)
    desired_config: Mapped[dict] = mapped_column(JSON, default=dict)
    supported_languages: Mapped[list] = mapped_column(JSON, default=list)
    config_error: Mapped[str | None] = mapped_column(String(80))
    runtime_report: Mapped[dict] = mapped_column(JSON, default=dict)


class JobStage(Base):
    __tablename__ = "job_stages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
    name: Mapped[str] = mapped_column(String(24))
    status: Mapped[str] = mapped_column(String(20), default="waiting", index=True)
    generation: Mapped[int] = mapped_column(Integer, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    available_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    __table_args__ = (UniqueConstraint("job_id", "name"), Index("ix_stage_ready", "status", "name", "available_at"))


class ExecutionLease(Base):
    __tablename__ = "execution_leases"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    token: Mapped[str] = mapped_column(String(64), default=uid)
    stage_id: Mapped[str] = mapped_column(ForeignKey("job_stages.id"), index=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
    node_id: Mapped[str] = mapped_column(ForeignKey("compute_nodes.id"), index=True)
    executor_id: Mapped[str | None] = mapped_column(String(160))
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    generation: Mapped[int] = mapped_column(Integer)
    resource_pool: Mapped[str] = mapped_column(String(120))
    mode: Mapped[str] = mapped_column(String(20))
    priority_class: Mapped[str] = mapped_column(String(20))
    weight: Mapped[float] = mapped_column(Float)
    estimated_seconds: Mapped[float] = mapped_column(Float)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    outcome: Mapped[str | None] = mapped_column(String(24))
    result_hash: Mapped[str | None] = mapped_column(String(64))
    output_key: Mapped[str | None] = mapped_column(String(200))
    limits: Mapped[dict] = mapped_column(JSON, default=dict)


class ComputeClaim(Base):
    """Durable whole-page claim receipt, including empty and reclaimed claims."""
    __tablename__ = "compute_claims"
    node_id: Mapped[str] = mapped_column(ForeignKey("compute_nodes.id"), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    lease_ids: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class FairnessState(Base):
    __tablename__ = "fairness_states"
    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    service: Mapped[float] = mapped_column(Float, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class SchedulerMutex(Base):
    __tablename__ = "scheduler_mutex"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[int] = mapped_column(BigInteger, default=0)
