"""Disposable multi-channel admin UI fixture; every provider response is synthetic.

Run from backend: .venv/Scripts/python.exe tests/manual_billing_server.py
Build admin-ui first. Open /console-test/ on port 18091 and log in as admin.
The printed controls.json supports {"delay": 0, "fail": false, "empty_orders": false}.
No external checkout, charge or production data is used.
"""
import asyncio
from datetime import timedelta
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
directory = Path(tempfile.mkdtemp(prefix='nc-billing-ui-'))
os.environ.update(APP_ENV='test', DEV_AUTH='true', DEV_ADMIN_USERNAME='admin',
    DEV_AUTH_SECRET='isolated-billing-ui-secret-never-used-in-production',
    DATABASE_URL=f'sqlite:///{directory / "billing.db"}', STORAGE_PATH=str(directory / 'objects'),
    RESULT_STORAGE_BACKEND='local', STRIPE_ENABLED='true', STRIPE_ENVIRONMENT='test',
    STRIPE_SECRET_KEY='sk_test_synthetic', STRIPE_WEBHOOK_SECRET='whsec_synthetic',
    STRIPE_RETURN_URL='https://comics.example/account/', CREEM_ENABLED='true', CREEM_ENVIRONMENT='test',
    CREEM_API_KEY='creem_test_synthetic', CREEM_WEBHOOK_SECRET='synthetic-webhook',
    CREEM_RETURN_URL='https://comics.example/account/', ADMIN_WEB_PATH='/console-test/',
    OPENAI_API_KEY='', PROVIDERS_JSON='', CLASSIC_ENABLED='false')
from app.config import Settings
Settings.model_config['env_file'] = None
from sqlalchemy import or_, select
from fastapi.responses import JSONResponse
from app import creem_client, stripe_client, billing_checkout
from app.billing_models import BillingPrice, BillingPriceBinding, BillingCheckout, BillingSubscription, BillingOrder, BillingOrderTransition, BillingEvent
from app.billing_catalog import initialize_catalog
from app.billing_providers import BillingError
from app.db import initialize, session_factory
from app.models import User, now
from app.main import app


def synthetic_stripe(resource, action, *args, **kwargs):
    if (resource, action) != ('prices', 'retrieve'):
        raise BillingError('FIXTURE_NO_PAYMENT')
    with session_factory()() as db:
        binding = db.scalar(select(BillingPriceBinding).where(BillingPriceBinding.provider_price_id == args[0]))
        if not binding or args[0] == 'price_error':
            raise BillingError('FIXTURE_PRICE_UNAVAILABLE')
        price = db.get(BillingPrice, binding.price_id)
        return {'id': binding.provider_price_id, 'product': binding.product_id, 'livemode': False,
            'active': True, 'unit_amount': price.unit_amount, 'currency': price.currency,
            'recurring': {'interval': price.interval, 'interval_count': 1, 'usage_type': 'licensed'}}


def synthetic_creem(method, path, **kwargs):
    if method != 'GET' or not path.startswith('/products/'):
        raise BillingError('FIXTURE_NO_PAYMENT')
    product_id = path.rsplit('/', 1)[-1]
    with session_factory()() as db:
        binding = db.scalar(select(BillingPriceBinding).where(or_(
            BillingPriceBinding.product_id == product_id, BillingPriceBinding.trial_product_id == product_id)))
        if not binding or product_id == 'prod_error':
            raise BillingError('FIXTURE_PRODUCT_UNAVAILABLE')
        price = db.get(BillingPrice, binding.price_id)
        return {'id': product_id, 'mode': 'test', 'status': 'active', 'price': price.unit_amount,
            'currency': price.currency, 'billing_type': 'recurring',
            'billing_period': {'month': 'every-month', 'year': 'every-year'}[price.interval],
            'trial_period_days': 7 if product_id == binding.trial_product_id else 0}


stripe_client.call, creem_client.call = synthetic_stripe, synthetic_creem


def synthetic_owner_sync(owner_id):
    """A read-only platform refresh for UI feedback; never contacts a gateway."""
    return None


billing_checkout.sync_owner = synthetic_owner_sync
controls = directory / 'controls.json'
controls.write_text('{"delay":0,"fail":false,"empty_orders":false}', encoding='utf-8')


@app.middleware('http')
async def fixture_faults(request, call_next):
    if request.url.path.startswith('/v1/admin/billing/'):
        state = json.loads(controls.read_text(encoding='utf-8'))
        if state.get('delay'):
            await asyncio.sleep(min(float(state['delay']), 10))
        if state.get('fail'):
            return JSONResponse({'error': {'code': 'FIXTURE_UNAVAILABLE', 'message': '隔离测试：支付管理暂时不可用'}}, status_code=503)
        if state.get('empty_orders') and request.url.path == '/v1/admin/billing/orders':
            return JSONResponse({'items': [], 'total': 0, 'page': 1, 'page_size': 30})
    return await call_next(request)


