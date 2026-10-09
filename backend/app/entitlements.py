"""Account-locked admission and period-locked settlement; reads never grant quota."""
from calendar import monthrange
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import case, func, or_, select, text, update
from .config import settings
from .entitlement_models import MembershipOperation, QuotaPeriod
from .errors import problem
from .models import Asset, Job, Ledger, User, now, uid
from .providers import digest
from .billing_access import active_benefits, active_terms, first_purchase
from .system_settings import get_request_limits
from .admin_audit import record_audit

DAILY = "classic_daily"
MONTHLY = "redraw_monthly"
UNLIMITED = "classic_unlimited"
PURCHASE = "classic_purchase"
GIFT_PERIOD = timedelta(days=30)


def iso(value):
    return value.isoformat() + "Z" if value is not None else None


def locked_user(db, owner_id):
    if db.get_bind().dialect.name == "sqlite":
        db.execute(update(User).where(User.id == owner_id).values(name=User.name))
    # Serialize account mutations without blocking foreign-key inserts in workers.
    return db.scalar(select(User).where(User.id == owner_id).with_for_update(key_share=True)
                     .execution_options(populate_existing=True))


def lock_operation(db, transaction_key):
    """One operator receipt also serializes conflicting targets on PostgreSQL."""
    if db.get_bind().dialect.name == "postgresql":
        lock_id = int(digest(["quota-operation", transaction_key])[:16], 16) - (1 << 63)
        db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_id})


def is_operator_plus(user, at=None):
    at = at or now()
    return bool(not user.plus_pending and user.plus_started_at and user.plus_expires_at
                and user.plus_started_at <= at < user.plus_expires_at)


def gift_json(user, at=None):
    at = at or now()
    if not user.membership_id or not user.plus_started_at or not user.plus_expires_at:
        return None
    start, end = user.plus_started_at, user.plus_expires_at
    state = ('expired' if end <= start or (end <= at and not user.plus_pending) else
             'pending' if user.plus_pending else 'scheduled' if at < start else 'active')
    return {'starts_at': iso(start), 'ends_at': iso(end),
            'days': max(0, (end - start) / timedelta(days=1)), 'state': state}


def is_plus(db, user, at=None):
    at = at or now()
    return is_operator_plus(user, at) or bool(active_terms(db, user.id, at))


def membership_benefits(db, user, at=None):
    at = at or now()
    if is_operator_plus(user, at):
        return {'plan': 'plus', 'paid': True, 'hourly_image_limit': None, 'redraw': True}
    benefits = active_benefits(db, user.id, at)
    if not benefits:
        return {'plan': 'free', 'paid': False, 'hourly_image_limit': None, 'redraw': False}
    # Concurrent granted terms combine access: an unrestricted term keeps its
    # access; otherwise the largest hourly allowance applies to the account.
    revision, _ = max(benefits, key=lambda value: (value[0].hourly_image_limit is None,
        value[0].hourly_image_limit or 0, value[0].monthly_redraw_pages, value[0].plan_id))
    redraw = any((item.trial_redraw_pages if kind == 'trial' else item.monthly_redraw_pages) > 0
        for item, kind in benefits)
    return {'plan': revision.plan_id, 'paid': True, 'hourly_image_limit': revision.hourly_image_limit, 'redraw': redraw}


def plus_dates(db, user, at=None):
    at = at or now()
    ranges = [(term.starts_at, term.ends_at) for term in active_terms(db, user.id, at)]
    if (not user.plus_pending and user.plus_started_at and user.plus_expires_at
            and user.plus_started_at < user.plus_expires_at):
        ranges.append((user.plus_started_at, user.plus_expires_at))
    merged = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return next(((start, end) for start, end in merged if start <= at < end), (None, None))


