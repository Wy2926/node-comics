"""Account-locked admission and period-locked settlement; reads never grant quota."""
from calendar import monthrange
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import func, or_, select, text, update
from .config import settings
from .entitlement_models import MembershipOperation, QuotaPeriod
from .errors import problem
from .models import Asset, Job, Ledger, User, now, uid
from .providers import digest
from .billing_access import active_terms, access_dates
from .system_settings import get_request_limits
from .admin_audit import record_audit

DAILY = "classic_daily"
MONTHLY = "redraw_monthly"
UNLIMITED = "classic_unlimited"


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
    return bool(user.plus_started_at and user.plus_expires_at
                and user.plus_started_at <= at < user.plus_expires_at)


def is_plus(db, user, at=None):
    at = at or now()
    return is_operator_plus(user, at) or bool(active_terms(db, user.id, at))


def plus_dates(db, user, at=None):
    at = at or now()
    ranges = [(start, end) for start, end in ((user.plus_started_at, user.plus_expires_at),
              access_dates(db, user.id, at)) if start and end]
    active = [(start, end) for start, end in ranges if start <= at < end]
    values = active or ranges
    return (min(start for start, _ in values), max(end for _, end in values)) if values else (None, None)


def month_boundary(anchor, offset, timezone_name):
    local = anchor.replace(tzinfo=timezone.utc).astimezone(ZoneInfo(timezone_name))
    year, month = divmod(local.year * 12 + local.month - 1 + offset, 12)
    value = local.replace(year=year, month=month + 1, day=min(local.day, monthrange(year, month + 1)[1]))
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def period_spec(user, kind, at=None, *, db):
    at = at or now()
    if kind == DAILY:
        zone = ZoneInfo(settings().quota_timezone)
        day = at.replace(tzinfo=timezone.utc).astimezone(zone).date()
        start = datetime.combine(day, time.min, zone).astimezone(timezone.utc).replace(tzinfo=None)
        end = datetime.combine(day + timedelta(days=1), time.min, zone).astimezone(timezone.utc).replace(tzinfo=None)
        granted = get_request_limits(db).free_daily_pages
    elif kind == MONTHLY and is_operator_plus(user, at):
        anchor = user.plus_started_at
        zone = ZoneInfo(user.plus_timezone)
        local = at.replace(tzinfo=timezone.utc).astimezone(zone)
        original = anchor.replace(tzinfo=timezone.utc).astimezone(zone)
        offset = (local.year - original.year) * 12 + local.month - original.month
        if month_boundary(anchor, offset, user.plus_timezone) > at:
            offset -= 1
        start = month_boundary(anchor, offset, user.plus_timezone)
        end = min(month_boundary(anchor, offset + 1, user.plus_timezone), user.plus_expires_at)
        granted = user.plus_monthly_pages
    else:
        return None
    return {"id": digest([user.id, kind, iso(start)]), "owner_id": user.id, "kind": kind,
            "mode": "classic" if kind == DAILY else "redraw", "source": "daily" if kind == DAILY else "membership",
            "source_key": f"{kind}:{iso(start)}",
            "starts_at": start, "ends_at": end, "granted": granted}


def quota_kind(user, mode, at=None, db=None):
    plus = is_plus(db, user, at)
    if mode == "classic":
        return UNLIMITED if plus else DAILY
    if plus:
        return MONTHLY
    at = at or now()
    if db is not None and db.scalar(select(QuotaPeriod.id).where(QuotaPeriod.owner_id == user.id,
            QuotaPeriod.mode == mode, QuotaPeriod.source == "grant", QuotaPeriod.grants_access.is_(True),
            QuotaPeriod.starts_at <= at, QuotaPeriod.ends_at > at).limit(1)):
        return "redraw_grant"
    return "unavailable"


def entitlement_version(db, user, kind, at=None):
    return digest({"policy": "membership-pages-v1", "kind": kind,
                   "membership": [user.membership_id, [t.id for t in active_terms(db, user.id, at)]] if kind in (MONTHLY, UNLIMITED) else None})


