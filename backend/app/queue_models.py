"""Durable scheduler metadata, independent of translation and account models."""
from datetime import datetime
from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import Job, now, uid

Index("ix_jobs_owner_status_created", Job.owner_id, Job.status, Job.created_at, Job.ordinal, Job.id)


class SchedulerState(Base):
    __tablename__ = "scheduler_state"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_owner_id: Mapped[str] = mapped_column(String(36), default="")
    sequence: Mapped[int] = mapped_column(BigInteger, default=0)
    __table_args__ = (CheckConstraint("id = 1"),)


class QueueAdmission(Base):
    __tablename__ = "queue_admissions"
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), primary_key=True)
    token: Mapped[str] = mapped_column(String(36), default=uid, unique=True)
    sequence: Mapped[int] = mapped_column(BigInteger, unique=True)
    admitted_at: Mapped[datetime] = mapped_column(DateTime, default=now)