def month_boundary(anchor, offset, timezone_name):
    local = anchor.replace(tzinfo=timezone.utc).astimezone(ZoneInfo(timezone_name))
    year, month = divmod(local.year * 12 + local.month - 1 + offset, 12)
    value = local.replace(year=year, month=month + 1, day=min(local.day, monthrange(year, month + 1)[1]))
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _gift_period_spec(user, at):
    if not (user.plus_started_at and user.plus_expires_at
            and user.plus_started_at <= at < user.plus_expires_at):
        return None
    if user.plus_timezone:
        # Existing operator segments retain their calendar cycle and bucket IDs.
        zone = ZoneInfo(user.plus_timezone)
        local, anchor = (value.replace(tzinfo=timezone.utc).astimezone(zone)
                         for value in (at, user.plus_started_at))
        index = (local.year - anchor.year) * 12 + local.month - anchor.month
        if month_boundary(user.plus_started_at, index, user.plus_timezone) > at:
            index -= 1
        start = month_boundary(user.plus_started_at, index, user.plus_timezone)
        end = month_boundary(user.plus_started_at, index + 1, user.plus_timezone)
        key, period_id = f'{MONTHLY}:{iso(start)}', digest([user.id, MONTHLY, iso(start)])
    else:
        index = (at - user.plus_started_at) // GIFT_PERIOD
        start = user.plus_started_at + index * GIFT_PERIOD
        end = start + GIFT_PERIOD
        key = f'{MONTHLY}:{user.membership_id}:{index}'
        period_id = digest([user.id, key])
    return {'id': period_id, 'owner_id': user.id, 'kind': MONTHLY,
            'mode': 'redraw', 'source': 'membership', 'source_key': key,
            'starts_at': start, 'ends_at': min(end, user.plus_expires_at),
            'granted': user.plus_monthly_pages}


def _gift_periods(db, user):
    segment = ((QuotaPeriod.starts_at >= user.plus_started_at) & (QuotaPeriod.starts_at < user.plus_expires_at)
               if user.plus_timezone else
               QuotaPeriod.source_key.startswith(f'{MONTHLY}:{user.membership_id}:', autoescape=True))
    return list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.owner_id == user.id,
        QuotaPeriod.source == 'membership', segment)))


def _sync_gift_periods(db, user):
    if not user.plus_started_at or not user.plus_expires_at or user.plus_expires_at <= user.plus_started_at:
        return
    periods = _gift_periods(db, user)
    for period in periods:
        start = (period.starts_at if user.plus_timezone else
                 user.plus_started_at + int(period.source_key.rsplit(':', 1)[1]) * GIFT_PERIOD)
        spec = _gift_period_spec(user, start)
        if spec:
            period.starts_at, period.ends_at = spec['starts_at'], spec['ends_at']
    if not periods:
        db.add(QuotaPeriod(**_gift_period_spec(user, user.plus_started_at)))


def activate_gift(db, user, start=None):
    """Caller holds the account lock; pending gifts retain their full duration."""
    if not user.plus_started_at or not user.plus_expires_at or user.plus_expires_at <= user.plus_started_at:
        user.plus_pending = False
        return
    if start is not None and start != user.plus_started_at:
        if (user.plus_timezone or (not user.plus_pending and user.plus_started_at < now())
                or any(period.used or period.reserved for period in _gift_periods(db, user))):
            problem('MEMBERSHIP_ALREADY_ACTIVE', '已生效或使用的赠送不能重新安排起点', 409)
        duration = user.plus_expires_at - user.plus_started_at
        user.plus_started_at, user.plus_expires_at = start, start + duration
    user.plus_pending = False
    _sync_gift_periods(db, user)


def period_spec(user, kind, at=None, *, db):
    at = at or now()
    if kind == DAILY:
        zone = ZoneInfo(settings().quota_timezone)
        day = at.replace(tzinfo=timezone.utc).astimezone(zone).date()
        start = datetime.combine(day, time.min, zone).astimezone(timezone.utc).replace(tzinfo=None)
        end = datetime.combine(day + timedelta(days=1), time.min, zone).astimezone(timezone.utc).replace(tzinfo=None)
        granted = get_request_limits(db).free_daily_pages
    elif kind == MONTHLY and is_operator_plus(user, at):
        return _gift_period_spec(user, at)
    else:
        return None
    return {"id": digest([user.id, kind, iso(start)]), "owner_id": user.id, "kind": kind,
            "mode": "classic", "source": "daily",
            "source_key": f"{kind}:{iso(start)}",
            "starts_at": start, "ends_at": end, "granted": granted}