def available_periods(db, user, mode, kind, at):
    from .billing_models import BillingTerm
    periods = list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.owner_id == user.id,
        QuotaPeriod.mode == mode, or_(QuotaPeriod.source == "grant",
            (QuotaPeriod.source == 'subscription') & QuotaPeriod.billing_term_id.in_(
                select(BillingTerm.id).where(BillingTerm.revoked_at.is_(None)))), QuotaPeriod.starts_at <= at,
        QuotaPeriod.ends_at > at)))
    spec = period_spec(user, kind, at, db=db)
    if spec:
        # Virtual automatic periods allow side-effect-free reads before first use.
        periods.append(db.get(QuotaPeriod, spec["id"]) or QuotaPeriod(**spec, used=0, reserved=0))
    return sorted(periods, key=lambda row: (row.ends_at, row.starts_at, row.id))


def period_json(period):
    return {"id": period.id, "kind": period.kind, "source": period.source,
            "mode": period.mode, "granted": period.granted, "used": period.used, "reserved": period.reserved,
            "available": period.granted - period.used - period.reserved,
            "starts_at": iso(period.starts_at), "expires_at": iso(period.ends_at),
            "grants_access": bool(period.grants_access), "note": period.note or ""}


def allowance_json(db, user, kind, at=None):
    at = at or now()
    if kind in (UNLIMITED, "unavailable"):
        return None
    mode = "classic" if kind == DAILY else "redraw"
    periods = available_periods(db, user, mode, kind, at)
    spec = period_spec(user, kind, at, db=db)
    if not periods:
        return None
    totals = {field: sum(getattr(row, field) for row in periods) for field in ("granted", "used", "reserved")}
    return {"id": spec["id"] if spec else digest([row.id for row in periods]), "kind": kind, **totals,
            "available": totals["granted"] - totals["used"] - totals["reserved"],
            "starts_at": iso(min(row.starts_at for row in periods)),
            "resets_at": iso(spec["ends_at"]) if spec else
                (iso(min(row.ends_at for row in periods if row.source in ('membership', 'subscription')))
                 if any(row.source in ('membership', 'subscription') for row in periods) else None),
            "next_expiry_at": iso(periods[0].ends_at), "buckets": [period_json(row) for row in periods]}


def entitlements_json(db, user, at=None):
    at = at or now()
    plus = is_plus(db, user, at)
    from .plan_limits import image_limit
    modes = {}
    for mode in ("classic", "redraw"):
        kind = quota_kind(user, mode, at, db)
        modes[mode] = {"allowed": kind != "unavailable", "unlimited": kind == UNLIMITED,
                       "quota_kind": kind, "consent_version": entitlement_version(db, user, kind, at),
                       "quota": allowance_json(db, user, kind, at)}
    starts_at, expires_at = plus_dates(db, user, at)
    return {"plan": "plus" if plus else "free", "plus_started_at": iso(starts_at),
            "plus_expires_at": iso(expires_at), "timezone": settings().quota_timezone,
            "image_rate_limit": {"window_seconds": 60, "limit": image_limit(db, user)},
            "scheduler_weight": get_request_limits(db).plus_scheduler_weight if plus else get_request_limits(db).free_scheduler_weight,
            "modes": modes, "generated_at": iso(at),
            "pending_previous_period_pages": db.scalar(select(func.coalesce(func.sum(QuotaPeriod.reserved), 0))
                .where(QuotaPeriod.owner_id == user.id, QuotaPeriod.ends_at <= at))}


def require_entitlement(user, mode, at=None, expected_kind=None, db=None):
    kind = quota_kind(user, mode, at, db)
    if kind == "unavailable":
        problem("PLUS_REQUIRED", "AI 重绘需要有效 PLUS 会员或限时重绘赠送额度；已有译图仍可查看", 403)
    if expected_kind is not None and expected_kind != kind:
        problem("ENTITLEMENT_CHANGED", "账户翻译权益已变化，请查看当前额度后重新确认", 409)
    return kind


