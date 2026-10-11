"""Atomic whole-document reservations over the existing page allowance buckets."""
from datetime import datetime
from sqlalchemy import and_, func, or_, select
from ..billing_models import BillingOrder, BillingPlanRevision, BillingPrice, BillingTerm
from ..entitlement_models import QuotaPeriod
from ..entitlements import DAILY, MONTHLY, _automatic_period, finish_period, is_operator_plus, locked_user, reserve_period
from ..errors import problem
from ..models import Job, Ledger, now, uid
from ..scheduler import lock_scheduler, touch_job
from .config import MAX_PAGES
from .models import Document, DocumentPage, DocumentQuotaAllocation


def _active_terms(owner_id, at):
    return select(BillingTerm, BillingPlanRevision).join(BillingPrice, BillingPrice.id == BillingTerm.price_id).join(
        BillingPlanRevision, BillingPlanRevision.id == BillingPrice.plan_revision_id).where(
            BillingTerm.owner_id == owner_id, BillingTerm.revoked_at.is_(None),
            BillingTerm.starts_at <= at, BillingTerm.ends_at > at)


def _purchases(owner_id, at):
    return select(QuotaPeriod, BillingPlanRevision).join(BillingOrder,
        BillingOrder.id == QuotaPeriod.billing_order_id).join(BillingPrice,
        BillingPrice.id == BillingOrder.price_id).join(BillingPlanRevision,
        BillingPlanRevision.id == BillingPrice.plan_revision_id).where(
            QuotaPeriod.owner_id == owner_id, BillingOrder.owner_id == owner_id,
            QuotaPeriod.mode == 'classic', QuotaPeriod.source == 'purchase',
            QuotaPeriod.revoked_at.is_(None), QuotaPeriod.starts_at <= at,
            or_(QuotaPeriod.ends_at.is_(None), QuotaPeriod.ends_at > at),
            QuotaPeriod.granted > QuotaPeriod.used + QuotaPeriod.reserved)


def _eligible(scope, plan):
    # A free-tier model retains the existing free -> subscription -> purchase
    # billing order. Advanced models require EVERY paying bucket's own scope.
    return scope is None or 'free' in scope or plan in scope


def _order(option):
    period = option[0]
    return period.ends_at or datetime.max, period.starts_at, period.id


def _options(db, user, scope, at):
    """Each finite query is bounded by the maximum number of payable pages."""
    free = []
    if _eligible(scope, 'free'):
        query = select(QuotaPeriod).where(QuotaPeriod.owner_id == user.id,
            QuotaPeriod.mode == 'classic', QuotaPeriod.source == 'grant',
            QuotaPeriod.revoked_at.is_(None),
            QuotaPeriod.kind.in_((DAILY, 'classic_grant')), QuotaPeriod.starts_at <= at,
            or_(QuotaPeriod.ends_at.is_(None), QuotaPeriod.ends_at > at),
            QuotaPeriod.granted > QuotaPeriod.used + QuotaPeriod.reserved).order_by(
                QuotaPeriod.ends_at.asc().nulls_last(), QuotaPeriod.starts_at, QuotaPeriod.id).limit(MAX_PAGES)
        free = [(period, None, 'free', None) for period in db.scalars(query)]
        daily = _automatic_period(db, user, DAILY, at)
        if daily and daily.revoked_at is None and daily.granted > daily.used + daily.reserved:
            free.append((daily, None, 'free', None))
    for option in sorted(free, key=_order):
        yield option

    # An eligible unlimited membership supplies the remaining pages before any
    # finite subscription or purchase, without creating an artificial balance.
    query = _active_terms(user.id, at).where(or_(
        and_(BillingTerm.kind == 'paid', BillingPlanRevision.monthly_classic_pages.is_(None)),
        and_(BillingTerm.kind == 'trial', BillingPlanRevision.trial_classic_pages.is_(None))))
    if scope is not None and 'free' not in scope:
        query = query.where(func.coalesce(BillingPlanRevision.service_plan_id, BillingPlanRevision.plan_id).in_(scope))
    unlimited = db.execute(query.order_by(BillingTerm.ends_at, BillingTerm.id).limit(1)).first()
    if unlimited:
        term, revision = unlimited
        yield None, term, revision.service_plan_id or revision.plan_id, revision
        return
    if _eligible(scope, 'plus') and is_operator_plus(user, at) and user.plus_monthly_pages is None:
        yield None, None, 'plus', None
        return

    query = select(QuotaPeriod, BillingPlanRevision).join(BillingTerm,
        BillingTerm.id == QuotaPeriod.billing_term_id).join(BillingPrice,
        BillingPrice.id == BillingTerm.price_id).join(BillingPlanRevision,
        BillingPlanRevision.id == BillingPrice.plan_revision_id).where(
            QuotaPeriod.owner_id == user.id, BillingTerm.owner_id == user.id,
            QuotaPeriod.mode == 'classic', QuotaPeriod.source == 'subscription',
            QuotaPeriod.revoked_at.is_(None),
            BillingTerm.revoked_at.is_(None), BillingTerm.starts_at <= at, BillingTerm.ends_at > at,
            QuotaPeriod.starts_at <= at, QuotaPeriod.ends_at > at,
            QuotaPeriod.granted > QuotaPeriod.used + QuotaPeriod.reserved)
    if scope is not None and 'free' not in scope:
        query = query.where(func.coalesce(BillingPlanRevision.service_plan_id, BillingPlanRevision.plan_id).in_(scope))
    monthly = [(period, None, revision.service_plan_id or revision.plan_id, revision)
               for period, revision in db.execute(query.order_by(QuotaPeriod.ends_at,
                   QuotaPeriod.starts_at, QuotaPeriod.id).limit(MAX_PAGES))]
    gift = _automatic_period(db, user, MONTHLY, at) if _eligible(scope, 'plus') else None
    if gift and gift.revoked_at is None and gift.granted > gift.used + gift.reserved:
        monthly.append((gift, None, 'plus', None))
    yield from sorted(monthly, key=_order)

    query = _purchases(user.id, at)
    if scope is not None and 'free' not in scope:
        query = query.where(BillingPlanRevision.service_plan_id.in_(scope))
    for period, revision in db.execute(query.order_by(QuotaPeriod.ends_at.asc().nulls_last(),
            QuotaPeriod.starts_at, QuotaPeriod.id).limit(MAX_PAGES)):
        yield period, None, revision.service_plan_id, revision


