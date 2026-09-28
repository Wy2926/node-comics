"""Campaign configuration, atomic registration awards and resumable backfill.

No promotion is seeded by application startup or migrations. Award identity and
quantity stay fixed; audited duration changes never reset delivery receipts.
"""
from datetime import timedelta, timezone
from typing import Annotated, Literal
from fastapi import APIRouter, Depends, Path, Query
from pydantic import AwareDatetime, Field, model_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from .admin_audit import find_audit_operation, record_audit
from .auth import admin
from .db import get_db, session_factory
from .entitlement_models import QuotaPeriod
from .entitlements import iso, lock_operation, locked_user, period_json
from .errors import problem
from .models import Ledger, User, now
from .providers import digest
from .quota_campaign_models import QuotaCampaign, QuotaCampaignAward
from .request_models import RequestBody

router = APIRouter(prefix='/v1/admin/quota-campaigns', tags=['quota campaigns'])
CampaignId = Annotated[str, Path(min_length=1, max_length=64, pattern=r'^[a-z0-9][a-z0-9_-]*$')]


class CampaignRequest(RequestBody):
    name: str = Field(min_length=1, max_length=100)
    mode: Literal['classic', 'redraw']
    pages: int = Field(ge=1, le=1_000_000, strict=True)
    audience: Literal['all', 'existing', 'new'] = 'all'
    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None
    validity_days: int | None = Field(default=None, ge=1, le=36500, strict=True)

    @model_validator(mode='after')
    def validate_terms(self):
        self.name = self.name.strip()
        if not self.name:
            raise ValueError('Campaign name is required')
        if self.starts_at and self.ends_at and self.ends_at <= self.starts_at:
            raise ValueError('Campaign end must follow start')
        return self


class CampaignStatusRequest(RequestBody):
    enabled: bool = Field(strict=True)
    expected_version: int = Field(ge=1, strict=True)


class CampaignDurationRequest(RequestBody):
    ends_at: AwareDatetime | None
    validity_days: int | None = Field(ge=1, le=36500, strict=True)
    apply_to_existing: bool = Field(strict=True)
    expected_version: int = Field(ge=1, strict=True)
    note: str = Field(min_length=1, max_length=200)

    @model_validator(mode='after')
    def validate_note(self):
        self.note = self.note.strip()
        if not self.note:
            raise ValueError('请填写调整原因')
        return self


def utc(value):
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value else None


def campaign_json(row):
    return {'id': row.id, 'name': row.name, 'mode': row.mode, 'pages': row.pages,
            'audience': row.audience, 'starts_at': iso(row.starts_at), 'ends_at': iso(row.ends_at),
            'validity_days': row.validity_days, 'enabled': row.enabled, 'version': row.version,
            'created_at': iso(row.created_at), 'created_by': row.created_by}


def create_campaign(db, campaign_id, operator_id, request):
    lock_operation(db, 'campaign:' + campaign_id)
    fingerprint = digest(request.model_dump(mode='json'))
    previous = db.get(QuotaCampaign, campaign_id)
    if previous:
        if previous.request_hash != fingerprint:
            problem('IDEMPOTENCY_CONFLICT', '活动编号已用于其他规则；新的赠送请新建活动', 409)
        return previous
    at = now()
    start, end = utc(request.starts_at) or at, utc(request.ends_at)
    if end and end <= max(start, at):
        problem('INVALID_CAMPAIGN_WINDOW', '活动结束时间必须晚于现在和开始时间', 422)
    row = QuotaCampaign(id=campaign_id, name=request.name, mode=request.mode, pages=request.pages,
        audience=request.audience, starts_at=start, ends_at=end, validity_days=request.validity_days,
        enabled=False, version=1, request_hash=fingerprint, created_by=operator_id, created_at=at)
    db.add(row)
    db.flush()
    record_audit(db, operator_id, 'quota_campaign.create', 'quota_campaign', row.id,
                 after=campaign_json(row), note=row.name, operation_key=campaign_id)
    return row


def locked_campaign(db, campaign_id):
    lock_operation(db, 'campaign:' + campaign_id)
    row = db.scalar(select(QuotaCampaign).where(QuotaCampaign.id == campaign_id)
                    .with_for_update().execution_options(populate_existing=True))
    if row is None:
        problem('NOT_FOUND', '额度活动不存在', 404)
    return row


