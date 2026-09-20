"""Payment ledger and append-only state changes, under the owner's billing lock."""
from sqlalchemy import select
from .billing_models import BillingCheckout, BillingOrder, BillingOrderTransition, BillingPrice, BillingTerm
from .models import now, uid


def transition(db, order, status, source, event_id=None, detail=None):
    if order.status == status:
        return
    previous = order.status
    order.status, order.updated_at = status, now()
    if status not in ('unknown', 'failed'):
        order.error_code = None
    if status == 'paid':
        order.paid_at = order.paid_at or now()
    db.add(BillingOrderTransition(order_id=order.id, source=source, event_id=event_id,
        from_status=previous or None, to_status=status, detail=detail or {}))


def checkout_order(db, row):
    order = db.scalar(select(BillingOrder).where(BillingOrder.checkout_id == row.id, BillingOrder.kind == 'initial'))
    if order is None:
        price = db.get(BillingPrice, row.price_id)
        order = BillingOrder(id=uid(), owner_id=row.owner_id, provider=row.provider, environment=row.environment,
            checkout_id=row.id, price_id=price.id, binding_id=row.binding_id, kind='initial', status='',
            currency=price.currency, subtotal=price.unit_amount, total=0 if row.trial else price.unit_amount)
        db.add(order)
        db.flush()
        transition(db, order, 'creating', 'checkout')
    return order


def payment_order(db, sub, external_id, total, status, source, *, event_id=None, subtotal=None):
    order = db.scalar(select(BillingOrder).where(BillingOrder.provider == sub.provider,
        BillingOrder.environment == sub.environment, BillingOrder.external_id == external_id))
    if order is None:
        initial = db.scalar(select(BillingOrder).where(BillingOrder.checkout_id == sub.checkout_id,
            BillingOrder.kind == 'initial'))
        # The zero-value trial is its own order; conversion becomes a paid renewal.
        if initial and initial.external_id is None and (initial.status != 'trialing' or total == 0):
            order = initial
        else:
            price = db.get(BillingPrice, sub.price_id)
            order = BillingOrder(id=uid(), owner_id=sub.owner_id, provider=sub.provider, environment=sub.environment,
                checkout_id=sub.checkout_id, subscription_id=sub.id, price_id=sub.price_id, binding_id=sub.binding_id,
                kind='renewal', status='', currency=price.currency, total=total)
            db.add(order)
            db.flush()
        order.external_id = external_id
    order.subscription_id, order.total = sub.id, total
    order.subtotal = subtotal
    # Invoices remain paid after their charge is refunded or disputed. Ordinary
    # settlement polling must not undo that independently verified reversal.
    if order.status in ('refunded', 'disputed') and status in ('trialing', 'partially_refunded'):
        return order
    if order.status in ('refunded', 'disputed', 'partially_refunded') and status in (
            'paid', 'pending', 'failed', 'canceled', 'unknown'):
        return order
    transition(db, order, status, source, event_id)
    return order


def record_subscription_state(db, sub, previous_status, event_id=None):
    """Subscription lifecycle belongs in the audit log without changing payment state."""
    if previous_status == sub.status:
        return
    order = checkout_order(db, db.get(BillingCheckout, sub.checkout_id))
    order.updated_at = now()
    db.add(BillingOrderTransition(order_id=order.id, source='subscription_sync', event_id=event_id,
        from_status=order.status, to_status=order.status,
        detail={'subscription_from': previous_status, 'subscription_to': sub.status}))


def revoke_invoice(db, invoice_id):
    for term in db.scalars(select(BillingTerm).where(BillingTerm.invoice_id == invoice_id)):
        term.revoked_at = term.revoked_at or now()
