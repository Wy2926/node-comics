"""Immutable translation requests and durable idempotency receipts."""
from datetime import datetime
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, JSON, String, false
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now


class TranslationRequest(Base):
    __tablename__ = 'translation_requests'
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    job_id: Mapped[str | None] = mapped_column(ForeignKey('jobs.id'), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)
    legacy_execution_resolved: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    descriptor: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (Index('ix_translation_requests_owner_created', 'owner_id', 'created_at'),
        CheckConstraint('job_id IS NOT NULL OR revoked_at IS NOT NULL', name='ck_translation_request_job_or_tombstone'),)
