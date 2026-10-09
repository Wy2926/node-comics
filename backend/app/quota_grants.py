"""Operator-issued page grants, optionally time-bounded."""
from datetime import timezone
from typing import Annotated, Literal
from fastapi import APIRouter, Depends, Header, Query
from pydantic import AwareDatetime, Field, model_validator
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session
from .auth import admin, identity
from .db import get_db
from .entitlement_models import MembershipOperation, QuotaPeriod
from .entitlements import entitlements_json, iso, lock_operation, locked_user, period_json
from .errors import problem
from .jobs import idem_key
from .models import Ledger, User, now
from .providers import digest
from .request_models import RequestBody
from .admin_audit import record_audit
from .schemas import QuotaPurchasesResponse

router = APIRouter(tags=["quota grants"])


class GrantRequest(RequestBody):
    mode: Literal["classic", "redraw"]
    pages: int = Field(ge=1, le=1_000_000, strict=True)
    starts_at: AwareDatetime | None = None
    expires_at: AwareDatetime | None = None
    note: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def valid_window(self):
        self.note = self.note.strip()
        if not self.note:
            raise ValueError("请填写赠送原因")
        if self.starts_at and self.expires_at and self.expires_at <= self.starts_at:
            raise ValueError("Expiration must follow the start")
        return self


def grant_pages(db, owner_id, operator_id, key, request):
    """One durable receipt per grant, including replays after it has expired."""
    transaction_key = f"grant:{operator_id}:{key}"
    lock_operation(db, transaction_key)
    user = locked_user(db, owner_id)
    if user and user.kind != 'registered':
        problem('GUEST_FORBIDDEN', '游客不能获得账户赠送', 403)
    if user is None:
        problem("NOT_FOUND", "用户不存在", 404)
    parameters = {"owner_id": owner_id, **request.model_dump(mode="json")}
    request_hash = digest(parameters)
    previous = db.scalar(select(MembershipOperation).where(MembershipOperation.transaction_key == transaction_key))
    if previous:
        if previous.request_hash != request_hash:
            problem("IDEMPOTENCY_CONFLICT", "此发放编号已用于其他额度或期限", 409)
        return previous.result
    at = now()
    start = request.starts_at.astimezone(timezone.utc).replace(tzinfo=None) if request.starts_at else at
    end = request.expires_at.astimezone(timezone.utc).replace(tzinfo=None) if request.expires_at else None
    if end and end <= max(at, start):
        problem("INVALID_GRANT_WINDOW", "赠送额度的到期时间必须晚于现在和生效时间", 422)
    period = QuotaPeriod(id=digest(transaction_key), owner_id=user.id, kind=f"{request.mode}_grant",
        mode=request.mode, source="grant", source_key=transaction_key, starts_at=start, ends_at=end,
        granted=request.pages, used=0, reserved=0, note=request.note, grants_access=request.mode == "redraw")
    db.add(period)
    db.flush()
    db.add(Ledger(owner_id=user.id, period_id=period.id, quota_kind=period.kind,
                  kind="grant", amount=request.pages, transaction_key=transaction_key, note=request.note))
    result = {"grant": period_json(period), "entitlements": entitlements_json(db, user, at)}
    db.add(MembershipOperation(transaction_key=transaction_key, owner_id=user.id, operator_id=operator_id,
        request_hash=request_hash, details=parameters, result=result))
    record_audit(db, operator_id, "quota.grant", "quota_period", period.id,
                 after=period_json(period), details={"owner_id": user.id}, note=request.note,
                 operation_key=transaction_key)
    db.commit()
    return result


@router.post('/v1/admin/users/{user_id}/quota-grants', status_code=201)
def issue_grant(user_id: str, body: GrantRequest, idempotency_key: Annotated[str | None, Header()] = None,
                operator: User = Depends(admin), db: Session = Depends(get_db)):
    return grant_pages(db, user_id, operator.id, idem_key(idempotency_key), body)


@router.get('/v1/me/quota-grants')
def my_grants(user: User = Depends(identity), db: Session = Depends(get_db)):
    return {"items": [period_json(row) for row in db.scalars(select(QuotaPeriod).where(
        QuotaPeriod.owner_id == user.id, QuotaPeriod.source == "grant",
        or_(QuotaPeriod.ends_at.is_(None), QuotaPeriod.ends_at > now()))
        .order_by(QuotaPeriod.ends_at.asc().nulls_last(), QuotaPeriod.id))]}


@router.get('/v1/me/quota-purchases', response_model=QuotaPurchasesResponse)
def my_purchases(cursor: str | None = Query(None, min_length=1, max_length=64),
                 limit: int = Query(20, ge=1, le=50),
                 user: User = Depends(identity), db: Session = Depends(get_db)):
    """Private keyset history, including expired/depleted/revoked purchases.

    The cursor is a previously returned bucket ID scoped to this account. No
    total/offset query or unbounded bucket array is needed in entitlements.
    """
    from .billing_models import BillingOrder, BillingPlanRevision, BillingPrice
    query = select(QuotaPeriod, BillingPlanRevision).join(BillingOrder,
        BillingOrder.id == QuotaPeriod.billing_order_id).join(BillingPrice,
        BillingPrice.id == BillingOrder.price_id).join(BillingPlanRevision,
        BillingPlanRevision.id == BillingPrice.plan_revision_id).where(
            QuotaPeriod.owner_id == user.id, BillingOrder.owner_id == user.id, QuotaPeriod.source == 'purchase')
    if cursor:
        anchor = db.execute(select(QuotaPeriod.starts_at, QuotaPeriod.id).where(
            QuotaPeriod.id == cursor, QuotaPeriod.owner_id == user.id, QuotaPeriod.source == 'purchase')).first()
        if anchor is None:
            problem('INVALID_CURSOR', '额度记录游标无效', 422)
        query = query.where(or_(QuotaPeriod.starts_at < anchor.starts_at,
            and_(QuotaPeriod.starts_at == anchor.starts_at, QuotaPeriod.id < anchor.id)))
    rows = db.execute(query.order_by(QuotaPeriod.starts_at.desc(), QuotaPeriod.id.desc()).limit(limit + 1)).all()
    at, items = now(), []
    for period, revision in rows[:limit]:
        state = ('revoked' if period.revoked_at else 'scheduled' if period.starts_at > at else
                 'expired' if period.ends_at and period.ends_at <= at else
                 'exhausted' if period.granted <= period.used + period.reserved else 'active')
        items.append({**period_json(period), 'order_id': period.billing_order_id,
            'service_plan': revision.service_plan_id, 'product_name': revision.name,
            'available': period.granted - period.used - period.reserved if state == 'active' else 0,
            'hourly_image_limit': revision.hourly_image_limit, 'revoked_at': iso(period.revoked_at), 'state': state})
    return {'items': items, 'next_cursor': rows[limit - 1][0].id if len(rows) > limit else None}
