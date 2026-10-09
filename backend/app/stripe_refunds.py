"""Stripe reversals resolve the exact invoice or one-time payment before revocation."""
from sqlalchemy import func, select
from . import stripe_client as stripe
from .billing_models import BillingCheckout, BillingSubscription, BillingOrder, BillingRefund, BillingDispute
from .billing_providers import resource_key, require, provider_environment
from .billing_orders import transition, revoke_invoice
from .db import session_factory
from .entitlements import locked_user
from .billing_reversals import record_reversal
from .billing_grants import timestamp
from .models import now

FORMAL_DISPUTES = ('needs_response', 'under_review', 'won', 'lost')
INQUIRIES = ('warning_needs_response', 'warning_under_review', 'warning_closed', 'prevented')
REFUND_STATUSES = ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')


def record_charge_reversals(db, order, charge_id, event_id=None):
    # Charge aggregates can lag exact reversal resources. Inspect this charge,
    # never customer history; cap each complete read at ten pages and fail closed.
    for kind in ('refund', 'dispute'):
        cursor = None
        for _ in range(10):
            result = stripe.call(kind + 's', 'list', params={'charge': charge_id, 'limit': 100,
                **({'starting_after': cursor} if cursor else {})})
            values = result.get('data')
            require(isinstance(values, list) and len(values) <= 100 and type(result.get('has_more')) is bool,
                'STRIPE_REVERSALS_UNVERIFIED')
            for value in values:
                if kind == 'dispute':
                    stripe.environment(value)
                statuses = REFUND_STATUSES if kind == 'refund' else (*FORMAL_DISPUTES, *INQUIRIES)
                require(value.get('charge') == charge_id and value.get('status') in statuses
                    and type(value.get('amount')) is int and value.get('currency') == order.currency,
                    'STRIPE_REVERSALS_UNVERIFIED')
                record_reversal(db, order, kind, value.get('id'), amount=value['amount'],
                    currency=value['currency'], status=value['status'],
                    occurred_at=timestamp(value.get('created')) or now(), observed_at=now(), event_id=event_id)
            if not result['has_more']:
                break
            require(values and values[-1].get('id') and values[-1]['id'] != cursor, 'STRIPE_REVERSALS_UNVERIFIED')
            cursor = values[-1]['id']
        else:
            require(False, 'STRIPE_REVERSALS_UNVERIFIED')
    db.flush()
    return db.scalar(select(func.coalesce(func.sum(BillingRefund.amount), 0)).where(
        BillingRefund.order_id == order.id, BillingRefund.status == 'succeeded', BillingRefund.currency == order.currency))


def has_formal_dispute(db, order):
    # A won chargeback remains a formal dispute; our terminal revocation policy
    # does not automatically restore it. Inquiries alone do not newly revoke.
    return db.scalar(select(BillingDispute.id).where(BillingDispute.order_id == order.id,
        BillingDispute.provider == 'stripe', BillingDispute.environment == order.environment,
        BillingDispute.status.in_(FORMAL_DISPUTES)).limit(1)) is not None


def sync_refund_event(payload, event_id, *, expected_invoice_id=None):
    charge_id = payload.get('charge_id')
    require(charge_id, 'STRIPE_REFUND_UNBOUND')
    charge = stripe.call('charges', 'retrieve', charge_id)
    stripe.environment(charge)
    invoice_id = charge.get('invoice')
    purchase = None
    payment_id = charge.get('payment_intent')
    if not invoice_id and payment_id:
        with session_factory()() as db:
            purchase = db.scalar(select(BillingOrder).where(BillingOrder.provider == 'stripe',
                BillingOrder.environment == provider_environment('stripe'), BillingOrder.external_id == payment_id,
                BillingOrder.subscription_id.is_(None)))
        if purchase:
            invoice_id = payment_id
    if not invoice_id:
        # New Stripe API versions expose the invoice via invoice payments.
        require(isinstance(charge.get('payment_intent'), str) and charge['payment_intent'].startswith('pi_'),
            'STRIPE_REFUND_UNBOUND')
        payments = stripe.call('invoice_payments', 'list', params={'payment': {'type': 'payment_intent',
            'payment_intent': charge.get('payment_intent')}, 'limit': 100})
        invoices = {p.get('invoice') for p in payments.get('data', []) if p.get('invoice')}
        require(len(invoices) <= 1 and not payments.get('has_more'), 'STRIPE_REFUND_UNBOUND')
        if invoices:
            invoice_id = invoices.pop()
        else:
            # A one-time charge has no invoice. Recover its exact authenticated
            # Checkout, even when the reversal arrives before checkout.completed.
            payment = stripe.call('payment_intents', 'retrieve', payment_id)
            stripe.environment(payment)
            checkout_id = stripe.intent_id(payment)
            with session_factory()() as db:
                row = db.get(BillingCheckout, checkout_id) if checkout_id else None
                require(row is not None and row.provider == 'stripe', 'STRIPE_REFUND_UNBOUND')
            sessions = stripe.call('checkout.sessions', 'list', params={'payment_intent': payment_id, 'limit': 2})
            matches = [value for value in sessions.get('data', []) if stripe.intent_id(value) == checkout_id]
            require(len(matches) == 1 and not sessions.get('has_more'), 'STRIPE_REFUND_UNBOUND')
            from .stripe_billing_sync import sync_session
            sync_session(matches[0]['id'])
            invoice_id = payment_id
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
        customer = (db.get(BillingSubscription, order.subscription_id) if order.subscription_id
            else db.get(BillingCheckout, order.checkout_id))
        require(customer is not None and charge.get('customer') == customer.customer_id)
        if not order.subscription_id:
            require(charge.get('payment_intent') == order.external_id, 'STRIPE_REFUND_UNBOUND')
        require(charge.get('currency') == order.currency, 'BILLING_REVERSAL_CURRENCY_MISMATCH')
        refunded_total = charge.get('amount_refunded')
        charge_amount = charge.get('amount')
        require(type(charge_amount) is int and type(refunded_total) is int
            and 0 <= refunded_total <= charge_amount, 'STRIPE_REFUND_INVALID')
        # A charge may only be one installment of an invoice. Its aggregate is
        # an invoice aggregate only when it covered this invoice in full.
        if charge_amount == order.total:
            order.refunded_total = max(order.refunded_total or 0, refunded_total)
        recorded_total = record_charge_reversals(db, order, charge_id, event_id)
        if charge_amount == order.total:
            order.refunded_total = max(order.refunded_total or 0, recorded_total)
        if charge.get('disputed') or has_formal_dispute(db, order):
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
            if order.subscription_id:
                revoke_invoice(db, resource_key('stripe', invoice_id))
            else:
                from .billing_purchases import revoke_purchase
                revoke_purchase(db, order)
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


def sync_purchase_reversals(payment_id):
    """Reconcile this one-time payment's charge, never an unrelated invoice."""
    payment = stripe.call('payment_intents', 'retrieve', payment_id)
    stripe.environment(payment)
    require(payment.get('id') == payment_id and isinstance(payment.get('latest_charge'), str), 'STRIPE_REFUND_UNBOUND')
    return sync_refund_event({'charge_id': payment['latest_charge']}, None)
