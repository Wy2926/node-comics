"""Stripe refunds resolve the original invoice before recording/revoking access."""
from sqlalchemy import func, select
from . import stripe_client as stripe
from .billing_models import BillingSubscription, BillingOrder, BillingRefund
from .billing_providers import resource_key, require, provider_environment
from .billing_orders import transition, revoke_invoice
from .db import session_factory
from .entitlements import locked_user
from .billing_reversals import record_reversal
from .billing_grants import timestamp
from .models import now


def sync_refund_event(payload, event_id, *, expected_invoice_id=None):
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
    require(expected_invoice_id is None or invoice_id == expected_invoice_id, 'STRIPE_REFUND_UNBOUND')
    with session_factory()() as db:
        order = db.scalar(select(BillingOrder).where(BillingOrder.provider == 'stripe', BillingOrder.environment == provider_environment('stripe'), BillingOrder.external_id == invoice_id))
        require(order is not None, 'STRIPE_REFUND_UNBOUND')
        locked_user(db, order.owner_id)
        db.refresh(order)
        # The first read resolves ownership. Re-read under its lock so a delayed
        # partial-refund worker cannot overwrite a newer full refund or dispute.
        charge = stripe.call('charges', 'retrieve', charge_id)
        stripe.environment(charge)
        require(charge.get('id') == charge_id and charge.get('invoice') in (None, invoice_id), 'STRIPE_REFUND_UNBOUND')
        require(charge.get('customer') == db.get(BillingSubscription, order.subscription_id).customer_id)
        require(charge.get('currency') == order.currency, 'BILLING_REVERSAL_CURRENCY_MISMATCH')
        refunded_total = charge.get('amount_refunded')
        charge_amount = charge.get('amount')
        require(type(charge_amount) is int and type(refunded_total) is int
            and 0 <= refunded_total <= charge_amount, 'STRIPE_REFUND_INVALID')
        # A charge may only be one installment of an invoice. Its aggregate is
        # an invoice aggregate only when it covered this invoice in full.
        if charge_amount == order.total:
            order.refunded_total = max(order.refunded_total or 0, refunded_total)
        for kind, resource in (('refund', 'refunds'), ('dispute', 'disputes')):
            if kind == 'refund' and not refunded_total and not payload.get('refund_id'):
                continue
            if kind == 'dispute' and not charge.get('disputed') and not payload.get('dispute_id') and not expected_invoice_id:
                continue
            for rows in stripe.pages(resource, charge=charge_id):
                for value in rows:
                    # Refunds do not carry livemode; their authenticated charge binds the environment.
                    if kind == 'dispute':
                        stripe.environment(value)
                    require(value.get('charge') == charge_id, 'STRIPE_REFUND_UNBOUND')
                    record_reversal(db, order, kind, value.get('id'), amount=value.get('amount'),
                        currency=value.get('currency'), status=value.get('status') or 'unknown',
                        occurred_at=timestamp(value.get('created')) or now(), observed_at=now(), event_id=event_id)
        db.flush()
        recorded_total = db.scalar(select(func.coalesce(func.sum(BillingRefund.amount), 0)).where(
            BillingRefund.order_id == order.id, BillingRefund.status == 'succeeded', BillingRefund.currency == order.currency))
        if charge.get('disputed'):
            state = 'disputed'
        elif (order.total > 0 and recorded_total >= order.total) or (charge.get('refunded') and charge_amount == order.total):
            state = 'refunded'
        elif refunded_total > 0 or recorded_total > 0:
            state = 'partially_refunded'
        else:
            state = None
        if state and not (order.status in ('refunded', 'disputed') and state == 'partially_refunded'):
            transition(db, order, state, 'refund_sync', event_id)
        if state in ('refunded', 'disputed'):
            revoke_invoice(db, resource_key('stripe', invoice_id))
        db.commit()
        return charge_amount, refunded_total


def sync_invoice_reversals(invoice_id):
    """Read payment references for this invoice only; never select a customer's newest payment."""
    invoice = stripe.call('invoices', 'retrieve', invoice_id)
    stripe.environment(invoice)
    require(invoice.get('id') == invoice_id, 'STRIPE_REFUND_UNBOUND')
    if invoice.get('total') == 0:
        return
    charges = set()
    if isinstance(invoice.get('charge'), str):
        charges.add(invoice['charge'])
    else:
        for rows in stripe.pages('invoice_payments', invoice=invoice_id, status='paid'):
            for row in rows:
                require(row.get('invoice') == invoice_id, 'STRIPE_REFUND_UNBOUND')
                payment = row.get('payment') or {}
                if payment.get('type') == 'charge':
                    charge_id = payment.get('charge')
                elif payment.get('type') == 'payment_intent':
                    intent = stripe.call('payment_intents', 'retrieve', payment.get('payment_intent'))
                    stripe.environment(intent)
                    require(intent.get('customer') == invoice.get('customer'), 'STRIPE_REFUND_UNBOUND')
                    charge_id = intent.get('latest_charge')
                else:
                    # Offline/payment-record payments have no Stripe charge to inspect.
                    continue
                require(isinstance(charge_id, str), 'STRIPE_REFUND_UNBOUND')
                charges.add(charge_id)
    totals = [sync_refund_event({'charge_id': charge_id}, None, expected_invoice_id=invoice_id) for charge_id in sorted(charges)]
    if totals and sum(amount for amount, _ in totals) == invoice.get('total'):
        with session_factory()() as db:
            order = db.scalar(select(BillingOrder).where(BillingOrder.provider == 'stripe',
                BillingOrder.environment == provider_environment('stripe'), BillingOrder.external_id == invoice_id))
            require(order is not None, 'STRIPE_REFUND_UNBOUND')
            locked_user(db, order.owner_id)
            db.refresh(order)
            order.refunded_total = max(order.refunded_total or 0, sum(refunded for _, refunded in totals))
            db.commit()
