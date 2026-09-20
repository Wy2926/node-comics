"""Page allowances are immutable periods, independent of supplier cost accounting."""
from datetime import datetime
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now, uid


class QuotaPeriod(Base):
    __tablename__ = "quota_periods"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    billing_term_id: Mapped[str | None] = mapped_column(ForeignKey('billing_terms.id'), index=True)
    kind: Mapped[str] = mapped_column(String(30))
    mode: Mapped[str] = mapped_column(String(20))
    source: Mapped[str] = mapped_column(String(20))
    source_key: Mapped[str] = mapped_column(String(200))
    note: Mapped[str] = mapped_column(String(200), default="")
    grants_access: Mapped[bool] = mapped_column(Boolean, default=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime)
    ends_at: Mapped[datetime] = mapped_column(DateTime)
    granted: Mapped[int] = mapped_column(Integer)
    used: Mapped[int] = mapped_column(Integer, default=0)
    reserved: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (UniqueConstraint("owner_id", "source_key"),
                     Index("ix_quota_periods_owner_mode_end", "owner_id", "mode", "ends_at"),
                     CheckConstraint("mode IN ('classic', 'redraw')"),
                     CheckConstraint("source IN ('daily', 'membership', 'grant', 'subscription')"),
                     CheckConstraint("(source = 'subscription' AND billing_term_id IS NOT NULL) OR (source != 'subscription' AND billing_term_id IS NULL)"),
                     CheckConstraint("used >= 0"), CheckConstraint("reserved >= 0"),
                     CheckConstraint("granted >= used + reserved"), CheckConstraint("ends_at > starts_at"))


class MembershipOperation(Base):
    __tablename__ = "membership_operations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    transaction_key: Mapped[str] = mapped_column(String(200), unique=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    operator_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    request_hash: Mapped[str] = mapped_column(String(64))
    details: Mapped[dict] = mapped_column(JSON)
    result: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
