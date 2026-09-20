"""Read paid/trial access from granted terms, independently of quota balances."""
from sqlalchemy import select
from .billing_models import BillingTerm
from .models import now


def active_terms(db, owner_id, at=None):
    at = at or now()
    return list(db.scalars(select(BillingTerm).where(BillingTerm.owner_id == owner_id,
        BillingTerm.revoked_at.is_(None), BillingTerm.starts_at <= at, BillingTerm.ends_at > at).order_by(BillingTerm.starts_at)))


def access_exists(at):
    from .models import User
    return select(BillingTerm.id).where(BillingTerm.owner_id == User.id,
        BillingTerm.revoked_at.is_(None), BillingTerm.starts_at <= at, BillingTerm.ends_at > at).exists()


def access_dates(db, owner_id, at=None):
    terms = active_terms(db, owner_id, at)
    return (min(t.starts_at for t in terms), max(t.ends_at for t in terms)) if terms else (None, None)