def quota_kind(user, mode, at=None, db=None, *, benefits=None):
    benefits = benefits if benefits is not None else membership_benefits(db, user, at)
    plus = benefits['paid']
    if mode == "classic":
        return UNLIMITED if plus else DAILY
    if plus and benefits['redraw']:
        return MONTHLY
    at = at or now()
    if db is not None and db.scalar(select(QuotaPeriod.id).where(QuotaPeriod.owner_id == user.id,
            QuotaPeriod.mode == mode, QuotaPeriod.source == "grant", QuotaPeriod.grants_access.is_(True),
            QuotaPeriod.starts_at <= at, or_(QuotaPeriod.ends_at.is_(None), QuotaPeriod.ends_at > at)).limit(1)):
        return "redraw_grant"
    return "unavailable"


def entitlement_version(db, user, kind, at=None):
    return digest({"policy": "membership-pages-v1", "kind": kind,
                   "membership": [user.membership_id, [t.id for t in active_terms(db, user.id, at)]] if kind in (MONTHLY, UNLIMITED) else None})


def _period_query(user, mode, at):
    from .billing_models import BillingTerm
    return select(QuotaPeriod).where(QuotaPeriod.owner_id == user.id, QuotaPeriod.source != 'purchase',
        QuotaPeriod.mode == mode, or_(QuotaPeriod.source == "grant",
            (QuotaPeriod.source == 'subscription') & QuotaPeriod.billing_term_id.in_(
                select(BillingTerm.id).where(BillingTerm.revoked_at.is_(None)))), QuotaPeriod.starts_at <= at,
        QuotaPeriod.revoked_at.is_(None), or_(QuotaPeriod.ends_at.is_(None), QuotaPeriod.ends_at > at))


def _automatic_period(db, user, kind, at):
    spec = period_spec(user, kind, at, db=db)
    # Virtual automatic periods allow side-effect-free reads before first use.
    return (db.get(QuotaPeriod, spec['id']) or QuotaPeriod(**spec, used=0, reserved=0)) if spec else None


def available_periods(db, user, mode, kind, at):
    """Non-purchase bucket detail; never used to choose an admission."""
    periods = list(db.scalars(_period_query(user, mode, at)))
    automatic = _automatic_period(db, user, kind, at)
    if automatic:
        periods.append(automatic)
    return sorted(periods, key=lambda row: (row.ends_at or datetime.max, row.starts_at, row.id))


def _first_period(db, user, mode, kind, at):
    stored = db.scalar(_period_query(user, mode, at).where(
        QuotaPeriod.granted > QuotaPeriod.used + QuotaPeriod.reserved)
        .order_by(QuotaPeriod.ends_at.asc().nulls_last(), QuotaPeriod.starts_at, QuotaPeriod.id).limit(1))
    automatic = _automatic_period(db, user, kind, at)
    candidates = [period for period in (stored, automatic) if period is not None
                  and period.granted > period.used + period.reserved]
    return min(candidates, key=lambda row: (row.ends_at or datetime.max, row.starts_at, row.id), default=None)


@dataclass(frozen=True)
class AdmissionPolicy:
    """One locked selection binds the model service and the page being charged."""
    plan: str
    service_plan: str
    kind: str
    hourly_image_limit: int | None
    period: QuotaPeriod | None = None

    @property
    def priority(self):
        return int(self.service_plan not in ('free', 'guest'))


def admission_policy(db, user, mode='classic', at=None, *, benefits=None):
    """Read-only until reserve; callers resolve UUID/cache reuse before enforcing it."""
    at = at or now()
    if user.kind == 'guest':
        return AdmissionPolicy('guest', 'guest', 'guest_trial', None)
    benefits = benefits if benefits is not None else membership_benefits(db, user, at)
    kind = quota_kind(user, mode, at, db, benefits=benefits)
    # An active subscription wins. Purchased service belongs only to its own
    # classic pages, never to free daily pages or an independent redraw gift.
    if mode == 'classic' and not benefits['paid']:
        purchase = first_purchase(db, user.id, at)
        if purchase:
            period, revision = purchase
            return AdmissionPolicy(benefits['plan'], revision.service_plan_id,
                                   PURCHASE, revision.hourly_image_limit, period)
    period = None if kind in (UNLIMITED, 'unavailable') else _first_period(db, user, mode, kind, at)
    return AdmissionPolicy(benefits['plan'], benefits['plan'], kind, benefits['hourly_image_limit'], period)


