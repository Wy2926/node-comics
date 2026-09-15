"""Operator-issued, time-bounded page grants; ready for future campaign callers."""
from datetime import timezone
from typing import Annotated, Literal
from fastapi import APIRouter, Depends, Header
from pydantic import AwareDatetime, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session
from .auth import admin, identity
from .db import get_db
from .entitlement_models import MembershipOperation, QuotaPeriod
from .entitlements import entitlements_json, lock_operation, locked_user, period_json
from .errors import problem
from .jobs import idem_key
from .models import Ledger, User, now
from .providers import digest
from .request_models import RequestBody

router = APIRouter(tags=["quota grants"])


class GrantRequest(RequestBody):
    mode: Literal["classic", "redraw"]
    pages: int = Field(ge=1, le=1_000_000, strict=True)
    starts_at: AwareDatetime | None = None
    expires_at: AwareDatetime
    note: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def valid_window(self):
        if self.starts_at and self.expires_at <= self.starts_at:
            raise ValueError("Expiration must follow the start")
        return self


def grant_pages(db, owner_id, operator_id, key, request):
    """One durable receipt per grant, including replays after it has expired."""
    transaction_key = f"grant:{operator_id}:{key}"
    lock_operation(db, transaction_key)
    user = locked_user(db, owner_id)
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
    end = request.expires_at.astimezone(timezone.utc).replace(tzinfo=None)
    if end <= max(at, start):
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
    db.commit()
    return result


@router.post('/v1/admin/users/{user_id}/quota-grants', status_code=201)
def issue_grant(user_id: str, body: GrantRequest, idempotency_key: Annotated[str | None, Header()] = None,
                operator: User = Depends(admin), db: Session = Depends(get_db)):
    return grant_pages(db, user_id, operator.id, idem_key(idempotency_key), body)


@router.get('/v1/me/quota-grants')
def my_grants(user: User = Depends(identity), db: Session = Depends(get_db)):
    return {"items": [period_json(row) for row in db.scalars(select(QuotaPeriod).where(
        QuotaPeriod.owner_id == user.id, QuotaPeriod.source == "grant", QuotaPeriod.ends_at > now())
        .order_by(QuotaPeriod.ends_at, QuotaPeriod.id))]}
