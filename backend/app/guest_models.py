"""Visitor credentials and durable anonymous admission, separate from membership."""
from datetime import datetime, date
from sqlalchemy import String, DateTime, Date, Integer, ForeignKey, CheckConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now, uid


class GuestSession(Base):
    __tablename__ = 'guest_sessions'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)


class GuestDailyUsage(Base):
    __tablename__ = 'guest_daily_usage'
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    accepted_count: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (CheckConstraint('accepted_count >= 0'),)


class GuestDailyBudget(Base):
    __tablename__ = 'guest_daily_budgets'
    # HMAC network keys or the single global key; never raw IP addresses.
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    accepted_count: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (CheckConstraint('accepted_count >= 0'),)