def set_campaign_status(db, campaign_id, operator_id, request):
    row = locked_campaign(db, campaign_id)
    previous = find_audit_operation(db, operator_id, 'quota_campaign.status', 'quota_campaign', row.id,
                                    str(request.expected_version + 1))
    if previous:
        if previous.after['enabled'] != request.enabled:
            problem('IDEMPOTENCY_CONFLICT', '此版本已用于其他活动操作', 409)
        return row  # Recover a real receipt even after subsequent administrator changes.
    if row.version != request.expected_version:
        problem('VERSION_CONFLICT', '活动状态已改变，请刷新后重试', 409)
    before = campaign_json(row)
    row.enabled, row.version = request.enabled, row.version + 1
    record_audit(db, operator_id, 'quota_campaign.status', 'quota_campaign', row.id,
                 before=before, after=campaign_json(row), note=row.name,
                 operation_key=str(row.version))
    return row


def change_campaign_duration(db, campaign_id, operator_id, request):
    row = locked_campaign(db, campaign_id)
    action = 'quota_campaign.duration'
    key = str(request.expected_version + 1)
    fingerprint = digest(request.model_dump(mode='json'))
    previous = find_audit_operation(db, operator_id, action, 'quota_campaign', row.id, key)
    if previous:
        if previous.details.get('request_hash') != fingerprint:
            problem('IDEMPOTENCY_CONFLICT', '此版本已用于其他期限调整', 409)
        return row
    if row.version != request.expected_version:
        problem('VERSION_CONFLICT', '活动规则已改变，请刷新后重试', 409)
    end = utc(request.ends_at)
    if end and end <= row.starts_at:
        problem('INVALID_CAMPAIGN_WINDOW', '活动结束时间必须晚于开始时间', 422)
    before, changed = campaign_json(row), 0
    if request.apply_to_existing:
        # Match delivery/admission lock order: campaign -> accounts -> periods.
        owners = select(User).join(QuotaCampaignAward, QuotaCampaignAward.owner_id == User.id).where(
            QuotaCampaignAward.campaign_id == row.id).order_by(User.id)
        list(db.scalars(owners.with_for_update(of=User, key_share=True)))
        periods = db.scalars(select(QuotaPeriod).join(QuotaCampaignAward,
            QuotaCampaignAward.period_id == QuotaPeriod.id).where(QuotaCampaignAward.campaign_id == row.id)
            .order_by(QuotaPeriod.id).with_for_update(of=QuotaPeriod))
        for period in periods:
            expires = period.starts_at + timedelta(days=request.validity_days) if request.validity_days else None
            if period.ends_at == expires:
                continue
            period_before = period_json(period)
            period.ends_at = expires
            record_audit(db, operator_id, 'quota.correct_expiry', 'quota_period', period.id,
                before=period_before, after=period_json(period), note=request.note,
                details={'campaign_id': row.id, 'owner_id': period.owner_id}, operation_key=f'{row.id}:{key}')
            changed += 1
    row.ends_at, row.validity_days, row.version = end, request.validity_days, row.version + 1
    record_audit(db, operator_id, action, 'quota_campaign', row.id,
        before=before, after=campaign_json(row), note=request.note, operation_key=key,
        details={'request_hash': fingerprint, 'apply_to_existing': request.apply_to_existing, 'updated_awards': changed})
    return row


def active_campaigns(at):
    return (QuotaCampaign.enabled.is_(True), QuotaCampaign.starts_at <= at,
            or_(QuotaCampaign.ends_at.is_(None), QuotaCampaign.ends_at > at))


def audience_filter():
    return or_(QuotaCampaign.audience == 'all',
        (QuotaCampaign.audience == 'existing') & (User.created_at < QuotaCampaign.created_at),
        (QuotaCampaign.audience == 'new') & (User.created_at >= QuotaCampaign.created_at))


def missing_award():
    return ~select(QuotaCampaignAward.owner_id).where(
        QuotaCampaignAward.campaign_id == QuotaCampaign.id,
        QuotaCampaignAward.owner_id == User.id).correlate(QuotaCampaign, User).exists()


