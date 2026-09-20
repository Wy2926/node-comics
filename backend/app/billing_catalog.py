"""Versioned subscription catalog. Published terms never change in place."""
from typing import Literal
from fastapi import APIRouter, Depends
from pydantic import Field, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session
from .auth import admin
from .billing_models import BillingPlan, BillingPlanRevision, BillingPrice
from .config import settings
from .db import get_db
from .entitlements import lock_operation
from .errors import problem
from .request_models import RequestBody
from . import stripe_client as stripe

router = APIRouter(prefix='/v1/admin/billing', dependencies=[Depends(admin)])


def lock_catalog(db):
    lock_operation(db, 'billing-catalog')
    if db.get_bind().dialect.name == 'sqlite':
        db.execute(update(BillingPlan).values(name=BillingPlan.name).where(BillingPlan.id == 'plus'))


def initialize_catalog(db):
    lock_catalog(db)
    if db.get(BillingPlan, 'plus') is None:
        db.add(BillingPlan(id='plus', name='PLUS'))
        db.flush()
        db.add(BillingPlanRevision(id='plus-v1', plan_id='plus', version=1, name='PLUS',
            monthly_redraw_pages=300, trial_days=7, trial_redraw_pages=30))
        db.flush()
        db.add(BillingPrice(id='plus-monthly-v1', plan_id='plus', plan_revision_id='plus-v1',
            environment=settings().stripe_environment, currency='usd', unit_amount=999, interval='month', status='draft'))


class RevisionRequest(RequestBody):
    id: str = Field(min_length=1, max_length=36, pattern=r'^[a-zA-Z0-9_-]+$')
    name: str = Field(min_length=1, max_length=100)
    monthly_redraw_pages: int = Field(ge=0, le=1_000_000)
    trial_days: int = Field(ge=0, le=30)
    trial_redraw_pages: int = Field(ge=0, le=1_000_000)

    @model_validator(mode='after')
    def trial(self):
        if self.trial_days == 0 and self.trial_redraw_pages != 0:
            raise ValueError('No trial pages without a trial')
        return self


class PriceRequest(RequestBody):
    id: str = Field(min_length=1, max_length=36, pattern=r'^[a-zA-Z0-9_-]+$')
    plan_revision_id: str = Field(min_length=1, max_length=36)
    currency: str = Field(pattern=r'^[a-z]{3}$')
    unit_amount: int = Field(gt=0, le=100_000_000)
    interval: Literal['month', 'year']
    stripe_product_id: str | None = Field(default=None, pattern=r'^prod_[a-zA-Z0-9]+$', max_length=255)
    stripe_price_id: str | None = Field(default=None, pattern=r'^price_[a-zA-Z0-9]+$', max_length=255)

    @model_validator(mode='after')
    def binding(self):
        if bool(self.stripe_product_id) != bool(self.stripe_price_id):
            raise ValueError('Both Stripe identifiers are required together')
        return self


class PriceState(RequestBody):
    status: Literal['active', 'archived']


def price_json(db, price):
    revision = db.get(BillingPlanRevision, price.plan_revision_id)
    return {'id': price.id, 'plan_id': price.plan_id, 'plan_revision_id': revision.id,
        'name': revision.name, 'version': revision.version, 'currency': price.currency,
        'unit_amount': price.unit_amount, 'interval': price.interval,
        'monthly_redraw_pages': revision.monthly_redraw_pages,
        'trial_days': revision.trial_days, 'trial_redraw_pages': revision.trial_redraw_pages}


def offers(db):
    return [price_json(db, p) for p in db.scalars(select(BillingPrice).where(
        BillingPrice.environment == settings().stripe_environment, BillingPrice.status == 'active')
        .order_by(BillingPrice.plan_id, BillingPrice.interval, BillingPrice.currency))]


