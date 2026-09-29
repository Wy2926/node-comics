"""Bounded metadata diagnostics; never fetch private objects or provider APIs."""
from datetime import timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from .auth import admin
from .config import settings
from .db import get_db
from .errors import problem
from .models import Asset, Job, TextCall, User, now
from .health import queue_alerts
from .health_models import ServiceHeartbeat
from .translation_requests import TranslationRequest
from .translation_limits import image_budget, control_budget
from .comic_title_limits import title_budget
from .feedback_limits import feedback_budget
from .upload_models import UploadReservation
from .upload_ingress import ingress_snapshot
from .billing_models import BillingEvent, BillingOrder
from .admin_monitor import duration_sql

router = APIRouter(prefix='/v1/admin/operations', dependencies=[Depends(admin)])


def page(db, query, offset, limit):
    total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0
    return {'items': [dict(row._mapping) for row in db.execute(query.offset(offset).limit(limit))],
            'total': total, 'next_offset': offset + limit if offset + limit < total else None,
            'generated_at': now()}


def columns(model, names):
    return [getattr(model, key) for key in names.split()]


@router.get('/health')
def service_health(db: Session = Depends(get_db)):
    at = now()
    timeout = settings().cluster_node_timeout_seconds
    query = select(*columns(ServiceHeartbeat, 'role instance_id heartbeat_at last_success_at consecutive_failures failure_count last_error_code'))
    services = []
    for row in db.execute(query.order_by(ServiceHeartbeat.role, ServiceHeartbeat.heartbeat_at.desc())):
        data = dict(row._mapping)
        data['age_seconds'] = max(0, (at - row.heartbeat_at).total_seconds())
        data['status'] = 'healthy' if row.last_success_at and row.last_success_at > at - timedelta(seconds=timeout) and row.consecutive_failures == 0 else 'unhealthy'
        services.append(data)
    present = {row['role'] for row in services}
    for role in ('control-worker', 'maintenance', *(() if settings().dev_auth else ('oidc',))):
        if role not in present:
            services.append({'role': role, 'instance_id': '—', 'status': 'missing', 'age_seconds': None,
                'heartbeat_at': None, 'last_success_at': None, 'consecutive_failures': 0,
                'failure_count': 0, 'last_error_code': None})
    pending = db.execute(select(BillingEvent.provider, BillingEvent.environment, BillingEvent.status, func.count().label('count'),
        func.min(BillingEvent.received_at).label('oldest_received_at'), func.max(BillingEvent.attempts).label('max_attempts'))
        .where(BillingEvent.status != 'processed').group_by(BillingEvent.provider, BillingEvent.environment, BillingEvent.status)
        .order_by(BillingEvent.provider, BillingEvent.environment, BillingEvent.status))
    return {'items': services, 'alerts': queue_alerts(db), 'billing_backlog': [dict(row._mapping) for row in pending],
            'timeout_seconds': timeout, 'generated_at': at}


@router.get('/users/{owner_id}')
def user_diagnostics(owner_id: str, db: Session = Depends(get_db)):
    user = db.get(User, owner_id)
    if user is None:
        problem('NOT_FOUND', '用户不存在', 404)
    at = now()
    controls = [{'scope': scope, **control_budget(owner_id, scope)} for scope in ('translation', 'snapshot', 'history')]
    feedback = feedback_budget(db, owner_id)
    return {'owner_id': owner_id, 'owner_name': user.name, 'generated_at': at,
        'image_budget': image_budget(db, user, at),
        'comic_title_budget': title_budget(db, owner_id),
        'upload_active': ingress_snapshot(owner_id=owner_id)[0],
        'controls': [{name: control[name] for name in (
            'scope', 'recorded_tokens', 'refilled_at', 'active_leases')} for control in controls],
        'feedback': {name: feedback[name] for name in (
            'recorded_tokens', 'refilled_at', 'day_started_at', 'daily_receipts')}}


@router.get('/uploads')
def uploads(owner_id: str | None = Query(None, max_length=36), job_id: str | None = Query(None, max_length=36),
        status: str | None = Query(None, max_length=24), offset: int = Query(0, ge=0),
        limit: int = Query(25, ge=1, le=100), db: Session = Depends(get_db)):
    query = select(*columns(UploadReservation, 'id job_id owner_id mode expected_sha256 expected_size mime status asset_id created_at expires_at max_expires_at completed_at error_code error_message'))
    for col, value in ((UploadReservation.owner_id, owner_id), (UploadReservation.job_id, job_id), (UploadReservation.status, status)):
        if value:
            query = query.where(col == value)
    result = page(db, query.order_by(UploadReservation.created_at.desc(), UploadReservation.id), offset, limit)
    _, deadlines = ingress_snapshot([row['id'] for row in result['items']])
    for row in result['items']:
        row['ingress_expires_at'] = deadlines[row['id']]
    return result


@router.get('/requests')
def requests(owner_id: str | None = Query(None, max_length=36), request_id: str | None = Query(None, max_length=36),
        job_id: str | None = Query(None, max_length=36), offset: int = Query(0, ge=0),
        limit: int = Query(25, ge=1, le=100), db: Session = Depends(get_db)):
    query = select(*columns(TranslationRequest, 'owner_id id job_id created_at revoked_at'))
    for col, value in ((TranslationRequest.owner_id, owner_id), (TranslationRequest.id, request_id),
                       (TranslationRequest.job_id, job_id)):
        if value:
            query = query.where(col == value)
    return page(db, query.order_by(TranslationRequest.created_at.desc(), TranslationRequest.owner_id,
        TranslationRequest.id), offset, limit)


