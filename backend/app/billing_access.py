"""Read paid/trial access from granted terms, independently of quota balances."""
from sqlalchemy import and_, case, func, or_, select
from .billing_models import BillingOrder, BillingPlanRevision, BillingPrice, BillingTerm
from .models import now


def active_terms(db, owner_id, at=None):
    at = at or now()
    return list(db.scalars(select(BillingTerm).where(BillingTerm.owner_id == owner_id,
        BillingTerm.revoked_at.is_(None), BillingTerm.starts_at <= at, BillingTerm.ends_at > at).order_by(BillingTerm.starts_at)))


def active_benefits(db, owner_id, at=None):
    """Resolve immutable benefits through each granted term's original quote."""
    at = at or now()
    return list(db.execute(select(BillingPlanRevision, BillingTerm.kind).join(BillingPrice,
        BillingPrice.plan_revision_id == BillingPlanRevision.id).join(BillingTerm,
        BillingTerm.price_id == BillingPrice.id).where(BillingTerm.owner_id == owner_id,
        BillingTerm.revoked_at.is_(None), BillingTerm.starts_at <= at, BillingTerm.ends_at > at)))


def first_purchase(db, owner_id, at):
    """One available page bucket and its original immutable service quote.

    Depleted permanent purchases are deliberately outside the partial-index
    selector. No purchase history or account-wide balance is loaded at admission.
    """
    from .entitlement_models import QuotaPeriod
    return db.execute(select(QuotaPeriod, BillingPlanRevision).join(BillingOrder,
        BillingOrder.id == QuotaPeriod.billing_order_id).join(BillingPrice,
        BillingPrice.id == BillingOrder.price_id).join(BillingPlanRevision,
        BillingPlanRevision.id == BillingPrice.plan_revision_id).where(
            QuotaPeriod.owner_id == owner_id, BillingOrder.owner_id == owner_id,
            QuotaPeriod.mode == 'classic', QuotaPeriod.source == 'purchase',
            QuotaPeriod.revoked_at.is_(None), QuotaPeriod.granted > QuotaPeriod.used + QuotaPeriod.reserved,
            QuotaPeriod.starts_at <= at, or_(QuotaPeriod.ends_at.is_(None), QuotaPeriod.ends_at > at))
        .order_by(QuotaPeriod.ends_at.asc().nulls_last(), QuotaPeriod.starts_at, QuotaPeriod.id).limit(1)).first()


def plan_expression(at):
    """SQL equivalent of effective membership selection for paginated filters."""
    from .models import User
    subscription = select(BillingPlanRevision.plan_id).join(BillingPrice,
        BillingPrice.plan_revision_id == BillingPlanRevision.id).join(BillingTerm,
        BillingTerm.price_id == BillingPrice.id).where(BillingTerm.owner_id == User.id,
        BillingTerm.revoked_at.is_(None), BillingTerm.starts_at <= at, BillingTerm.ends_at > at).order_by(
        BillingPlanRevision.hourly_image_limit.is_(None).desc(), BillingPlanRevision.hourly_image_limit.desc(),
        BillingPlanRevision.monthly_redraw_pages.desc(), BillingPlanRevision.plan_id.desc()).limit(1).scalar_subquery()
    operator = and_(User.plus_pending.is_(False), User.plus_started_at <= at, User.plus_expires_at > at)
    return case((operator, 'plus'), else_=func.coalesce(subscription, 'free'))


def access_dates(db, owner_id, at=None):
    terms = active_terms(db, owner_id, at)
    return (min(t.starts_at for t in terms), max(t.ends_at for t in terms)) if terms else (None, None)
