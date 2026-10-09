"""Gift periods suspend billing, while settled invoices retain their original dates."""
from datetime import timedelta, timezone
from sqlalchemy import or_, select
from .billing_models import BillingCheckout, BillingOrderTransition, BillingPrice, BillingSubscription, BillingTerm
from .billing_providers import BillingError, provider_enabled, remote_id, require
from .db import session_factory
from .models import now


LIVE = ('active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'scheduled_cancel')


def paid_through(db, user, at):
    return max([at, *db.scalars(select(BillingTerm.ends_at).where(
        BillingTerm.owner_id == user.id, BillingTerm.revoked_at.is_(None), BillingTerm.ends_at > at))])


def billing_second(value):
    return value.replace(microsecond=0) + (timedelta(seconds=1) if value.microsecond else timedelta())


def audit(db, sub, action, state):
    from .billing_orders import checkout_order
    order = checkout_order(db, db.get(BillingCheckout, sub.checkout_id))
    db.add(BillingOrderTransition(order_id=order.id, source='renewal', from_status=order.status,
        to_status=order.status, detail={'action': action, 'state': state,
            'membership_id': sub.gift_membership_id}))


def activate(db, user, at):
    from .entitlements import activate_gift
    # An unconfirmed gift never starts counting down while the gateway is uncertain.
    start = paid_through(db, user, at)
    activate_gift(db, user, start=max(user.plus_started_at, start) if user.plus_pending else None)


def schedule_gift(db, user, at):
    """Called inside the existing membership operation and account transaction."""
    from .entitlements import activate_gift
    from .errors import problem
    valid = bool(user.plus_started_at and user.plus_expires_at and
        user.plus_expires_at > user.plus_started_at and (user.plus_pending or user.plus_expires_at > at))
    if not valid:
        user.plus_pending = False
        return  # Revocation must never bring an agreed charge date forward.
    from .billing_checkout import pending_checkout_condition
    if db.scalar(select(BillingCheckout.id).join(BillingPrice, BillingPrice.id == BillingCheckout.price_id)
            .where(BillingCheckout.owner_id == user.id, BillingPrice.interval != 'once',
                pending_checkout_condition()).limit(1)):
        problem('BILLING_CHECKOUT_PENDING', '请先核实当前结账，再安排赠送会员', 409)
    subscriptions = list(db.scalars(select(BillingSubscription).where(BillingSubscription.owner_id == user.id,
        BillingSubscription.status.in_(LIVE)).limit(2)))
    if len(subscriptions) > 1:
        problem('BILLING_DUPLICATE_SUBSCRIPTIONS', '存在多笔有效订阅，请先人工核实再安排赠送', 409)
    sub = subscriptions[0] if subscriptions else None
    if sub and sub.renewal_action in ('resume', 'cancel'):
        problem('BILLING_RENEWAL_PENDING', '请先核实当前续费操作，再安排赠送会员', 409)
    if not sub or not sub.auto_renew or sub.cancel_at:
        activate(db, user, at) if user.plus_pending else activate_gift(db, user)
        return
    if sub.status in ('past_due', 'unpaid', 'incomplete'):
        problem('BILLING_RENEWAL_PENDING', '请先处理未结清的订阅或确认取消续费，再安排赠送', 409)
    if sub.gift_membership_id and sub.gift_membership_id != user.membership_id:
        problem('BILLING_RENEWAL_PENDING', '原赠送订阅尚待核实，请稍后重试', 409)
    if (sub.provider == 'stripe' and sub.resume_at and user.plus_expires_at > sub.resume_at
            and (sub.gift_deferred or sub.renewal_action_at)):
        problem('BILLING_GIFT_EXTENSION_UNSUPPORTED', '此 Stripe 订阅请先确认取消自动续费，再追加赠送；现有赠送不变', 409)
    sub.gift_membership_id = user.membership_id
    previous_end = sub.resume_at
    sub.resume_at = billing_second(max(sub.resume_at or user.plus_expires_at, user.plus_expires_at))
    if sub.gift_deferred and (sub.provider == 'creem' or previous_end == sub.resume_at):
        activate_gift(db, user)
        return
    if not sub.renewal_action:
        sub.renewal_action, sub.renewal_action_at, sub.renewal_error = 'pause', None, None
        audit(db, sub, 'pause', 'pending')


def renewal_json(sub):
    state = ('attention' if sub.renewal_error else
        {'pause': 'deferring', 'resume': 'resuming', 'cancel': 'canceling'}.get(sub.renewal_action) or
        ('canceled' if not sub.auto_renew else 'deferred' if sub.gift_deferred else 'normal'))
    from .entitlements import iso
    return {'auto_renew': bool(sub.auto_renew), 'can_cancel': bool(sub.auto_renew and sub.status in LIVE),
        'renewal_state': state, 'resume_at': iso(sub.resume_at) if sub.auto_renew else None}


def observe_renewal(db, user, sub, remote):
    """Only verified provider reads acknowledge writes; old webhook payloads cannot."""
    from .billing_grants import timestamp
    at = now()
    action = sub.renewal_action
    matches = bool(sub.gift_membership_id and sub.gift_membership_id == user.membership_id)
    scheduled_gift = sub.provider == 'creem' and sub.status == 'scheduled_cancel' and bool(
        sub.gift_membership_id and (sub.gift_deferred or action in ('pause', 'cancel')))
    if scheduled_gift:
        sub.cancel_at = None
    canceled = sub.status in ('canceled', 'expired') or (sub.status == 'scheduled_cancel' and not scheduled_gift) or bool(sub.cancel_at)
    if canceled:
        sub.auto_renew = False
        sub.gift_deferred = False
        sub.renewal_action = sub.renewal_action_at = sub.renewal_error = None
        if action:
            audit(db, sub, action, 'canceled')
        if matches and user.plus_pending:
            activate(db, user, at)
        return
    if not sub.gift_membership_id:
        if sub.status == 'paused':
            sub.auto_renew = False
        return
    if sub.provider == 'creem' and sub.status == 'paused' and at < paid_through(db, user, at):
        # Our scheduled pause cannot execute before the settled paid term ends.
        # An earlier external pause is not permission to resume the subscription.
        sub.auto_renew = sub.gift_deferred = False
        if action != 'cancel':
            sub.renewal_action = sub.renewal_action_at = sub.renewal_error = None
        if matches and user.plus_pending:
            activate(db, user, at)
        return
    paused = (sub.status == 'paused' or scheduled_gift if sub.provider == 'creem' else
        sub.status == 'trialing' and timestamp(remote.get('trial_end')) == sub.resume_at)
    if paused and action == 'pause' and sub.renewal_action_at:
        was_deferred = sub.gift_deferred
        sub.gift_deferred = True
        sub.renewal_action = sub.renewal_action_at = sub.renewal_error = None
        audit(db, sub, 'pause', 'confirmed')
        if matches and user.plus_pending:
            from .entitlements import activate_gift
            if was_deferred:
                activate_gift(db, user)
            else:
                # The channel may already have rolled its period while the new
                # payment receipt is still arriving. Its scheduled pause comes first.
                if scheduled_gift:
                    from .creem_client import timestamp as creem_timestamp
                    at = max(at, creem_timestamp(remote.get('current_period_end_date')) or at)
                activate(db, user, at)
            new_resume = billing_second(max(sub.resume_at, user.plus_expires_at))
            if sub.provider == 'stripe' and new_resume != sub.resume_at:
                user.plus_pending = True
                sub.renewal_action = 'pause'
            sub.resume_at = new_resume
    elif paused and not sub.gift_deferred and action != 'cancel':
        # A customer-managed pause is not permission for us to restart billing.
        sub.auto_renew = False
        sub.renewal_action = sub.renewal_action_at = sub.renewal_error = None
        if matches and user.plus_pending:
            activate(db, user, at)
    elif sub.status in ('active', 'trialing') and sub.gift_deferred and not paused and action != 'pause':
        if (action == 'resume' and sub.renewal_action_at) or (sub.provider == 'stripe' and sub.resume_at <= at):
            audit(db, sub, 'resume', 'confirmed')
            sub.gift_deferred = False
            sub.gift_membership_id = sub.resume_at = None
            sub.renewal_action = sub.renewal_action_at = sub.renewal_error = None
        else:
            # An external restart during a gift requires an operator to reconcile
            # the actual charge. Never silently move an already promised reward.
            sub.renewal_error = 'BILLING_GIFT_RESTARTED'
    if sub.gift_deferred:
        sub.next_billed_at = None


def _dispatch(sub, action, at):
    if sub.provider == 'creem':
        from . import creem_client as creem
        body = ({'mode': 'immediate', 'onExecute': 'cancel'} if action == 'cancel' else
            {'mode': 'scheduled', 'onExecute': 'pause'} if action == 'pause' else None)
        endpoint = 'cancel' if action == 'pause' else action
        creem.call('POST', f'/subscriptions/{remote_id(sub.id)}/{endpoint}', body=body)
    else:
        from . import stripe_client as stripe
        require(action in ('pause', 'cancel'), 'BILLING_RENEWAL_UNSUPPORTED')
        params = ({'cancel_at_period_end': True} if action == 'cancel' else
            {'trial_end': int(sub.resume_at.replace(tzinfo=timezone.utc).timestamp()), 'proration_behavior': 'none'})
        stripe.call('subscriptions', 'update', remote_id(sub.id), params=params,
            options={'idempotency_key': f'renewal:{sub.id}:{action}:{at.isoformat()}'})


def _dispatch_ready(sub, action, at):
    if action == 'cancel':
        return True
    if not sub.auto_renew:
        return False
    if action == 'pause':
        return sub.status in ('active', 'trialing')
    return bool(action == 'resume' and sub.gift_deferred and sub.resume_at
                and sub.resume_at <= at and sub.status == 'paused')


def process_renewal(subscription_id):
    """One durable dispatch. Unknown POSTs are read back, never blindly repeated."""
    from .billing_sync import sync_subscription
    from .entitlements import locked_user
    with session_factory()() as db:
        sub = db.get(BillingSubscription, subscription_id)
        if not sub or not provider_enabled(sub.provider):
            return
        owner, provider = sub.owner_id, sub.provider
    sync_subscription(subscription_id, provider=provider)
    with session_factory()() as db:
        locked_user(db, owner)
        sub = db.get(BillingSubscription, subscription_id, populate_existing=True)
        at = now()
        if not sub.renewal_action and sub.gift_deferred and sub.auto_renew and sub.resume_at <= at:
            if provider == 'stripe':
                return  # Stripe's confirmed trial_end resumes its own billing.
            sub.renewal_action, sub.renewal_action_at, sub.renewal_error = 'resume', None, None
            audit(db, sub, 'resume', 'pending')
        action = sub.renewal_action
        if not action or sub.renewal_action_at or sub.renewal_error:
            return
        if not _dispatch_ready(sub, action, at):
            return
        # A user cancellation serializes on this same row lock. Mark the send
        # durably before performing any external mutation.
        sub.renewal_action_at = at
        audit(db, sub, action, 'dispatched')
        db.commit()
    try:
        # Recheck cancellation immediately before dispatch, under the account
        # lock, so a queued resume cannot override a completed cancellation.
        with session_factory()() as db:
            locked_user(db, owner)
            current = db.get(BillingSubscription, subscription_id, populate_existing=True)
            if current.renewal_action != action or current.renewal_action_at != at:
                return
            if not _dispatch_ready(current, action, now()):
                # This worker has not called the provider. Release only its own
                # unchanged claim; uncertain requests retain their sent marker.
                current.renewal_action_at = None
                audit(db, current, action, 'not_sent')
                db.commit()
                return
            _dispatch(current, action, at)
            db.commit()
        sync_subscription(subscription_id, provider=provider)
    except BillingError as exc:
        with session_factory()() as db:
            locked_user(db, owner)
            sub = db.get(BillingSubscription, subscription_id, populate_existing=True)
            if sub.renewal_action == action and sub.renewal_action_at == at:
                sub.renewal_error = 'BILLING_RENEWAL_UNCERTAIN' if exc.uncertain else exc.code
                audit(db, sub, action, 'unknown' if exc.uncertain else 'failed')
            db.commit()
        raise


def process_owner(owner_id):
    with session_factory()() as db:
        ids = list(db.scalars(select(BillingSubscription.id).where(BillingSubscription.owner_id == owner_id,
            or_(BillingSubscription.renewal_action.is_not(None), BillingSubscription.gift_deferred.is_(True)))))
    for sub_id in ids:
        try:
            process_renewal(sub_id)
        except BillingError:
            pass  # The durable state is returned by the account status endpoint.


def cancel_renewal(owner_id, provider):
    from .entitlements import locked_user
    from .billing_checkout import current_subscription
    with session_factory()() as db:
        locked_user(db, owner_id)
        sub = current_subscription(db, owner_id, provider)
        require(sub is not None, 'SUBSCRIPTION_NOT_FOUND')
        sub.auto_renew = False
        if sub.status in LIVE and sub.renewal_action != 'cancel' and not sub.cancel_at:
            sub.renewal_action, sub.renewal_action_at, sub.renewal_error = 'cancel', None, None
            audit(db, sub, 'cancel', 'requested_by_user')
        db.commit()
    process_owner(owner_id)


def reconcile_renewals(providers):
    at = now()
    with session_factory()() as db:
        ids = list(db.scalars(select(BillingSubscription.id).where(BillingSubscription.provider.in_(providers), or_(
            BillingSubscription.renewal_action.is_not(None),
            (BillingSubscription.gift_deferred.is_(True) & BillingSubscription.auto_renew.is_(True) &
                (BillingSubscription.resume_at <= at))),
            or_(BillingSubscription.renewal_action_at.is_(None), BillingSubscription.synced_at < at - timedelta(minutes=1)))
            .order_by(BillingSubscription.synced_at).limit(20)))
    for sub_id in ids:
        try:
            process_renewal(sub_id)
        except BillingError:
            pass
