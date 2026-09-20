"""Products own immutable benefit revisions and monthly/yearly provider-neutral prices."""
from typing import Literal
from fastapi import APIRouter, Depends
from pydantic import Field, model_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session
from .auth import admin
from .billing_models import BillingPlan, BillingPlanRevision, BillingPrice, BillingPriceBinding
from .db import get_db
from .entitlements import lock_operation
from .errors import problem
from .models import uid
from .request_models import RequestBody

router = APIRouter(prefix='/v1/admin/billing', dependencies=[Depends(admin)])
PROVIDERS = ('stripe', 'creem')


def lock_catalog(db):
    lock_operation(db, 'billing-catalog')
    if db.get_bind().dialect.name == 'sqlite':
        db.execute(update(BillingPlan).values(name=BillingPlan.name).where(BillingPlan.id == 'plus'))


def initialize_catalog(db):
    from .billing_providers import provider_enabled, provider_environment
    lock_catalog(db)
    if db.get(BillingPlan, 'plus') is None:
        db.add(BillingPlan(id='plus', name='PLUS'))
        db.flush()
        db.add(BillingPlanRevision(id='plus-v1', plan_id='plus', version=1, name='PLUS',
            monthly_redraw_pages=300, trial_days=7, trial_redraw_pages=30))
        db.flush()
        environment = provider_environment('creem' if provider_enabled('creem') else 'stripe')
        for interval, amount in (('month', 999), ('year', 9999)):
            db.add(BillingPrice(id=f'plus-{interval}-v1', plan_id='plus', plan_revision_id='plus-v1',
                environment=environment, currency='usd', unit_amount=amount, interval=interval, status='draft'))


class BenefitsRequest(RequestBody):
    name: str = Field(min_length=1, max_length=100)
    monthly_redraw_pages: int = Field(ge=0, le=1_000_000)
    trial_days: int = Field(ge=0, le=30)
    trial_redraw_pages: int = Field(ge=0, le=1_000_000)

    @model_validator(mode='after')
    def trial(self):
        if self.trial_days == 0 and self.trial_redraw_pages != 0:
            raise ValueError('No trial pages without a trial')
        return self


class RevisionRequest(BenefitsRequest):
    id: str = Field(min_length=1, max_length=36, pattern=r'^[a-zA-Z0-9_-]+$')


class ProductRequest(BenefitsRequest):
    id: str = Field(min_length=1, max_length=64, pattern=r'^[a-z][a-z0-9_-]*$')
    revision_id: str = Field(min_length=1, max_length=36, pattern=r'^[a-zA-Z0-9_-]+$')


class PriceRequest(RequestBody):
    id: str = Field(min_length=1, max_length=36, pattern=r'^[a-zA-Z0-9_-]+$')
    plan_revision_id: str = Field(min_length=1, max_length=36)
    environment: Literal['test', 'live']
    currency: str = Field(pattern=r'^[a-z]{3}$')
    unit_amount: int = Field(gt=0, le=100_000_000)
    interval: Literal['month', 'year']


class BindingRequest(RequestBody):
    id: str = Field(default_factory=uid, min_length=1, max_length=36, pattern=r'^[a-zA-Z0-9_-]+$')
    provider: Literal['stripe', 'creem']
    environment: Literal['test', 'live']
    product_id: str = Field(min_length=1, max_length=255, pattern=r'^[a-zA-Z0-9_-]+$')
    trial_product_id: str | None = Field(default=None, min_length=1, max_length=255, pattern=r'^[a-zA-Z0-9_-]+$')
    provider_price_id: str | None = Field(default=None, min_length=1, max_length=255, pattern=r'^[a-zA-Z0-9_-]+$')

    @model_validator(mode='after')
    def identifiers(self):
        if self.provider == 'stripe' and (not self.provider_price_id or self.trial_product_id):
            raise ValueError('Stripe requires a price ID and does not use a trial product')
        if self.provider == 'creem' and self.provider_price_id:
            raise ValueError('Creem prices belong to products; omit provider_price_id')
        if self.product_id == self.trial_product_id:
            raise ValueError('The trial and regular products must be different')
        return self


class PriceState(RequestBody):
    status: Literal['active', 'archived']


def revision_json(revision):
    return {field: getattr(revision, field) for field in ('id', 'plan_id', 'version', 'name',
        'monthly_redraw_pages', 'trial_days', 'trial_redraw_pages')}


def binding_json(binding):
    return {field: getattr(binding, field) for field in ('id', 'price_id', 'provider', 'environment',
        'product_id', 'trial_product_id', 'provider_price_id', 'status', 'created_at')}


