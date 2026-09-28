"""Immutable translation requests and durable idempotency receipts."""
from datetime import datetime
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, JSON, String
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now


class TranslationRequest(Base):
    __tablename__ = 'translation_requests'
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    job_id: Mapped[str | None] = mapped_column(ForeignKey('jobs.id'), index=True)
    access_id: Mapped[str | None] = mapped_column(ForeignKey('result_accesses.id'), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)
    descriptor: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (Index('ix_translation_requests_owner_created', 'owner_id', 'created_at'),
        CheckConstraint('(job_id IS NOT NULL AND access_id IS NULL) OR (job_id IS NULL AND access_id IS NOT NULL)'),)

    @property
    def entry_id(self):
        return self.job_id or self.access_id