def reserve_document(db, job):
    """Reserve all verified pages or none; caller commits and starts OCR explicitly."""
    lock_scheduler(db)
    user = locked_user(db, job.owner_id)
    job = db.scalar(select(Job).where(Job.id == job.id, Job.workflow_kind == 'document')
                    .with_for_update().execution_options(populate_existing=True))
    document = db.scalar(select(Document).where(Document.job_id == job.id).with_for_update()
                         .execution_options(populate_existing=True)) if job else None
    if document is None:
        problem('DOCUMENT_NOT_FOUND', '找不到文件任务', 404)
    if document.reserved_at is not None:
        return True
    if job.cancel_requested or job.discard_output or job.status in {'failed', 'cancelled', 'succeeded'}:
        problem('DOCUMENT_NOT_RESUMABLE', '此文件任务不能继续处理', 409)
    at = now()
    if document.expires_at <= at:
        problem('DOCUMENT_EXPIRED', '文件暂存已过期，请重新上传', 410)
    pages = list(db.scalars(select(DocumentPage).where(DocumentPage.job_id == job.id).order_by(DocumentPage.page_index)))
    count = document.page_count
    if not count or not 1 <= count <= MAX_PAGES or len(pages) != count or [p.page_index for p in pages] != list(range(1, count + 1)):
        problem('DOCUMENT_MANIFEST_INVALID', '文件页清单尚未完整核实', 409)
    if any(not page.input_ref or page.allocation_id for page in pages):
        problem('DOCUMENT_MANIFEST_INVALID', '文件页清单尚未准备完成', 409)
    if 'document' not in job.config or 'service_plans' not in job.config['document']:
        problem('DOCUMENT_CONFIG_INVALID', '文件任务缺少冻结的模型权限', 409)
    scope = job.config['document']['service_plans']
    plan, remaining = [], count
    for period, term, service, revision in _options(db, user, scope, at):
        amount = min(remaining, period.granted - period.used - period.reserved) if period else remaining
        if amount:
            plan.append((period, term, service, revision, amount))
            remaining -= amount
        if not remaining:
            break
    job.entitlement = {**job.entitlement, 'document_quota': {'needed': count,
        'available': count - remaining, 'difference': remaining, 'checked_at': at.isoformat() + 'Z'}}
    if remaining:
        job.status, job.phase = 'awaiting_quota', 'awaiting_quota'
        job.error_code, job.error_message = 'DOCUMENT_QUOTA_INSUFFICIENT', '可用额度不足，请补充后手动继续，或取消任务'
        touch_job(db, job)
        return False

    offset = 0
    for period, term, service, revision, amount in plan:
        if period is None and term is None:
            # Operator gifts have neither a billing term nor a finite bucket.
            # Freeze their execution usage in the existing job snapshot; pages
            # without an allocation belong to this one unlimited gift.
            job.entitlement = {**job.entitlement, 'document_unlimited_gift': {
                'membership_id': user.membership_id, 'pages': amount,
                'reserved': amount, 'used': 0, 'released': 0}}
            db.add(Ledger(owner_id=job.owner_id, job_id=job.id, quota_kind='classic_unlimited',
                transaction_key=f'document:{job.id}:gift:reserve', kind='reserve', amount=amount))
            offset += amount
            continue
        if period:
            if period not in db:
                db.add(period)
                db.flush()
            reserve_period(db, period.id, amount, at)
        allocation = DocumentQuotaAllocation(id=uid(), job_id=job.id, period_id=period.id if period else None,
            billing_term_id=term.id if term else None, pages=amount, reserved=amount, used=0, released=0,
            entitlement={'service_plan': service, 'revision_id': revision.id if revision else None,
                         'hourly_image_limit': revision.hourly_image_limit if revision else None,
                         'kind': period.kind if period else 'classic_unlimited'})
        db.add(allocation)
        db.flush()
        for page in pages[offset:offset + amount]:
            page.allocation_id = allocation.id
        offset += amount
        db.add(Ledger(owner_id=job.owner_id, job_id=job.id, period_id=allocation.period_id,
            quota_kind=allocation.entitlement['kind'], transaction_key=f'document:{job.id}:{allocation.id}:reserve',
            kind='reserve', amount=amount))
    document.reserved_at = at
    job.quota_pages, job.quota_kind, job.settlement = count, 'document_pages', 'reserved'
    job.entitlement = {**job.entitlement, 'accepted_at': at.isoformat() + 'Z',
                       'priority': 0, 'pages': count}
    job.status, job.phase, job.error_code, job.error_message = 'queued', 'doc_ocr', None, None
    touch_job(db, job)
    db.flush()
    return True