def price_json(db, price):
    revision = db.get(BillingPlanRevision, price.plan_revision_id)
    return {'id': price.id, 'plan_id': price.plan_id, 'plan_revision_id': revision.id,
        'name': revision.name, 'version': revision.version, 'currency': price.currency,
        'unit_amount': price.unit_amount, 'interval': price.interval,
        'monthly_redraw_pages': revision.monthly_redraw_pages,
        'trial_days': revision.trial_days, 'trial_redraw_pages': revision.trial_redraw_pages}


def offers(db):
    from .billing_providers import provider_enabled, provider_environment
    bindings = list(db.scalars(select(BillingPriceBinding).where(BillingPriceBinding.status == 'active')
        .order_by(BillingPriceBinding.provider, BillingPriceBinding.id)))
    available = {}
    for binding in bindings:
        if provider_enabled(binding.provider) and binding.environment == provider_environment(binding.provider):
            available.setdefault(binding.price_id, []).append(binding)
    result = []
    for price in db.scalars(select(BillingPrice).where(BillingPrice.status == 'active')
            .order_by(BillingPrice.plan_id, BillingPrice.interval, BillingPrice.currency)):
        channels = available.get(price.id, [])
        if channels:
            value = price_json(db, price)
            result.append({**value, 'channels': [{'provider': b.provider, 'binding_id': b.id,
                'trial_days': value['trial_days'], 'trial_redraw_pages': value['trial_redraw_pages']}
                for b in channels]})
    return result


def products_json(db, *, public=False):
    if public:
        public_offers = offers(db)
        return [{'id': plan.id, 'name': plan.name, 'prices': [p for p in public_offers if p['plan_id'] == plan.id]}
            for plan in db.scalars(select(BillingPlan).order_by(BillingPlan.id))
            if any(p['plan_id'] == plan.id for p in public_offers)]
    revisions = list(db.scalars(select(BillingPlanRevision).order_by(BillingPlanRevision.version)))
    prices = list(db.scalars(select(BillingPrice).order_by(BillingPrice.created_at, BillingPrice.id)))
    bindings = list(db.scalars(select(BillingPriceBinding).order_by(BillingPriceBinding.created_at, BillingPriceBinding.id)))
    return [{'id': plan.id, 'name': plan.name,
        'revisions': [revision_json(r) for r in revisions if r.plan_id == plan.id],
        'prices': [{**price_json(db, p), 'status': p.status, 'environment': p.environment,
            'bindings': [binding_json(b) for b in bindings if b.price_id == p.id]}
            for p in prices if p.plan_id == plan.id]}
        for plan in db.scalars(select(BillingPlan).order_by(BillingPlan.id))]


@router.get('/catalog')
def catalog(db: Session = Depends(get_db)):
    from .billing_providers import provider_config_json
    return {'products': products_json(db), 'channels': [provider_config_json(p) for p in PROVIDERS]}


@router.post('/products')
def create_product(body: ProductRequest, db: Session = Depends(get_db)):
    lock_catalog(db)
    existing = db.get(BillingPlan, body.id)
    revision = db.get(BillingPlanRevision, body.revision_id)
    benefits = body.model_dump(exclude={'id', 'revision_id'})
    if existing or revision:
        if not existing or not revision or existing.name != body.name or revision.plan_id != body.id or any(
                getattr(revision, k) != v for k, v in benefits.items()):
            problem('CATALOG_CONFLICT', '产品或权益版本编号已存在，请刷新核实', 409)
        return {'id': existing.id, 'revision_id': revision.id}
    db.add(BillingPlan(id=body.id, name=body.name))
    db.flush()
    db.add(BillingPlanRevision(id=body.revision_id, plan_id=body.id, version=1, **benefits))
    db.commit()
    return {'id': body.id, 'revision_id': body.revision_id}


@router.post('/products/{product_id}/revisions')
def create_revision(product_id: str, body: RevisionRequest, db: Session = Depends(get_db)):
    lock_catalog(db)
    if not db.get(BillingPlan, product_id):
        problem('NOT_FOUND', '产品不存在', 404)
    existing = db.get(BillingPlanRevision, body.id)
    if existing:
        if existing.plan_id != product_id or any(getattr(existing, k) != v for k, v in body.model_dump().items()):
            problem('CATALOG_CONFLICT', '此版本编号已用于其他内容，请刷新核实', 409)
        return {'id': existing.id}
    version = (db.scalar(select(func.max(BillingPlanRevision.version)).where(
        BillingPlanRevision.plan_id == product_id)) or 0) + 1
    db.add(BillingPlanRevision(**body.model_dump(), plan_id=product_id, version=version))
    db.commit()
    return {'id': body.id}


