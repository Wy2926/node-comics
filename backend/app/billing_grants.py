"""A settled billing term grants access and separately bounded monthly quotas."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
from . import stripe_client as stripe
from .billing_models import BillingInvoice, BillingPlanRevision, BillingPrice, BillingTerm
from .entitlement_models import QuotaPeriod
from .entitlements import MONTHLY, month_boundary
from .providers import digest


def timestamp(value):
    if value is None:
        return None
    stripe.require(type(value) in (int, float) and value > 0, 'STRIPE_INVALID_TIMESTAMP')
    try:
        return datetime.fromtimestamp(value, timezone.utc).replace(tzinfo=None)
    except (ValueError, OverflowError, OSError):
        raise stripe.BillingError('STRIPE_INVALID_TIMESTAMP') from None


def grant_term(db, user, sub, price, kind, start, end, invoice_id=None):
    stripe.require(start and end and start < end, 'STRIPE_PERIOD_MISSING')
    term_id = digest([sub.id, kind, start.isoformat()])
    existing = db.get(BillingTerm, term_id)
    if existing:
        stripe.require(existing.owner_id == user.id and existing.price_id == price.id
            and existing.ends_at == end, 'STRIPE_TERM_CONFLICT')
        return
    revision = db.get(BillingPlanRevision, price.plan_revision_id)
    db.add(BillingTerm(id=term_id, owner_id=user.id, subscription_id=sub.id, price_id=price.id,
        invoice_id=invoice_id, kind=kind, starts_at=start, ends_at=end))
    db.flush()
    count = 12 if kind == 'paid' and price.interval == 'year' else 1
    pages = revision.trial_redraw_pages if kind == 'trial' else revision.monthly_redraw_pages
    # Compute every boundary from the original anchor: Jan 31 -> Feb 28 -> Mar 31.
    # Future buckets exist durably but cannot be spent before their starts_at.
    for index in range(count):
        period_start = month_boundary(start, index, 'UTC')
        period_end = end if index == count-1 else month_boundary(start, index+1, 'UTC')
        stripe.require(period_start < period_end <= end, 'STRIPE_PERIOD_MISSING')
        key = f'term:{term_id}:{index}'
        db.add(QuotaPeriod(id=digest([user.id, key]), owner_id=user.id, billing_term_id=term_id,
            kind=MONTHLY, mode='redraw', source='subscription', source_key=key,
            starts_at=period_start, ends_at=period_end, granted=pages, used=0, reserved=0,
            grants_access=False, note=f'{revision.name} · ' + ('试用' if kind == 'trial' else f'月额度 {index+1}/{count}')))
    db.flush()


def invoice_subscription(invoice):
    return ((invoice.get('parent') or {}).get('subscription_details') or {}).get('subscription')


def apply_invoice(db, user, sub, invoice):
    stripe.environment(invoice)
    stripe.require(invoice_subscription(invoice) == sub.id and invoice.get('customer') == sub.customer_id)
    receipt = db.get(BillingInvoice, invoice['id'])
    if receipt:
        stripe.require(receipt.subscription_id == sub.id)
        return
    if invoice.get('status') != 'paid' or invoice.get('billing_reason') not in ('subscription_create', 'subscription_cycle'):
        return
    price = db.get(BillingPrice, sub.price_id)
    stripe.require(invoice.get('amount_remaining') == 0 and invoice.get('currency') == price.currency
        and type(invoice.get('total')) is int, 'STRIPE_INVOICE_INVALID')
    lines = invoice.get('lines') or {}
    rows = ([line for page in stripe.pages('invoices.line_items', invoice['id']) for line in page]
        if lines.get('has_more') else lines.get('data', []))
    candidates = []
    for line in rows:
        details = ((line.get('parent') or {}).get('subscription_item_details') or {})
        remote_price = ((line.get('pricing') or {}).get('price_details') or {})
        if details.get('subscription') != sub.id or details.get('proration') is not False:
            continue
        stripe.require(remote_price.get('price') == price.stripe_price_id
            and remote_price.get('product') == price.stripe_product_id and line.get('quantity') == 1, 'STRIPE_PLAN_MISMATCH')
        period = line.get('period') or {}
        start, end = timestamp(period.get('start')), timestamp(period.get('end'))
        stripe.require(start and end and start < end, 'STRIPE_PERIOD_MISSING')
        if (invoice.get('billing_reason') == 'subscription_create' and invoice['total'] == 0
                and start == sub.trial_starts_at and end == sub.trial_ends_at):
            continue  # A 27-30 day trial must not be mistaken for a paid month.
        low, high = (27, 32) if price.interval == 'month' else (364, 367)
        if timedelta(days=low) <= end-start <= timedelta(days=high):
            candidates.append((start, end))
        else:
            # The zero-value trial creation invoice has no paid term.
            stripe.require(invoice.get('billing_reason') == 'subscription_create' and invoice['total'] == 0
                and start == sub.trial_starts_at and end == sub.trial_ends_at, 'STRIPE_INVOICE_PERIOD_INVALID')
    stripe.require(len(candidates) <= 1, 'STRIPE_INVOICE_INVALID')
    if not candidates:
        stripe.require(sub.trial_starts_at and invoice.get('billing_reason') == 'subscription_create'
            and invoice['total'] == 0, 'STRIPE_INVOICE_PERIOD_INVALID')
    db.add(BillingInvoice(id=invoice['id'], subscription_id=sub.id, currency=price.currency, total=invoice['total']))
    db.flush()
    if candidates:
        start, end = candidates[0]
        grant_term(db, user, sub, price, 'paid', start, end, invoice['id'])
        if sub.paid_ends_at is None or end > sub.paid_ends_at:
            sub.paid_starts_at, sub.paid_ends_at = start, end
        trial = db.scalar(select(BillingTerm).where(BillingTerm.subscription_id == sub.id, BillingTerm.kind == 'trial'))
        if trial and trial.starts_at <= start < trial.ends_at:
            trial.ends_at = max(trial.starts_at + timedelta(microseconds=1), start)
            for bucket in db.scalars(select(QuotaPeriod).where(QuotaPeriod.billing_term_id == trial.id)):
                bucket.ends_at = trial.ends_at
    db.flush()
