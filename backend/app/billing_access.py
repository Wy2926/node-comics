"""Read paid/trial access from granted terms, independently of quota balances."""
from sqlalchemy import and_, case, func, literal, or_, select, union_all
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


def first_subscription(db, owner_id, at):
    """Choose a spendable monthly bucket with the service that issued it."""
    from .entitlement_models import QuotaPeriod
    return db.execute(select(QuotaPeriod, BillingPlanRevision).join(BillingTerm,
        BillingTerm.id == QuotaPeriod.billing_term_id).join(BillingPrice,
        BillingPrice.id == BillingTerm.price_id).join(BillingPlanRevision,
        BillingPlanRevision.id == BillingPrice.plan_revision_id).where(
            QuotaPeriod.owner_id == owner_id, BillingTerm.owner_id == owner_id,
            QuotaPeriod.source == 'subscription', QuotaPeriod.mode == 'classic',
            QuotaPeriod.revoked_at.is_(None),
            BillingTerm.revoked_at.is_(None), BillingTerm.starts_at <= at, BillingTerm.ends_at > at,
            QuotaPeriod.starts_at <= at, QuotaPeriod.ends_at > at,
            QuotaPeriod.granted > QuotaPeriod.used + QuotaPeriod.reserved)
        .order_by(QuotaPeriod.ends_at, QuotaPeriod.starts_at, QuotaPeriod.id).limit(1)).first()


def plan_expression(at):
    """SQL equivalent of effective membership selection for paginated filters."""
    from .models import User
    unlimited = case((BillingTerm.kind == 'trial', BillingPlanRevision.trial_classic_pages),
                     else_=BillingPlanRevision.monthly_classic_pages).is_(None)
    subscription = select(BillingPlanRevision.plan_id.label('plan'), unlimited.label('unlimited'),
        BillingPlanRevision.hourly_image_limit.is_(None).label('unlimited_rate'),
        BillingPlanRevision.hourly_image_limit.label('hourly')).join(BillingPrice,
        BillingPrice.plan_revision_id == BillingPlanRevision.id).join(BillingTerm,
        BillingTerm.price_id == BillingPrice.id).where(BillingTerm.owner_id == User.id,
        BillingTerm.revoked_at.is_(None), BillingTerm.starts_at <= at, BillingTerm.ends_at > at).correlate(User)
    operator = and_(User.plus_pending.is_(False), User.plus_started_at <= at, User.plus_expires_at > at)
    gift = select(literal('plus'), User.plus_monthly_pages.is_(None), literal(True), literal(None))\
        .where(operator).correlate(User)
    choices = union_all(subscription, gift).subquery()
    selected = select(choices.c.plan).order_by(choices.c.unlimited.desc(), choices.c.unlimited_rate.desc(),
        choices.c.hourly.desc(), choices.c.plan.desc()).limit(1).scalar_subquery()
    return func.coalesce(selected, 'free')


def access_dates(db, owner_id, at=None):
    terms = active_terms(db, owner_id, at)
    return (min(t.starts_at for t in terms), max(t.ends_at for t in terms)) if terms else (None, None)