def _purchase_totals(db, user, at):
    values = db.execute(select(*(func.coalesce(func.sum(getattr(QuotaPeriod, field)), 0)
        for field in ('granted', 'used', 'reserved')), func.min(QuotaPeriod.starts_at),
        func.min(case((QuotaPeriod.granted > QuotaPeriod.used + QuotaPeriod.reserved, QuotaPeriod.ends_at))))
        .where(QuotaPeriod.owner_id == user.id, QuotaPeriod.source == 'purchase',
            QuotaPeriod.revoked_at.is_(None), QuotaPeriod.starts_at <= at,
            or_(QuotaPeriod.ends_at.is_(None), QuotaPeriod.ends_at > at))).one()
    return dict(zip(('granted', 'used', 'reserved', 'starts_at', 'next_expiry_at'), values))


def purchase_quota_json(totals):
    return {field: totals[field] for field in ('granted', 'used', 'reserved')} | {
        'available': totals['granted'] - totals['used'] - totals['reserved'],
        'next_expiry_at': iso(totals['next_expiry_at'])}


def period_json(period):
    return {"id": period.id, "kind": period.kind, "source": period.source,
            "mode": period.mode, "granted": period.granted, "used": period.used, "reserved": period.reserved,
            "available": period.granted - period.used - period.reserved,
            "starts_at": iso(period.starts_at), "expires_at": iso(period.ends_at),
            "grants_access": bool(period.grants_access), "note": period.note or ""}


def allowance_json(db, user, kind, at=None, *, purchase_totals=None):
    at = at or now()
    if kind in (UNLIMITED, "unavailable"):
        return None
    mode = "classic" if kind in (DAILY, PURCHASE) else "redraw"
    base_kind = DAILY if kind == PURCHASE else kind
    periods = available_periods(db, user, mode, base_kind, at)
    spec = period_spec(user, base_kind, at, db=db)
    if not periods:
        return None
    totals = {field: sum(getattr(row, field) for row in periods) for field in ("granted", "used", "reserved")}
    purchases = (purchase_totals if purchase_totals is not None else _purchase_totals(db, user, at)) if mode == 'classic' else None
    if purchases:
        for field in totals:
            totals[field] += purchases[field]
    starts = [row.starts_at for row in periods] + ([purchases['starts_at']] if purchases and purchases['starts_at'] else [])
    expiries = [row.ends_at for row in periods if row.ends_at] + ([purchases['next_expiry_at']]
        if purchases and purchases['next_expiry_at'] else [])
    return {"id": spec["id"] if spec else digest([row.id for row in periods]), "kind": kind, **totals,
            "available": totals["granted"] - totals["used"] - totals["reserved"],
            "starts_at": iso(min(starts)),
            "resets_at": iso(spec["ends_at"]) if spec else
                (iso(min(row.ends_at for row in periods if row.source in ('membership', 'subscription')))
                 if any(row.source in ('membership', 'subscription') for row in periods) else None),
            "next_expiry_at": iso(min(expiries)) if expiries else None,
            "buckets": [period_json(row) for row in periods]}


