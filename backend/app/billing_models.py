"""Provider-neutral products, quotes, payments and durable order history."""
from datetime import datetime
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, Index, Integer, JSON, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now, uid


class BillingSettings(Base):
    """Exactly one site-wide provider for new purchases; existing intents stay bound."""
    __tablename__ = 'billing_settings'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    default_provider: Mapped[str | None] = mapped_column(String(16))
    __table_args__ = (CheckConstraint('id = 1'),
        CheckConstraint("default_provider IN ('stripe', 'creem')"))


class BillingPlan(Base):
    __tablename__ = 'billing_plans'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class BillingPlanRevision(Base):
    """Immutable benefits. Changing benefits creates a new revision."""
    __tablename__ = 'billing_plan_revisions'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    plan_id: Mapped[str] = mapped_column(ForeignKey('billing_plans.id'), index=True)
    version: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(100))
    monthly_redraw_pages: Mapped[int] = mapped_column(Integer)
    trial_days: Mapped[int] = mapped_column(Integer)
    trial_redraw_pages: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (UniqueConstraint('plan_id', 'version'), UniqueConstraint('id', 'plan_id'),
        CheckConstraint('version > 0'), CheckConstraint('monthly_redraw_pages >= 0'),
        CheckConstraint('trial_days >= 0 AND trial_days <= 30'), CheckConstraint('trial_redraw_pages >= 0'),
        CheckConstraint('trial_days > 0 OR trial_redraw_pages = 0'))


class BillingPrice(Base):
    """Immutable quote; retiring it only prevents new checkout intents."""
    __tablename__ = 'billing_prices'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    plan_id: Mapped[str] = mapped_column(ForeignKey('billing_plans.id'))
    plan_revision_id: Mapped[str] = mapped_column(String(36))
    environment: Mapped[str] = mapped_column(String(16))
    currency: Mapped[str] = mapped_column(String(3))
    unit_amount: Mapped[int] = mapped_column(Integer)
    interval: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(16), default='draft')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (ForeignKeyConstraint(['plan_revision_id', 'plan_id'],
            ['billing_plan_revisions.id', 'billing_plan_revisions.plan_id']),
        CheckConstraint("environment IN ('test', 'live')"), CheckConstraint("interval IN ('month', 'year')"),
        CheckConstraint("status IN ('draft', 'active', 'archived')"), CheckConstraint('unit_amount > 0'),
        Index('uq_billing_active_offer', 'plan_id', 'environment', 'currency', 'interval', unique=True,
            sqlite_where=text("status = 'active'"), postgresql_where=text("status = 'active'")))


class BillingPriceBinding(Base):
    """A provider's immutable purchasable item for one local quote."""
    __tablename__ = 'billing_price_bindings'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    price_id: Mapped[str] = mapped_column(ForeignKey('billing_prices.id'), index=True)
    provider: Mapped[str] = mapped_column(String(16))
    environment: Mapped[str] = mapped_column(String(16))
    product_id: Mapped[str] = mapped_column(String(255))
    trial_product_id: Mapped[str | None] = mapped_column(String(255))
    provider_price_id: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(16), default='draft')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (
        CheckConstraint("provider IN ('stripe', 'creem')"),
        CheckConstraint("environment IN ('test', 'live')"),
        CheckConstraint("status IN ('draft', 'active', 'archived')"),
        CheckConstraint("provider != 'stripe' OR provider_price_id IS NOT NULL"),
        CheckConstraint("provider != 'stripe' OR trial_product_id IS NULL"),
        CheckConstraint('trial_product_id IS NULL OR trial_product_id != product_id'),
        CheckConstraint("provider != 'creem' OR provider_price_id IS NULL"),
        UniqueConstraint('provider', 'environment', 'provider_price_id'),
        Index('uq_billing_creem_product', 'provider', 'environment', 'product_id', unique=True,
            sqlite_where=text("provider = 'creem'"), postgresql_where=text("provider = 'creem'")),
        Index('uq_billing_active_binding', 'price_id', 'provider', 'environment', unique=True,
            sqlite_where=text("status = 'active'"), postgresql_where=text("status = 'active'")))


class BillingAccount(Base):
    __tablename__ = 'billing_accounts'
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    trial_used_at: Mapped[datetime | None] = mapped_column(DateTime)


class BillingCustomer(Base):
    __tablename__ = 'billing_customers'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
    provider: Mapped[str] = mapped_column(String(16))
    environment: Mapped[str] = mapped_column(String(16))
    customer_id: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (UniqueConstraint('owner_id', 'provider', 'environment'),
        UniqueConstraint('provider', 'environment', 'customer_id'),
        CheckConstraint("provider IN ('stripe', 'creem')"),
        CheckConstraint("environment IN ('test', 'live')"))


class BillingCheckout(Base):
    __tablename__ = 'billing_checkouts'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
    environment: Mapped[str] = mapped_column(String(16))
    provider: Mapped[str] = mapped_column(String(16))
    price_id: Mapped[str] = mapped_column(ForeignKey('billing_prices.id'))
    binding_id: Mapped[str] = mapped_column(ForeignKey('billing_price_bindings.id'))
    customer_id: Mapped[str | None] = mapped_column(String(255))
    return_url: Mapped[str] = mapped_column(String(1024))
    checkout_url: Mapped[str | None] = mapped_column(String(2048))
    trial: Mapped[bool] = mapped_column(Boolean)
    status: Mapped[str] = mapped_column(String(24), default='creating')
    session_id: Mapped[str | None] = mapped_column(String(255))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime)
    error_code: Mapped[str | None] = mapped_column(String(80))
    __table_args__ = (UniqueConstraint('provider', 'environment', 'session_id'),
        CheckConstraint("provider IN ('stripe', 'creem')"),
        CheckConstraint("environment IN ('test', 'live')"))