initialize()
with session_factory()() as db:
    initialize_catalog(db)
    db.add(User(id='billing-demo-user', subject='fixture:billing-reader', name='测试读者小岚'))
    db.flush()
    for interval in ('month', 'year'):
        price = db.get(BillingPrice, f'plus-{interval}-v1')
        price.status = 'active'
        for provider in ('stripe', 'creem'):
            db.add(BillingPriceBinding(id=f'fixture-{provider}-{interval}', price_id=price.id,
                provider=provider, environment='test', product_id=f'prod_{provider}_{interval}',
                trial_product_id=f'prod_creem_{interval}_trial' if provider == 'creem' else None,
                provider_price_id=f'price_{interval}' if provider == 'stripe' else None, status='active'))
    db.flush()
    at = now()
    states = ['paid', 'trialing', 'pending', 'failed', 'refunded', 'unknown', 'canceled', 'expired']
    for index in range(34):
        provider = 'creem' if index % 2 == 0 else 'stripe'
        interval = 'year' if index % 3 == 0 else 'month'
        status = states[index % len(states)]
        created = at - timedelta(hours=index)
        checkout_id, order_id = f'fixture-checkout-{index:02}', f'fixture-order-{index:02}'
        price_id, binding_id = f'plus-{interval}-v1', f'fixture-{provider}-{interval}'
        total = 9999 if interval == 'year' else 999
        db.add(BillingCheckout(id=checkout_id, owner_id='billing-demo-user', provider=provider,
            environment='test', price_id=price_id, binding_id=binding_id, return_url='https://comics.example/account/',
            trial=status == 'trialing', status='completed' if status in ('paid', 'trialing', 'refunded') else status,
            session_id=None if status == 'unknown' else f'cs_fixture_{index:02}', created_at=created, expires_at=created + timedelta(hours=1)))
        db.flush()
        subscription_id = None
        if status in ('paid', 'trialing', 'refunded'):
            subscription_id = f'{provider}:test:sub_fixture_{index:02}'
            db.add(BillingSubscription(id=subscription_id, owner_id='billing-demo-user', checkout_id=checkout_id,
                provider=provider, environment='test', customer_id=f'cust_fixture_{provider}', price_id=price_id,
                binding_id=binding_id, status='trialing' if status == 'trialing' else 'active',
                trial_starts_at=created if status == 'trialing' else None,
                trial_ends_at=created + timedelta(days=7) if status == 'trialing' else None,
                paid_starts_at=created if status != 'trialing' else None,
                paid_ends_at=created + timedelta(days=365 if interval == 'year' else 30) if status != 'trialing' else None,
                next_billed_at=created + timedelta(days=7 if status == 'trialing' else 365 if interval == 'year' else 30)))
            db.flush()
        db.add(BillingOrder(id=order_id, owner_id='billing-demo-user', provider=provider, environment='test',
            checkout_id=checkout_id, subscription_id=subscription_id, price_id=price_id, binding_id=binding_id,
            external_id=f'ord_platform_{index:02}', kind='initial' if index % 4 != 3 else 'renewal',
            status=status, currency='usd', subtotal=0 if status == 'trialing' else total,
            total=0 if status == 'trialing' else total, created_at=created, updated_at=created + timedelta(minutes=2),
            paid_at=created + timedelta(minutes=1) if status in ('paid', 'refunded') else None,
            error_code='PAYMENT_DECLINED' if status == 'failed' else None))
        db.flush()
        for step, (before, after, source) in enumerate([(None, 'creating', 'checkout'), ('creating', 'pending', 'checkout_sync'), ('pending', status, 'subscription_sync' if status == 'trialing' else 'transaction_sync')]):
            db.add(BillingOrderTransition(order_id=order_id, source=source, event_id=f'evt_fixture_{index}_{step}',
                from_status=before, to_status=after, detail={'event_type': 'subscription.trialing' if status == 'trialing' else 'checkout.completed'},
                created_at=created + timedelta(minutes=step)))
        db.add(BillingEvent(id=f'{provider}:test:evt_fixture_{index}_2', provider=provider,
            environment='test', event_type='checkout.completed', resource_id=f'cs_fixture_{index:02}',
            occurred_at=created + timedelta(minutes=1), received_at=created + timedelta(minutes=2),
            processed_at=created + timedelta(minutes=2), status='processed', attempts=1, payload={}))
        if index == 0:
            db.add(BillingEvent(id=f'{provider}:test:evt_fixture_retry', provider=provider,
                environment='test', event_type='subscription.update', resource_id='sub_fixture_00',
                occurred_at=created + timedelta(minutes=3), received_at=created + timedelta(minutes=3),
                next_attempt_at=created + timedelta(minutes=8), status='pending', attempts=2,
                error_code='FIXTURE_TEMPORARY_FAILURE', payload={}))
    db.commit()

port = int(os.environ.get('BILLING_FIXTURE_PORT', '18091'))
print(f'Synthetic billing fixture: http://127.0.0.1:{port}/console-test/ (username: admin)', flush=True)
print(f'BILLING_FIXTURE_CONTROLS={controls}', flush=True)
if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host=os.environ.get('BILLING_FIXTURE_HOST', '127.0.0.1'), port=port,
        access_log=False, log_level='warning')
