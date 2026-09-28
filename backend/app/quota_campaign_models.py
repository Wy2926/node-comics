"""Configurable campaigns with fixed award identity and one receipt per account."""
from datetime import datetime
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now


class QuotaCampaign(Base):
    __tablename__ = 'quota_campaigns'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    mode: Mapped[str] = mapped_column(String(20))
    pages: Mapped[int] = mapped_column(Integer)
    audience: Mapped[str] = mapped_column(String(20))
    starts_at: Mapped[datetime] = mapped_column(DateTime)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime)
    validity_days: Mapped[int | None] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    request_hash: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[str] = mapped_column(ForeignKey('users.id'))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (
        CheckConstraint("mode IN ('classic', 'redraw')"),
        CheckConstraint("audience IN ('all', 'existing', 'new')"),
        CheckConstraint('pages BETWEEN 1 AND 1000000'),
        CheckConstraint('validity_days IS NULL OR validity_days BETWEEN 1 AND 36500'),
        CheckConstraint('ends_at IS NULL OR ends_at > starts_at'),
        CheckConstraint('version >= 1'),
    )


class QuotaCampaignAward(Base):
    __tablename__ = 'quota_campaign_awards'
    campaign_id: Mapped[str] = mapped_column(ForeignKey('quota_campaigns.id'), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    period_id: Mapped[str] = mapped_column(ForeignKey('quota_periods.id'), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