class BillingSubscription(Base):
    __tablename__ = 'billing_subscriptions'
    id: Mapped[str] = mapped_column(String(320), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
    checkout_id: Mapped[str] = mapped_column(ForeignKey('billing_checkouts.id'), unique=True)
    environment: Mapped[str] = mapped_column(String(16))
    provider: Mapped[str] = mapped_column(String(16))
    customer_id: Mapped[str] = mapped_column(String(255))
    price_id: Mapped[str] = mapped_column(ForeignKey('billing_prices.id'))
    binding_id: Mapped[str] = mapped_column(ForeignKey('billing_price_bindings.id'))
    status: Mapped[str] = mapped_column(String(24))
    trial_starts_at: Mapped[datetime | None] = mapped_column(DateTime)
    trial_ends_at: Mapped[datetime | None] = mapped_column(DateTime)
    paid_starts_at: Mapped[datetime | None] = mapped_column(DateTime)
    paid_ends_at: Mapped[datetime | None] = mapped_column(DateTime)
    next_billed_at: Mapped[datetime | None] = mapped_column(DateTime)
    cancel_at: Mapped[datetime | None] = mapped_column(DateTime)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


class BillingInvoice(Base):
    __tablename__ = 'billing_invoices'
    id: Mapped[str] = mapped_column(String(320), primary_key=True)
    subscription_id: Mapped[str] = mapped_column(ForeignKey('billing_subscriptions.id'), index=True)
    currency: Mapped[str] = mapped_column(String(3))
    total: Mapped[int] = mapped_column(Integer)
    processed_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class BillingTerm(Base):
    """Granted access is independent of payment cadence and quota consumption."""
    __tablename__ = 'billing_terms'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    subscription_id: Mapped[str] = mapped_column(ForeignKey('billing_subscriptions.id'), index=True)
    price_id: Mapped[str] = mapped_column(ForeignKey('billing_prices.id'))
    invoice_id: Mapped[str | None] = mapped_column(ForeignKey('billing_invoices.id'))
    kind: Mapped[str] = mapped_column(String(8))
    starts_at: Mapped[datetime] = mapped_column(DateTime)
    ends_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)
    __table_args__ = (CheckConstraint("kind IN ('trial', 'paid')"), CheckConstraint('ends_at > starts_at'),
        UniqueConstraint('subscription_id', 'kind', 'starts_at'),
        Index('ix_billing_terms_owner_dates', 'owner_id', 'ends_at', 'starts_at'))


class BillingEvent(Base):
    __tablename__ = 'billing_events'
    id: Mapped[str] = mapped_column(String(320), primary_key=True)
    environment: Mapped[str] = mapped_column(String(16))
    provider: Mapped[str] = mapped_column(String(16))
    event_type: Mapped[str] = mapped_column(String(80))
    resource_id: Mapped[str] = mapped_column(String(320))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(24), default='pending')
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)
    error_code: Mapped[str | None] = mapped_column(String(80))
    received_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime)


class BillingOrder(Base):
    """One payable initial purchase or renewal; events never overwrite its history."""
    __tablename__ = 'billing_orders'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
    provider: Mapped[str] = mapped_column(String(16))
    environment: Mapped[str] = mapped_column(String(16))
    checkout_id: Mapped[str | None] = mapped_column(ForeignKey('billing_checkouts.id'), index=True)
    subscription_id: Mapped[str | None] = mapped_column(ForeignKey('billing_subscriptions.id'), index=True)
    price_id: Mapped[str] = mapped_column(ForeignKey('billing_prices.id'))
    binding_id: Mapped[str] = mapped_column(ForeignKey('billing_price_bindings.id'))
    external_id: Mapped[str | None] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(32))
    currency: Mapped[str] = mapped_column(String(3))
    subtotal: Mapped[int | None] = mapped_column(Integer)
    total: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime)
    error_code: Mapped[str | None] = mapped_column(String(80))
    __table_args__ = (UniqueConstraint('provider', 'environment', 'external_id'),
        CheckConstraint("provider IN ('stripe', 'creem')"),
        CheckConstraint("environment IN ('test', 'live')"),
        CheckConstraint("kind IN ('initial', 'renewal')"),
        CheckConstraint('total >= 0'), CheckConstraint('subtotal >= 0'),
        Index('uq_billing_initial_order', 'checkout_id', unique=True,
            sqlite_where=text("kind = 'initial'"), postgresql_where=text("kind = 'initial'")),
        Index('ix_billing_orders_created', 'created_at', 'id'),
        Index('ix_billing_orders_filter', 'provider', 'status', 'created_at'))


class BillingOrderTransition(Base):
    __tablename__ = 'billing_order_transitions'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    order_id: Mapped[str] = mapped_column(ForeignKey('billing_orders.id'))
    source: Mapped[str] = mapped_column(String(40))
    event_id: Mapped[str | None] = mapped_column(String(320))
    from_status: Mapped[str | None] = mapped_column(String(32))
    to_status: Mapped[str] = mapped_column(String(32))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (Index('ix_billing_order_timeline', 'order_id', 'created_at', 'id'),)
