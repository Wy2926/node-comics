"""Paddle account binding, checkout intents and durable webhook receipts."""
from datetime import datetime
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now, uid


class BillingAccount(Base):
    __tablename__ = 'billing_accounts'
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    environment: Mapped[str] = mapped_column(String(16))
    customer_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    trial_used_at: Mapped[datetime | None] = mapped_column(DateTime)


class BillingCheckout(Base):
    __tablename__ = 'billing_checkouts'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
    environment: Mapped[str] = mapped_column(String(16))
    price_id: Mapped[str] = mapped_column(String(64))
    trial: Mapped[bool] = mapped_column(Boolean)
    status: Mapped[str] = mapped_column(String(24), default='creating')
    transaction_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    token_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime)
    error_code: Mapped[str | None] = mapped_column(String(80))


class BillingSubscription(Base):
    __tablename__ = 'billing_subscriptions'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
    checkout_id: Mapped[str] = mapped_column(ForeignKey('billing_checkouts.id'), unique=True)
    environment: Mapped[str] = mapped_column(String(16))
    customer_id: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24))
    trial_starts_at: Mapped[datetime | None] = mapped_column(DateTime)
    trial_ends_at: Mapped[datetime | None] = mapped_column(DateTime)
    paid_starts_at: Mapped[datetime | None] = mapped_column(DateTime)
    paid_ends_at: Mapped[datetime | None] = mapped_column(DateTime)
    next_billed_at: Mapped[datetime | None] = mapped_column(DateTime)
    cancel_at: Mapped[datetime | None] = mapped_column(DateTime)
    provider_updated_at: Mapped[datetime] = mapped_column(DateTime)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class BillingEvent(Base):
    __tablename__ = 'billing_events'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    environment: Mapped[str] = mapped_column(String(16))
    event_type: Mapped[str] = mapped_column(String(80))
    resource_id: Mapped[str] = mapped_column(String(64))
    occurred_at: Mapped[datetime] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(24), default='pending')
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)
    error_code: Mapped[str | None] = mapped_column(String(80))
    received_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime)
