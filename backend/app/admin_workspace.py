"""Small operational summaries and commit-driven inbox notifications."""
import asyncio
import time

import jwt
from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .auth import admin
from .billing_admin import order_json, order_query
from .billing_models import BillingOrder
from .db import get_db, session_factory
from .models import User
from .notifications import hub
from .reader_api import Feedback
from .support_requests import SupportRequest
from .translation_events import SnapshotStream, event

router = APIRouter(prefix='/v1/admin/workspace', tags=['admin-workspace'])
OPEN = ('received', 'reviewing')


def inbox_snapshot(db):
    counts = dict(db.execute(select(SupportRequest.kind, func.count()).where(
        SupportRequest.status.in_(OPEN)).group_by(SupportRequest.kind)).all())
    counts['translation'] = db.scalar(select(func.count()).select_from(Feedback).where(Feedback.status.in_(OPEN)))
    latest = {}
    for kind in ('translation', 'plugin', 'uninstall', 'website'):
        model = Feedback if kind == 'translation' else SupportRequest
        query = select(model.id, model.created_at)
        if model is SupportRequest:
            query = query.where(model.kind == kind)
        row = db.execute(query.order_by(model.created_at.desc(), model.id.desc()).limit(1)).first()
        latest[kind] = row.id if row else None
    return {'counts': {kind: counts.get(kind, 0) for kind in latest}, 'latest': latest,
            'total': sum(counts.values())}


def commerce_summary(db, since):
    # Aggregate in SQL; never load historical order bodies or feedback attachments.
    revenue = db.execute(select(BillingOrder.currency, func.sum(BillingOrder.total), func.count()).where(
        BillingOrder.environment == 'live', BillingOrder.paid_at >= since,
        BillingOrder.status.in_(('paid', 'partially_refunded', 'refunded', 'disputed'))
    ).group_by(BillingOrder.currency)).all()
    orders = db.execute(order_query().order_by(BillingOrder.created_at.desc(), BillingOrder.id.desc()).limit(6)).all()
    feedback = db.execute(select(Feedback.id, Feedback.comment, Feedback.status, Feedback.created_at, User.name).join(
        User, User.id == Feedback.owner_id).where(Feedback.status.in_(OPEN)).order_by(
        Feedback.created_at.desc(), Feedback.id.desc()).limit(6)).all()
    support = db.execute(select(SupportRequest.id, SupportRequest.kind, SupportRequest.comment, SupportRequest.site_name,
        SupportRequest.status, SupportRequest.created_at).where(SupportRequest.status.in_(OPEN)).order_by(
        SupportRequest.created_at.desc(), SupportRequest.id.desc()).limit(6)).all()
    recent_feedback = [{'id': row.id, 'kind': 'translation', 'comment': row.comment,
        'name': row.name, 'status': row.status, 'created_at': row.created_at} for row in feedback]
    recent_feedback += [{'id': row.id, 'kind': row.kind, 'comment': row.comment,
        'name': row.site_name or '匿名读者', 'status': row.status, 'created_at': row.created_at} for row in support]
    recent_feedback.sort(key=lambda row: (row['created_at'], row['id']), reverse=True)
    return {'commerce': {
        'orders_24h': db.scalar(select(func.count()).select_from(BillingOrder).where(BillingOrder.created_at >= since)),
        'attention_orders': db.scalar(select(func.count()).select_from(BillingOrder).where(
            BillingOrder.status.in_(('unknown', 'failed', 'disputed', 'partially_refunded')))),
        'revenue_24h': [{'currency': currency, 'amount': amount, 'count': count} for currency, amount, count in revenue],
        'recent_orders': [order_json(*row) for row in orders]},
        'inbox': inbox_snapshot(db), 'recent_feedback': recent_feedback}


@router.get('/inbox')
def inbox(user: User = Depends(admin), db: Session = Depends(get_db)):
    return inbox_snapshot(db)


def read_inbox(user_id):
    with session_factory()() as db:
        user = db.get(User, user_id)
        return inbox_snapshot(db) if user and user.role == 'admin' else None


@router.get('/events')
async def inbox_events(request: Request, user: User = Depends(admin), db: Session = Depends(get_db)):
    # Authentication already validated the bearer. Match its expiry and release
    # the dependency session before holding a stream open.
    claims = jwt.decode(request.headers['authorization'].split()[1], options={'verify_signature': False})
    user_id = user.id
    await run_in_threadpool(db.close)
    deadline = time.monotonic() + max(0, min(295, claims['exp'] - time.time()))
    subscription = hub().subscribe('admin:inbox')
    wake = subscription.__enter__()

    async def cleanup():
        subscription.__exit__(None, None, None)

    try:
        first = await run_in_threadpool(read_inbox, user_id)
    except BaseException:
        await cleanup()
        raise

    async def frames():
        snapshot = first
        yield event('inbox', snapshot)
        reconcile_at = time.monotonic() + 60
        while snapshot is not None and not hub().stop.is_set() and time.monotonic() < deadline:
            try:
                await asyncio.wait_for(wake.wait(), max(.01, min(20, deadline - time.monotonic())))
            except TimeoutError:
                pass
            if time.monotonic() >= deadline:
                break
            if not wake.is_set() and time.monotonic() < reconcile_at:
                yield ': keepalive\n\n'
                continue
            await asyncio.sleep(.1)  # Coalesce bursts into one bounded snapshot.
            wake.clear()
            next_snapshot = await run_in_threadpool(read_inbox, user_id)
            reconcile_at = time.monotonic() + 60
            if next_snapshot != snapshot:
                snapshot = next_snapshot
                yield event('inbox', snapshot)
        yield event('end', {'reason': 'reconnect'})

    return SnapshotStream(frames(), cleanup, deadline + .1)