def entitlements_json(db, user, at=None):
    at = at or now()
    benefits = membership_benefits(db, user, at)
    policy = admission_policy(db, user, at=at, benefits=benefits)
    purchases = _purchase_totals(db, user, at)
    from .translation_limits import image_limit
    modes = {}
    for mode in ("classic", "redraw"):
        kind = policy.kind if mode == 'classic' else quota_kind(user, mode, at, db, benefits=benefits)
        modes[mode] = {"allowed": kind != "unavailable", "unlimited": kind == UNLIMITED,
                       "quota_kind": kind, "consent_version": entitlement_version(db, user, kind, at),
                       "quota": allowance_json(db, user, kind, at, purchase_totals=purchases)}
    starts_at, expires_at = plus_dates(db, user, at)
    return {"plan": benefits['plan'], "service_plan": policy.service_plan,
            "purchase_quota": purchase_quota_json(purchases), "plus_started_at": iso(starts_at),
            "plus_expires_at": iso(expires_at), "gift": gift_json(user, at), "timezone": settings().quota_timezone,
            "image_rate_limit": {"window_seconds": 60, "limit": image_limit(db, user, policy=policy)},
            "hourly_image_rate_limit": ({"window_seconds": 3600, "limit": policy.hourly_image_limit}
                if policy.hourly_image_limit is not None else None),
            "modes": modes, "generated_at": iso(at),
            "pending_previous_period_pages": db.scalar(select(func.coalesce(func.sum(QuotaPeriod.reserved), 0))
                .where(QuotaPeriod.owner_id == user.id, QuotaPeriod.ends_at <= at))}


def require_entitlement(user, mode, *, db, policy):
    if user.kind == 'guest':
        if mode != 'classic' or db is None or not db.info.get('guest_network'):
            problem('GUEST_FORBIDDEN', '匿名体验仅支持已验证的常规图片翻译', 403)
        return 'guest_trial'
    kind = policy.kind
    if kind == "unavailable":
        problem("PLUS_REQUIRED", "AI 重绘需要包含重绘权益的有效会员或有效赠送额度；已有译图仍可查看", 403)
    return kind


def reserve(db, user, job, at=None, *, policy=None):
    """The caller holds the user lock and has resolved cache/in-flight reuse."""
    at = at or now()
    if user.kind == 'guest':
        from .guests import reserve_guest
        reserve_guest(db, user, job, at)
        return
    policy = policy or admission_policy(db, user, job.mode, at)
    kind = require_entitlement(user, job.mode, db=db, policy=policy)
    job.quota_kind = kind
    job.entitlement = {"plan": policy.plan, "service_plan": policy.service_plan,
                       "priority": policy.priority, "accepted_at": iso(at),
                       "hourly_image_limit": policy.hourly_image_limit,
                       "membership_id": user.membership_id,
                       "billing_term_ids": [term.id for term in active_terms(db, user.id, at)],
                       "version": entitlement_version(db, user, kind, at)}
    if kind == UNLIMITED:
        job.quota_pages, job.settlement = 0, "included"
        return
    period = policy.period
    if period is None:
        spec = period_spec(user, kind, at, db=db)
        problem("DAILY_QUOTA_EXHAUSTED" if job.mode == "classic" else "REDRAW_QUOTA_EXHAUSTED",
                "可用常规翻译页数已用完" if job.mode == "classic" else "可用 AI 重绘页数已用完", 403,
                resets_at=iso(spec["ends_at"]) if spec else None)
    if period not in db:
        db.add(period)
        db.flush()
    updated = db.execute(update(QuotaPeriod).where(QuotaPeriod.id == period.id,
        QuotaPeriod.revoked_at.is_(None), QuotaPeriod.starts_at <= at,
        or_(QuotaPeriod.ends_at.is_(None), QuotaPeriod.ends_at > at),
        QuotaPeriod.granted - QuotaPeriod.used - QuotaPeriod.reserved >= 1)
        .values(reserved=QuotaPeriod.reserved + 1))
    if updated.rowcount != 1:
        problem("QUOTA_CONFLICT", "额度正在变化，请刷新后重试", 409)
    job.quota_period_id, job.quota_pages, job.settlement, job.quota_kind = period.id, 1, "reserved", period.kind
    db.add(Ledger(owner_id=user.id, job_id=job.id, period_id=period.id, quota_kind=period.kind,
                  transaction_key=f"{job.id}:reserve", kind="reserve", amount=1))


