"""Administrator-owned text suppliers and immutable, server-only credentials."""
from datetime import datetime
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now, uid


class TranslationProvider(Base):
    __tablename__ = 'translation_providers'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(100))
    channel: Mapped[str] = mapped_column(String(40))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    text_weight: Mapped[int] = mapped_column(Integer, default=1, server_default='0')
    text_plan_ids: Mapped[list[str] | None] = mapped_column(JSON(none_as_null=True))
    title_weight: Mapped[int] = mapped_column(Integer, default=1, server_default='0')
    revision_id: Mapped[str | None] = mapped_column(String(36))
    requests_per_minute: Mapped[int] = mapped_column(Integer, default=60)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (
        CheckConstraint('text_weight BETWEEN 0 AND 10000', name='ck_translation_text_weight'),
        CheckConstraint('title_weight BETWEEN 0 AND 10000', name='ck_translation_title_weight'),
        CheckConstraint('requests_per_minute BETWEEN 1 AND 10000'),)


class TranslationProviderRevision(Base):
    __tablename__ = 'translation_provider_revisions'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    provider_id: Mapped[str] = mapped_column(ForeignKey('translation_providers.id'), index=True)
    channel: Mapped[str] = mapped_column(String(40))
    config: Mapped[dict] = mapped_column(JSON)
    # Deliberately separate from JSON snapshots and deferred on ordinary reads.
    api_key: Mapped[str] = mapped_column(Text, deferred=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