def _settle_pages(db, job, pages, allocation_id, period_id, kind, reserved, success):
    used = sum(1 for page in pages if page.allocation_id == allocation_id and success and
               page.billable and page.status == 'translated' and 'unrecognized_regions' not in page.quality_flags)
    released = reserved - used
    if period_id:
        finish_period(db, period_id, reserved, used)
    for operation, amount in (('settle', used), ('release', released)):
        if amount:
            db.add(Ledger(owner_id=job.owner_id, job_id=job.id, period_id=period_id,
                quota_kind=kind, transaction_key=f'document:{job.id}:{allocation_id or "gift"}:{operation}',
                kind=operation, amount=amount))
    return used, released


def settle_document(db, job, *, success=True):
    """Exactly once, using the original per-page allocation even after expiry."""
    lock_scheduler(db)
    job = db.scalar(select(Job).where(Job.id == job.id, Job.workflow_kind == 'document')
                    .with_for_update().execution_options(populate_existing=True))
    if not job or job.settlement != 'reserved':
        return
    allocations = list(db.scalars(select(DocumentQuotaAllocation).where(
        DocumentQuotaAllocation.job_id == job.id).order_by(DocumentQuotaAllocation.id).with_for_update()))
    pages = list(db.scalars(select(DocumentPage).where(DocumentPage.job_id == job.id)))
    gift = (job.entitlement or {}).get('document_unlimited_gift', {})
    if (sum(item.reserved for item in allocations) + gift.get('reserved', 0) != job.quota_pages or
            sum(page.allocation_id is None for page in pages) != gift.get('pages', 0)):
        problem('QUOTA_CONFLICT', '文件预占账本不完整', 409)
    for allocation in allocations:
        used, released = _settle_pages(db, job, pages, allocation.id, allocation.period_id,
                                      allocation.entitlement['kind'], allocation.reserved, success)
        allocation.reserved, allocation.used, allocation.released = 0, used, released
    if gift:
        used, released = _settle_pages(db, job, pages, None, None, 'classic_unlimited', gift['reserved'], success)
        job.entitlement = {**job.entitlement, 'document_unlimited_gift': {
            **gift, 'reserved': 0, 'used': used, 'released': released}}
    job.settlement = 'settled' if success else 'released'
    touch_job(db, job)