def settle(db, job, *, success):
    """Caller holds the Job lock. Late results never debit a released period."""
    if job.input_pinned and job.status not in {"queued", "running", "awaiting_upload", "validating_upload", "outcome_unknown"}:
        db.execute(update(Asset).where(Asset.id == job.input_asset_id, Asset.active_references > 0)
                   .values(active_references=Asset.active_references - 1))
        job.input_pinned = False
    from .scheduler import touch_job
    touch_job(db, job)
    if job.status not in {"queued", "running", "awaiting_upload", "validating_upload", "outcome_unknown"}:
        from .assets import schedule_input_cleanup
        schedule_input_cleanup(db, job)
    if job.settlement != "reserved":
        return
    changes = {"reserved": QuotaPeriod.reserved - job.quota_pages}
    if success:
        changes["used"] = QuotaPeriod.used + job.quota_pages
    db.execute(update(QuotaPeriod).where(QuotaPeriod.id == job.quota_period_id).values(**changes))
    operation = "settle" if success else "release"
    db.add(Ledger(owner_id=job.owner_id, job_id=job.id, period_id=job.quota_period_id,
                  quota_kind=job.quota_kind, transaction_key=f"{job.id}:{operation}", kind=operation,
                  amount=job.quota_pages))
    job.settlement = "settled" if success else "released"


def change_membership(db, owner_id, operator_id, key, *, action, months=None, days=None, monthly_pages=None, note):
    note = note.strip()
    if not note:
        problem("INVALID_NOTE", "请填写操作原因", 422)
    if months is not None and days is not None:
        problem("INVALID_MEMBERSHIP_DURATION", "会员天数与月数只能指定一种", 422)
    if months is None and days is None:
        months = 1
    transaction_key = f"membership:{operator_id}:{key}"
    lock_operation(db, transaction_key)
    user = locked_user(db, owner_id)
    if user and user.kind != 'registered':
        problem('GUEST_FORBIDDEN', '游客不能获得会员权益', 403)
    if user is None:
        problem("NOT_FOUND", "用户不存在", 404)
    request_hash = digest([owner_id, action, months, monthly_pages, note] + ([days] if days is not None else []))
    previous = db.scalar(select(MembershipOperation).where(MembershipOperation.transaction_key == transaction_key))
    if previous:
        if previous.request_hash != request_hash:
            problem("IDEMPOTENCY_CONFLICT", "此会员操作编号已用于其他参数", 409)
        return previous.result
    at = now()
    before = {"membership_id": user.membership_id, "starts_at": iso(user.plus_started_at),
              "expires_at": iso(user.plus_expires_at), "monthly_pages": user.plus_monthly_pages,
              "pending": user.plus_pending}
    if action == "expire":
        if user.plus_pending or (user.plus_started_at and at < user.plus_started_at):
            periods = _gift_periods(db, user)
            ids = [period.id for period in periods]
            # Only discard an entirely unused, unreferenced segment that never started.
            if (ids and not any(period.used or period.reserved for period in periods)
                    and not db.scalar(select(Ledger.id).where(Ledger.period_id.in_(ids)).limit(1))
                    and not db.scalar(select(Job.id).where(Job.quota_period_id.in_(ids)).limit(1))):
                for period in periods:
                    db.delete(period)
        if is_operator_plus(user, at):
            spec = period_spec(user, MONTHLY, at, db=db)
            if db.get(QuotaPeriod, spec["id"]) is None:
                db.add(QuotaPeriod(**spec))
        if user.plus_expires_at:
            user.plus_expires_at = min(user.plus_expires_at, at)
        user.plus_pending = False
    else:
        duration = timedelta(days=days if days is not None else months * 30)
        if (user.plus_started_at and user.plus_expires_at
                and user.plus_expires_at > user.plus_started_at
                and (user.plus_pending or user.plus_expires_at > at)):
            if monthly_pages is not None and monthly_pages != user.plus_monthly_pages:
                problem("MEMBERSHIP_TERMS_CHANGED", "续期保留本会员段的月额度；额外页数请使用周期补偿", 409)
            user.plus_expires_at += duration
        else:
            # Revoking and re-enabling an already started gift must not grant again.
            last = db.scalar(select(QuotaPeriod).where(QuotaPeriod.owner_id == user.id, QuotaPeriod.kind == MONTHLY,
                             QuotaPeriod.source == 'membership',
                             QuotaPeriod.ends_at > at).order_by(QuotaPeriod.starts_at.desc()))
            if last is not None:
                problem("MEMBERSHIP_PERIOD_ACTIVE", "已有尚未结束的重绘额度周期，请在周期结束后重新开通", 409)
            from .billing_renewal import paid_through
            user.membership_id, user.plus_started_at = uid(), paid_through(db, user, at)
            user.plus_timezone = None
            user.plus_monthly_pages = monthly_pages if monthly_pages is not None else get_request_limits(db).plus_monthly_redraw_pages
            user.plus_expires_at = user.plus_started_at + duration
            user.plus_pending = True
        _sync_gift_periods(db, user)
    from .billing_renewal import schedule_gift
    schedule_gift(db, user, at)
    db.flush()
    result = {"user_id": user.id, "entitlements": entitlements_json(db, user, at)}
    db.add(MembershipOperation(transaction_key=transaction_key, owner_id=user.id, operator_id=operator_id,
                               request_hash=request_hash, result=result,
                               details={"action": action, "months": months, "days": days, "monthly_pages": monthly_pages, "note": note}))
    record_audit(db, operator_id, f"membership.{action}", "user", user.id, before=before,
                 after={"membership_id": user.membership_id, "starts_at": iso(user.plus_started_at),
                        "expires_at": iso(user.plus_expires_at), "monthly_pages": user.plus_monthly_pages,
                        "pending": user.plus_pending},
                 note=note, operation_key=transaction_key)
    db.commit()
    return result


