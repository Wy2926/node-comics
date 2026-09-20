"""Stripe refunds resolve the original invoice before recording/revoking access."""
from sqlalchemy import select
from . import stripe_client as stripe
from .billing_models import BillingSubscription, BillingOrder
from .billing_providers import resource_key, require, provider_environment
from .billing_orders import transition, revoke_invoice
from .db import session_factory
from .entitlements import locked_user


def sync_refund_event(payload, event_id):
    charge_id = payload.get('charge_id')
    require(charge_id, 'STRIPE_REFUND_UNBOUND')
    charge = stripe.call('charges', 'retrieve', charge_id)
    stripe.environment(charge)
    invoice_id = charge.get('invoice')
    if not invoice_id:
        # New Stripe API versions expose the invoice via invoice payments.
        require(isinstance(charge.get('payment_intent'), str) and charge['payment_intent'].startswith('pi_'),
            'STRIPE_REFUND_UNBOUND')
        payments = stripe.call('invoice_payments', 'list', params={'payment': {'type': 'payment_intent',
            'payment_intent': charge.get('payment_intent')}, 'limit': 100})
        invoices = {p.get('invoice') for p in payments.get('data', []) if p.get('invoice')}
        require(len(invoices) == 1 and not payments.get('has_more'), 'STRIPE_REFUND_UNBOUND')
        invoice_id = invoices.pop()
    with session_factory()() as db:
        order = db.scalar(select(BillingOrder).where(BillingOrder.provider == 'stripe', BillingOrder.environment == provider_environment('stripe'), BillingOrder.external_id == invoice_id))
        require(order is not None, 'STRIPE_REFUND_UNBOUND')
        locked_user(db, order.owner_id)
        db.refresh(order)
        # The first read resolves ownership. Re-read under its lock so a delayed
        # partial-refund worker cannot overwrite a newer full refund or dispute.
        charge = stripe.call('charges', 'retrieve', charge_id)
        stripe.environment(charge)
        require(charge.get('customer') == db.get(BillingSubscription, order.subscription_id).customer_id)
        if charge.get('disputed'):
            state = 'disputed'
        elif charge.get('refunded'):
            state = 'refunded'
        elif (charge.get('amount_refunded') or 0) > 0:
            state = 'partially_refunded'
        else:
            return
        transition(db, order, state, 'refund_sync', event_id)
        if state in ('refunded', 'disputed'):
            revoke_invoice(db, resource_key('stripe', invoice_id))
        db.commit()