def reserve(db, user, job, at=None):
    """The caller holds the user lock and has resolved cache/in-flight reuse."""
    at = at or now()
    kind = require_entitlement(user, job.mode, at, db=db)
    job.quota_kind = kind
    job.entitlement = {"plan": "plus" if is_plus(db, user, at) else "free", "accepted_at": iso(at),
                       "membership_id": user.membership_id,
                       "billing_term_ids": [term.id for term in active_terms(db, user.id, at)],
                       "version": entitlement_version(db, user, kind, at)}
    if kind == UNLIMITED:
        job.quota_pages, job.settlement = 0, "included"
        return
    periods = available_periods(db, user, job.mode, kind, at)
    period = next((row for row in periods if row.granted - row.used - row.reserved >= 1), None)
    if period is None:
        spec = period_spec(user, kind, at, db=db)
        problem("DAILY_QUOTA_EXHAUSTED" if job.mode == "classic" else "REDRAW_QUOTA_EXHAUSTED",
                "可用常规翻译页数已用完" if job.mode == "classic" else "可用 AI 重绘页数已用完", 409,
                resets_at=iso(spec["ends_at"]) if spec else None)
    if period not in db:
        db.add(period)
        db.flush()
    updated = db.execute(update(QuotaPeriod).where(QuotaPeriod.id == period.id,
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
    if not success:
        from .plan_limits import policy_snapshot
        db.flush()
        policy_snapshot(db, db.get(User, job.owner_id), released=True)


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
              "expires_at": iso(user.plus_expires_at), "monthly_pages": user.plus_monthly_pages}
    if action == "expire":
        if is_operator_plus(user, at):
            spec = period_spec(user, MONTHLY, at, db=db)
            if db.get(QuotaPeriod, spec["id"]) is None:
                db.add(QuotaPeriod(**spec))
        if user.plus_expires_at:
            user.plus_expires_at = min(user.plus_expires_at, at)
    else:
        if is_operator_plus(user, at):
            if monthly_pages is not None and monthly_pages != user.plus_monthly_pages:
                problem("MEMBERSHIP_TERMS_CHANGED", "续期保留本会员段的月额度；额外页数请使用周期补偿", 409)
            if days is not None:
                user.plus_expires_at += timedelta(days=days)
            else:
                offset = 1
                while month_boundary(user.plus_started_at, offset, user.plus_timezone) < user.plus_expires_at:
                    offset += 1
                user.plus_expires_at = month_boundary(user.plus_started_at, offset + months, user.plus_timezone)
            # A short gift can end mid-cycle. Extending it must reopen the same
            # bucket with its original used/reserved values, never mint another.
            spec = period_spec(user, MONTHLY, at, db=db)
            period = db.get(QuotaPeriod, spec["id"])
            if period is not None:
                period.ends_at = spec["ends_at"]
        else:
            # Revoking and re-enabling an unexpired paid month must not grant again.
            last = db.scalar(select(QuotaPeriod).where(QuotaPeriod.owner_id == user.id, QuotaPeriod.kind == MONTHLY,
                             QuotaPeriod.source == 'membership',
                             QuotaPeriod.ends_at > at).order_by(QuotaPeriod.starts_at.desc()))
            if last is not None:
                problem("MEMBERSHIP_PERIOD_ACTIVE", "已有尚未结束的重绘额度周期，请在周期结束后重新开通", 409)
            user.membership_id, user.plus_started_at = uid(), at
            user.plus_timezone = settings().quota_timezone
            user.plus_monthly_pages = monthly_pages if monthly_pages is not None else get_request_limits(db).plus_monthly_redraw_pages
            user.plus_expires_at = at + timedelta(days=days) if days is not None else month_boundary(at, months, user.plus_timezone)
            # Persist the initial period even when no translation is submitted.
            spec = period_spec(user, MONTHLY, at, db=db)
            db.add(QuotaPeriod(**spec))
    db.flush()
    result = {"user_id": user.id, "entitlements": entitlements_json(db, user, at)}
    db.add(MembershipOperation(transaction_key=transaction_key, owner_id=user.id, operator_id=operator_id,
                               request_hash=request_hash, result=result,
                               details={"action": action, "months": months, "days": days, "monthly_pages": monthly_pages, "note": note}))
    record_audit(db, operator_id, f"membership.{action}", "user", user.id, before=before,
                 after={"membership_id": user.membership_id, "starts_at": iso(user.plus_started_at),
                        "expires_at": iso(user.plus_expires_at), "monthly_pages": user.plus_monthly_pages},
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