def compensate(db, owner_id, operator_id, key, *, kind, pages, note):
    note = note.strip()
    if not note:
        problem("INVALID_NOTE", "请填写补偿原因", 422)
    transaction_key = f"compensate:{operator_id}:{key}"
    lock_operation(db, transaction_key)
    user = locked_user(db, owner_id)
    if user and user.kind != 'registered':
        problem('GUEST_FORBIDDEN', '游客不能获得账户额度', 403)
    if user is None:
        problem("NOT_FOUND", "用户不存在", 404)
    request_hash = digest([owner_id, kind, pages, note])
    previous = db.scalar(select(MembershipOperation).where(MembershipOperation.transaction_key == transaction_key))
    if previous:
        if previous.request_hash != request_hash:
            problem("IDEMPOTENCY_CONFLICT", "此补偿编号已用于其他参数", 409)
        return previous.result
    spec = period_spec(user, kind, db=db)
    period = db.get(QuotaPeriod, spec['id']) if spec else None
    if spec is None and kind == MONTHLY and is_plus(db, user):
        from .billing_models import BillingTerm
        period = db.scalar(select(QuotaPeriod).where(QuotaPeriod.owner_id == owner_id,
            QuotaPeriod.source == 'subscription', QuotaPeriod.billing_term_id.in_(
                select(BillingTerm.id).where(BillingTerm.revoked_at.is_(None))), QuotaPeriod.starts_at <= now(),
            QuotaPeriod.ends_at > now()).order_by(QuotaPeriod.ends_at).limit(1))
    if spec is None and period is None:
        problem("PLUS_REQUIRED", "补偿重绘额度需要有效 PLUS 会员", 403)
    if period is None:
        period = QuotaPeriod(**spec)
        db.add(period)
        db.flush()
    before = period.granted
    db.execute(update(QuotaPeriod).where(QuotaPeriod.id == period.id).values(granted=QuotaPeriod.granted + pages))
    db.add(Ledger(owner_id=user.id, period_id=period.id, quota_kind=kind, transaction_key=transaction_key,
                  kind="compensation", amount=pages, note=note))
    db.flush()
    result = {"user_id": user.id, "entitlements": entitlements_json(db, user)}
    db.add(MembershipOperation(transaction_key=transaction_key, owner_id=user.id, operator_id=operator_id,
                               request_hash=request_hash, result=result,
                               details={"kind": kind, "pages": pages, "note": note, "period_id": period.id}))
    record_audit(db, operator_id, "quota.compensate", "quota_period", period.id,
                 before={"granted": before}, after={"granted": before + pages},
                 details={"owner_id": owner_id, "kind": kind, "pages": pages}, note=note, operation_key=transaction_key)
    db.commit()
    return result
