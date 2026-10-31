"""Bounded metadata diagnostics; never fetch private objects or provider APIs."""
from datetime import timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from .auth import admin
from .config import settings
from .db import get_db
from .errors import problem
from .models import Job, TextCall, User, now
from .health import queue_alerts
from .health_models import ServiceHeartbeat
from .translation_requests import TranslationRequest
from .translation_limits import image_budget, control_budget
from .comic_title_limits import title_budget
from .feedback_limits import feedback_budget
from .upload_ingress import ingress_snapshot
from .billing_models import BillingEvent, BillingOrder
from .admin_monitor import duration_sql

router = APIRouter(prefix='/v1/admin/operations', dependencies=[Depends(admin)])


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
    from .documents.config import get_document_settings
    for role in ('control-worker', 'maintenance', *(() if settings().dev_auth else ('oidc',)),
            *(('document-worker',) if get_document_settings().enabled else ())):
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


@router.get('/statistics')
def statistics(days: int = Query(7, ge=1, le=90), provider_id: str | None = Query(None, max_length=80),
        model: str | None = Query(None, max_length=120), db: Session = Depends(get_db)):
    at = now()
    since = at.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1)
    day = func.date(Job.completed_at)
    jobs = db.execute(select(day.label('day'), Job.mode, Job.workflow_kind, Job.status, func.count().label('count'),
        func.avg(duration_sql(db, Job.created_at, Job.completed_at)).label('avg_seconds'))
        .where(Job.completed_at >= since, Job.completed_at <= at).group_by(day, Job.mode, Job.workflow_kind, Job.status)
        .order_by(day, Job.mode, Job.workflow_kind, Job.status))
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