@router.get('/assets')
def assets(owner_id: str | None = Query(None, max_length=36), q: str | None = Query(None, max_length=64),
        job_id: str | None = Query(None, max_length=36), offset: int = Query(0, ge=0),
        limit: int = Query(25, ge=1, le=100), db: Session = Depends(get_db)):
    valid = and_(Asset.deleted_at.is_(None), Asset.purged_at.is_(None),
        or_(Asset.expires_at.is_(None), Asset.expires_at > now(), Asset.active_references > 0))
    job_count = select(func.count()).select_from(Job).where(or_(Job.input_asset_id == Asset.id,
        Job.output_asset_id == Asset.id)).correlate(Asset).scalar_subquery()
    query = select(*columns(Asset, 'id owner_id sha256 kind parent_id mime width height byte_size active_references created_at expires_at deleted_at purged_at'),
        valid.label('available'), job_count.label('job_count'))
    if owner_id:
        query = query.where(Asset.owner_id == owner_id)
    if q:
        query = query.where(or_(Asset.id == q, Asset.sha256 == q))
    if job_id:
        query = query.where(Asset.id.in_(select(Job.input_asset_id).where(Job.id == job_id).union(
            select(Job.output_asset_id).where(Job.id == job_id))))
    return page(db, query.order_by(Asset.created_at.desc(), Asset.id), offset, limit)


@router.get('/results')
def results(owner_id: str | None = Query(None, max_length=36), q: str | None = Query(None, max_length=64),
        mode: str | None = Query(None, max_length=20), offset: int = Query(0, ge=0),
        limit: int = Query(25, ge=1, le=100), db: Session = Depends(get_db)):
    request_count = select(func.count()).select_from(TranslationRequest).where(
        TranslationRequest.job_id == Job.id, TranslationRequest.owner_id == Job.owner_id,
        TranslationRequest.revoked_at.is_(None)).correlate(Job).scalar_subquery()
    query = select(*columns(Job, 'id owner_id source_sha256 mode target_language version status input_asset_id output_asset_id'),
        Job.completed_at.label('generated_at'), request_count.label('request_count')).where(Job.status.in_(['succeeded', 'no_text']))
    if q:
        query = query.where(or_(Job.id == q, Job.source_sha256 == q))
    if owner_id:
        query = query.where(Job.owner_id == owner_id)
    if mode:
        query = query.where(Job.mode == mode)
    return page(db, query.order_by(Job.completed_at.desc(), Job.id), offset, limit)


@router.get('/statistics')
def statistics(days: int = Query(7, ge=1, le=90), provider_id: str | None = Query(None, max_length=80),
        model: str | None = Query(None, max_length=120), db: Session = Depends(get_db)):
    at = now()
    since = at.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1)
    day = func.date(Job.completed_at)
    jobs = db.execute(select(day.label('day'), Job.mode, Job.status, func.count().label('count'),
        func.avg(duration_sql(db, Job.created_at, Job.completed_at)).label('avg_seconds'))
        .where(Job.completed_at >= since, Job.completed_at <= at).group_by(day, Job.mode, Job.status).order_by(day, Job.mode, Job.status))
    text_day = func.date(TextCall.started_at)
    calls = select(text_day.label('day'), TextCall.provider_id, TextCall.model, func.count().label('calls'),
        func.sum(TextCall.accounted_micros).label('accounted_micros'),
        func.sum(case((TextCall.cost_state == 'unknown', 1), else_=0)).label('unknown_calls'),
        func.sum(case((TextCall.cost_state == 'estimated', 1), else_=0)).label('estimated_calls'),
        func.sum(case((TextCall.error_code.is_not(None), 1), else_=0)).label('failed_calls')).where(
            TextCall.started_at >= since, TextCall.started_at <= at)
    if provider_id:
        calls = calls.where(TextCall.provider_id == provider_id)
    if model:
        calls = calls.where(TextCall.model == model)
    calls = calls.group_by(text_day, TextCall.provider_id, TextCall.model).order_by(text_day, TextCall.provider_id, TextCall.model)
    reuse_day = func.date(TranslationRequest.created_at)
    reuse = db.execute(select(reuse_day.label('day'), func.count().label('requests')).join(
        Job, Job.id == TranslationRequest.job_id).where(
            TranslationRequest.owner_id == Job.owner_id, TranslationRequest.created_at > Job.completed_at,
            Job.status.in_(['succeeded', 'no_text']), TranslationRequest.created_at >= since,
            TranslationRequest.created_at <= at).group_by(reuse_day).order_by(reuse_day))
    payment_day = func.date(BillingOrder.created_at)
    payments = db.execute(select(payment_day.label('day'), BillingOrder.provider, BillingOrder.environment, BillingOrder.currency,
        BillingOrder.status, func.count().label('orders'), func.sum(BillingOrder.total).label('order_amount'))
        .where(BillingOrder.created_at >= since, BillingOrder.created_at <= at)
        .group_by(payment_day, BillingOrder.provider, BillingOrder.environment, BillingOrder.currency, BillingOrder.status).order_by(payment_day))
    # Aggregate before loading; each series uses a fixed date window, with explicit
    # truncation if a pathological number of provider/model groups exists.
    text_rows = list(db.execute(calls.limit(2001)))
    return {'timezone': 'UTC', 'from': since, 'to': at, 'generated_at': at,
        'jobs': [dict(row._mapping) for row in jobs], 'reuse': [dict(row._mapping) for row in reuse],
        'text_calls': [dict(row._mapping) for row in text_rows[:2000]], 'text_calls_truncated': len(text_rows) > 2000,
        'payments': [dict(row._mapping) for row in payments]}