@router.get('/catalog')
def catalog(db: Session = Depends(get_db)):
    return {'plans': [{'id': p.id, 'name': p.name} for p in db.scalars(select(BillingPlan).order_by(BillingPlan.id))],
        'revisions': [{field: getattr(r, field) for field in ('id', 'plan_id', 'version', 'name',
            'monthly_redraw_pages', 'trial_days', 'trial_redraw_pages')}
            for r in db.scalars(select(BillingPlanRevision).order_by(BillingPlanRevision.plan_id, BillingPlanRevision.version))],
        'prices': [{**price_json(db, p), 'status': p.status, 'environment': p.environment,
            'stripe_product_id': p.stripe_product_id, 'stripe_price_id': p.stripe_price_id}
            for p in db.scalars(select(BillingPrice).order_by(BillingPrice.created_at))]}


@router.post('/plans/{plan_id}/revisions')
def create_revision(plan_id: str, body: RevisionRequest, db: Session = Depends(get_db)):
    import re
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', plan_id):
        problem('PLAN_ID_INVALID', '套餐编号须为小写字母、数字、短横线或下划线', 422)
    lock_catalog(db)
    existing = db.get(BillingPlanRevision, body.id)
    if existing:
        if existing.plan_id != plan_id or any(getattr(existing, k) != v for k, v in body.model_dump().items()):
            problem('CATALOG_CONFLICT', '此版本编号已用于其他内容，请刷新核实', 409)
        return {'id': existing.id}
    plan = db.get(BillingPlan, plan_id)
    if plan is None:
        db.add(BillingPlan(id=plan_id, name=body.name))
        db.flush()
    version = (db.scalar(select(func.max(BillingPlanRevision.version)).where(BillingPlanRevision.plan_id == plan_id)) or 0) + 1
    db.add(BillingPlanRevision(**body.model_dump(), plan_id=plan_id, version=version))
    db.commit()
    return {'id': body.id}


@router.post('/prices')
def create_price(body: PriceRequest, db: Session = Depends(get_db)):
    lock_catalog(db)
    existing = db.get(BillingPrice, body.id)
    if existing:
        if existing.environment != settings().stripe_environment or any(getattr(existing, k) != v for k, v in body.model_dump().items()):
            problem('CATALOG_CONFLICT', '此报价编号已用于其他内容，请刷新核实', 409)
        return {'id': existing.id}
    revision = db.get(BillingPlanRevision, body.plan_revision_id)
    if not revision:
        problem('NOT_FOUND', '套餐版本不存在', 404)
    if body.stripe_price_id and db.scalar(select(BillingPrice.id).where(BillingPrice.stripe_price_id == body.stripe_price_id)):
        problem('CATALOG_CONFLICT', '此 Stripe 价格已绑定报价；调价或改变权益需创建新的 Stripe 价格', 409)
    db.add(BillingPrice(**body.model_dump(), plan_id=revision.plan_id, environment=settings().stripe_environment))
    db.commit()
    return {'id': body.id}


@router.put('/prices/{price_id}/status')
def publish_price(price_id: str, body: PriceState, db: Session = Depends(get_db)):
    price = db.get(BillingPrice, price_id)
    if not price or price.environment != settings().stripe_environment:
        problem('NOT_FOUND', '报价不存在', 404)
    if body.status == 'active':
        try:
            stripe.require(price.stripe_price_id and price.stripe_product_id, 'STRIPE_PRICE_UNBOUND')
            remote = stripe.call('prices', 'retrieve', price.stripe_price_id)
            stripe.approved_price(remote, price)
            stripe.require(remote.get('active'), 'STRIPE_PLAN_UNAVAILABLE')
        except stripe.BillingError as exc:
            problem(exc.code, '无法发布：请核对 Stripe 环境、金额、币种、周期和产品配置', 409)
    lock_catalog(db)
    # Flush retirement before activation to satisfy the one-current-price constraint.
    if body.status == 'active':
        db.execute(update(BillingPrice).where(BillingPrice.plan_id == price.plan_id,
            BillingPrice.environment == price.environment, BillingPrice.currency == price.currency,
            BillingPrice.interval == price.interval, BillingPrice.status == 'active').values(status='archived'))
    price.status = body.status
    db.commit()
    return {'id': price.id, 'status': price.status}