def award_campaigns(db, user, at=None):
    """Caller commits user, receipt, quota and ledger together; no nested commit.

    Shared campaign locks serialize pause against delivery. The account lock then
    serializes registration/backfill retries and quota admission for that owner.
    """
    at = at or now()
    campaigns = list(db.scalars(select(QuotaCampaign).join(User, User.id == user.id)
        .where(*active_campaigns(at), audience_filter(), missing_award())
        .order_by(QuotaCampaign.id).with_for_update(read=True, of=QuotaCampaign)))
    if not campaigns:
        return 0
    user = locked_user(db, user.id)
    awarded = 0
    for campaign in campaigns:
        if db.get(QuotaCampaignAward, (campaign.id, user.id)):
            continue
        key = f'campaign:{campaign.id}:{user.id}'
        period = QuotaPeriod(id=digest(key), owner_id=user.id, kind=campaign.mode + '_grant',
            mode=campaign.mode, source='grant', source_key=key, note=campaign.name,
            grants_access=campaign.mode == 'redraw', starts_at=at,
            ends_at=at + timedelta(days=campaign.validity_days) if campaign.validity_days else None,
            granted=campaign.pages, used=0, reserved=0)
        db.add(period)
        db.flush()
        db.add(QuotaCampaignAward(campaign_id=campaign.id, owner_id=user.id,
                                 period_id=period.id, created_at=at))
        db.add(Ledger(owner_id=user.id, period_id=period.id, quota_kind=period.kind,
                      kind='grant', amount=period.granted, transaction_key=key, note=campaign.name))
        awarded += 1
    db.flush()
    return awarded


def backfill_campaigns(limit=100):
    """Bounded, crash-resumable scan, each account in its own transaction.

    No offset/cursor can skip late commits. Receipts also preserve dedupe after
    expiry, consumption, pauses and process restarts.
    """
    with session_factory()() as db:
        owners = list(db.scalars(select(User.id).join(QuotaCampaign, audience_filter())
            .where(*active_campaigns(now()), missing_award()).distinct().order_by(User.id).limit(limit)))
    awarded = 0
    for owner_id in owners:
        with session_factory()() as db:
            user = db.get(User, owner_id)
            if user:
                awarded += award_campaigns(db, user)
                db.commit()
    return awarded


@router.put('/{campaign_id}')
def put_campaign(campaign_id: CampaignId, body: CampaignRequest,
                 operator: User = Depends(admin), db: Session = Depends(get_db)):
    row = create_campaign(db, campaign_id, operator.id, body)
    db.commit()
    return campaign_json(row)


@router.patch('/{campaign_id}')
def patch_campaign(campaign_id: CampaignId, body: CampaignStatusRequest,
                   operator: User = Depends(admin), db: Session = Depends(get_db)):
    row = set_campaign_status(db, campaign_id, operator.id, body)
    db.commit()
    return campaign_json(row)


@router.get('')
def list_campaigns(offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
                   operator: User = Depends(admin), db: Session = Depends(get_db)):
    count = select(func.count()).select_from(QuotaCampaignAward).where(
        QuotaCampaignAward.campaign_id == QuotaCampaign.id).correlate(QuotaCampaign).scalar_subquery()
    rows = db.execute(select(QuotaCampaign, count).order_by(QuotaCampaign.created_at.desc(), QuotaCampaign.id)
                      .offset(offset).limit(limit))
    return {'items': [{**campaign_json(row), 'awarded_users': total} for row, total in rows],
            'total': db.scalar(select(func.count()).select_from(QuotaCampaign))}


@router.patch('/{campaign_id}/duration')
def patch_duration(campaign_id: CampaignId, body: CampaignDurationRequest,
                   operator: User = Depends(admin), db: Session = Depends(get_db)):
    row = change_campaign_duration(db, campaign_id, operator.id, body)
    db.commit()
    return campaign_json(row)


@router.get('/{campaign_id}/awards')
def list_awards(campaign_id: CampaignId, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
                operator: User = Depends(admin), db: Session = Depends(get_db)):
    if db.get(QuotaCampaign, campaign_id) is None:
        problem('NOT_FOUND', '额度活动不存在', 404)
    query = select(QuotaCampaignAward, QuotaPeriod).join(QuotaPeriod,
        QuotaPeriod.id == QuotaCampaignAward.period_id).where(QuotaCampaignAward.campaign_id == campaign_id)
    rows = db.execute(query.order_by(QuotaCampaignAward.created_at, QuotaCampaignAward.owner_id)
                      .offset(offset).limit(limit))
    return {'items': [{'owner_id': row.owner_id, 'created_at': iso(row.created_at),
                       'grant': period_json(period)} for row, period in rows],
            'total': db.scalar(select(func.count()).select_from(QuotaCampaignAward)
                              .where(QuotaCampaignAward.campaign_id == campaign_id))}
