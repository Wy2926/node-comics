"""Signed notifications trigger reads of current Stripe resources, never trust event order."""
from datetime import timedelta
from sqlalchemy import or_, select, update
from . import stripe_client as stripe
from .billing_models import BillingAccount, BillingCustomer, BillingCheckout, BillingEvent, BillingSubscription, BillingPlanRevision, BillingPrice, BillingPriceBinding
from .config import settings
from .db import session_factory
from .billing_grants import timestamp, grant_term, apply_invoice, invoice_subscription
from .entitlements import locked_user
from .models import now
from .billing_providers import resource_key, stripe_quote
from .billing_orders import checkout_order, transition, record_subscription_state
from .billing_checkout import customer_for



def sync_subscription(subscription_id, invoice_id=None):
    cfg = settings()
    # This first read only resolves the owner. Read again under the account lock so
    # concurrently arriving old events cannot overwrite newer subscription state.
    hint = stripe.call('subscriptions', 'retrieve', subscription_id)
    with session_factory()() as db:
        known = db.get(BillingSubscription, resource_key('stripe', subscription_id))
        checkout_id = known.checkout_id if known else stripe.intent_id(hint)
        if not checkout_id:
            return  # Another product on the Stripe account, not a failed delivery.
        row = db.get(BillingCheckout, checkout_id) if checkout_id else None
        stripe.require(row is not None, 'STRIPE_ACCOUNT_UNBOUND')
        user = locked_user(db, row.owner_id)
        db.refresh(row)
        subscription = stripe.call('subscriptions', 'retrieve', subscription_id)
        stripe.environment(subscription)
        stripe.require(row.provider == 'stripe' and row.environment == cfg.stripe_environment and stripe.intent_id(subscription) == row.id)
        # A subscription must originate from this authenticated, server-created Checkout.
        stripe.require(row.session_id is not None, 'STRIPE_CHECKOUT_PENDING')
        session = stripe.call('checkout.sessions', 'retrieve', row.session_id)
        stripe.environment(session)
        stripe.require(session.get('status') == 'complete' and session.get('mode') == 'subscription'
            and session.get('subscription') == subscription_id and stripe.intent_id(session) == row.id
            and session.get('client_reference_id') == row.id and session.get('customer') == subscription.get('customer'))
        items = subscription.get('items') or {}
        stripe.require(not items.get('has_more') and len(items.get('data', [])) == 1, 'STRIPE_PLAN_MISMATCH')
        item = items['data'][0]
        stripe.require(item.get('quantity') == 1, 'STRIPE_PLAN_MISMATCH')
        price = db.get(BillingPrice, row.price_id)
        binding = db.get(BillingPriceBinding, row.binding_id)
        stripe.approved_price(item.get('price') or {}, stripe_quote(binding, price))
        revision = db.get(BillingPlanRevision, price.plan_revision_id)
        account = db.get(BillingAccount, row.owner_id)
        stripe.require(account is not None)
        customer = customer_for(db, row.owner_id, 'stripe')
        if customer is None:
            customer = BillingCustomer(owner_id=user.id, provider='stripe', environment=cfg.stripe_environment, customer_id=subscription['customer'])
            db.add(customer)
        stripe.require(customer.customer_id == subscription['customer'])
        sub = db.get(BillingSubscription, resource_key('stripe', subscription_id))
        previous_status = sub.status if sub else None
        if sub is None:
            sub = BillingSubscription(id=resource_key('stripe', subscription_id), provider='stripe', binding_id=row.binding_id, owner_id=user.id, checkout_id=row.id,
                environment=cfg.stripe_environment, customer_id=customer.customer_id, price_id=price.id, status=subscription['status'])
            db.add(sub)
            db.flush()
        stripe.require(sub.owner_id == user.id and sub.customer_id == customer.customer_id)
        sub.status, sub.synced_at = subscription['status'], now()
        end = timestamp(item.get('current_period_end'))
        sub.cancel_at = timestamp(subscription.get('cancel_at')) or (end if subscription.get('cancel_at_period_end') else None)
        sub.next_billed_at = end if sub.status in ('active', 'trialing') and not sub.cancel_at else None
        # Retain the original trial dates even when the first callback arrives after conversion.
        start, trial_end = timestamp(subscription.get('trial_start')), timestamp(subscription.get('trial_end'))
        if start and trial_end and sub.trial_starts_at is None:
            stripe.require(row.trial and account.trial_used_at is None, 'STRIPE_TRIAL_ALREADY_USED')
            stripe.require(timedelta(0) < trial_end-start <= timedelta(days=revision.trial_days, minutes=1), 'STRIPE_TRIAL_PERIOD_INVALID')
            grant_term(db, user, sub, price, 'trial', start, trial_end)
            sub.trial_starts_at, sub.trial_ends_at = start, trial_end
        if row.trial:
            account.trial_used_at = account.trial_used_at or now()
        if invoice_id:
            apply_invoice(db, user, sub, stripe.call('invoices', 'retrieve', invoice_id))
        else:
            # Scan paid invoices without a created-at watermark: old unpaid invoices
            # may settle much later. Receipts make all replayed pages idempotent.
            for invoices in stripe.pages('invoices', subscription=subscription_id):
                for invoice in invoices:
                    apply_invoice(db, user, sub, invoice)
        order = checkout_order(db, row)
        order.subscription_id = sub.id
        if sub.status == 'trialing' and order.status not in ('paid', 'refunded', 'disputed'):
            transition(db, order, 'trialing', 'subscription_sync')
        record_subscription_state(db, sub, previous_status)
        row.status, row.error_code, row.last_checked_at = 'completed', None, now()
        db.commit()


def sync_session(session_id):
    from .billing_checkout import bind_session
    session = stripe.call('checkout.sessions', 'retrieve', session_id)
    checkout_id = stripe.intent_id(session)
    if not checkout_id:
        return
    with session_factory()() as db:
        stripe.require(checkout_id and db.get(BillingCheckout, checkout_id), 'STRIPE_ACCOUNT_UNBOUND')
    bind_session(checkout_id, session)
    if session.get('status') == 'complete' and session.get('subscription'):
        sync_subscription(session['subscription'])