@router.post('/prices')
def create_price(body: PriceRequest, db: Session = Depends(get_db)):
    lock_catalog(db)
    existing = db.get(BillingPrice, body.id)
    if existing:
        if any(getattr(existing, k) != v for k, v in body.model_dump().items()):
            problem('CATALOG_CONFLICT', '此价格编号已用于其他内容，请刷新核实', 409)
        return {'id': existing.id}
    revision = db.get(BillingPlanRevision, body.plan_revision_id)
    if not revision:
        problem('NOT_FOUND', '产品权益版本不存在', 404)
    db.add(BillingPrice(**body.model_dump(), plan_id=revision.plan_id))
    db.commit()
    return {'id': body.id}


@router.post('/prices/{price_id}/bindings')
def create_binding(price_id: str, body: BindingRequest, db: Session = Depends(get_db)):
    lock_catalog(db)
    price = db.get(BillingPrice, price_id)
    if not price:
        problem('NOT_FOUND', '价格不存在', 404)
    if price.environment != body.environment:
        problem('BILLING_ENVIRONMENT_MISMATCH', '价格和渠道绑定必须处于同一环境', 409)
    existing = db.get(BillingPriceBinding, body.id)
    if existing:
        if existing.price_id != price_id or any(getattr(existing, k) != v for k, v in body.model_dump().items()):
            problem('CATALOG_CONFLICT', '此绑定编号已用于其他内容，请刷新核实', 409)
        return {'id': existing.id}
    revision = db.get(BillingPlanRevision, price.plan_revision_id)
    if body.provider == 'creem' and bool(body.trial_product_id) != bool(revision.trial_days):
        problem('BILLING_TRIAL_PRODUCT_REQUIRED', '有试用权益的 Creem 价格须同时绑定普通产品和试用产品', 409)
    clauses = [BillingPriceBinding.provider == body.provider, BillingPriceBinding.environment == body.environment]
    if body.provider == 'stripe':
        clauses.append(BillingPriceBinding.provider_price_id == body.provider_price_id)
    else:
        ids = [value for value in (body.product_id, body.trial_product_id) if value]
        clauses.append(or_(BillingPriceBinding.product_id.in_(ids), BillingPriceBinding.trial_product_id.in_(ids)))
    if db.scalar(select(BillingPriceBinding.id).where(*clauses)):
        problem('CATALOG_CONFLICT', '此支付平台产品或价格已绑定；调价或改变权益须使用新的支付平台价格', 409)
    db.add(BillingPriceBinding(**body.model_dump(), price_id=price_id))
    db.commit()
    return {'id': body.id}


def validate_binding(binding, price, revision):
    from .billing_providers import BillingError, approved_binding
    try:
        approved_binding(binding, price, revision)
    except BillingError as exc:
        problem(exc.code, '无法启用：请核对支付平台环境、金额、币种、周期、产品和试用配置', 409)


@router.put('/bindings/{binding_id}/status')
def publish_binding(binding_id: str, body: PriceState, db: Session = Depends(get_db)):
    lock_catalog(db)
    binding = db.get(BillingPriceBinding, binding_id)
    if not binding:
        problem('NOT_FOUND', '支付渠道绑定不存在', 404)
    price = db.get(BillingPrice, binding.price_id)
    if body.status == 'active':
        validate_binding(binding, price, db.get(BillingPlanRevision, price.plan_revision_id))
        db.execute(update(BillingPriceBinding).where(BillingPriceBinding.price_id == binding.price_id,
            BillingPriceBinding.provider == binding.provider, BillingPriceBinding.environment == binding.environment,
            BillingPriceBinding.status == 'active').values(status='archived'))
    binding.status = body.status
    db.commit()
    return {'id': binding.id, 'status': binding.status}


@router.put('/prices/{price_id}/status')
def publish_price(price_id: str, body: PriceState, db: Session = Depends(get_db)):
    lock_catalog(db)
    price = db.get(BillingPrice, price_id)
    if not price:
        problem('NOT_FOUND', '价格不存在', 404)
    if body.status == 'active':
        bindings = list(db.scalars(select(BillingPriceBinding).where(
            BillingPriceBinding.price_id == price.id, BillingPriceBinding.status == 'active')))
        if not bindings:
            problem('BILLING_PRICE_UNBOUND', '请先启用至少一个支付渠道绑定', 409)
        revision = db.get(BillingPlanRevision, price.plan_revision_id)
        for binding in bindings:
            validate_binding(binding, price, revision)
        db.execute(update(BillingPrice).where(BillingPrice.plan_id == price.plan_id,
            BillingPrice.environment == price.environment, BillingPrice.currency == price.currency,
            BillingPrice.interval == price.interval, BillingPrice.status == 'active').values(status='archived'))
    price.status = body.status
    db.commit()
    return {'id': price.id, 'status': price.status}
