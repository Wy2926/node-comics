"""Disposable full administration fixture; all data and credentials are synthetic.

Run from backend: .venv/Scripts/python.exe tests/manual_admin_completion_server.py
No worker or payment synchronizer is started, and outbound provider calls are blocked.
"""
import os
os.environ['STRIPE_ENABLED'] = 'false'
os.environ['CREEM_ENABLED'] = 'false'
from manual_admin_server import app, directory, port, session_factory, controls
import json
from fnmatch import fnmatch
from fastapi.responses import JSONResponse
from datetime import timedelta
from io import BytesIO
from PIL import Image
from sqlalchemy import select
from app.models import User, Asset, Job, Provider, now
from app.providers import ProviderConfig
from app.assets import create_asset
from app.results import publish_result, ResultAccess
from app.reader_api import Feedback
from app.billing_catalog import initialize_catalog
from app.billing_models import (BillingAccount, BillingCustomer, BillingCheckout, BillingSubscription, BillingInvoice,
    BillingTerm, BillingPriceBinding, BillingOrder, BillingEvent, BillingRefund, BillingDispute)
from app.entitlement_models import QuotaPeriod
from app.health_models import ServiceHeartbeat
from app.upload_models import UploadReservation
from app.translation_requests import TranslationRequest
from app import creem_client, stripe_client


@app.middleware('http')
async def ambiguous_receipt(request, call_next):
    response = await call_next(request)
    state = json.loads(controls.read_text(encoding='utf-8'))
    pattern = state.get('lose_receipt')
    if pattern and request.method in ('POST', 'PATCH') and fnmatch(request.url.path, pattern):
        state.pop('lose_receipt')
        state['committed_status'] = response.status_code
        controls.write_text(json.dumps(state), encoding='utf-8')
        if response.status_code < 300:
            return JSONResponse({'error': {'code': 'FIXTURE_LOST_RECEIPT', 'message': '隔离验收：操作已落库，模拟回执丢失'}}, status_code=503)
    return response


def no_provider_calls(*args, **kwargs):
    from app.billing_providers import BillingError
    raise BillingError('FIXTURE_PROVIDER_OFFLINE')


creem_client.call = stripe_client.call = no_provider_calls
from app.config import settings
# Permit local event requeue while every provider network operation stays blocked.
settings().creem_enabled = True
settings().creem_environment = 'test'
os.environ['NC_FIXTURE_IMAGE_KEY'] = 'isolated-image-fixture-key'
with session_factory()() as db:
    at = now()
    initialize_catalog(db)
    admin = User(id='fixture-admin', subject='dev:admin', name='admin', role='admin',
        membership_id='fixture-admin-membership', plus_started_at=at - timedelta(days=1),
        plus_expires_at=at + timedelta(days=30), plus_timezone='UTC', plus_monthly_pages=300)
    db.add(admin)
    reader = db.get(User, '20000000-0000-4000-8000-000000000000')
    config = ProviderConfig(id='fixture-image', label='隔离图片供应商', base_url='https://provider.example/v1',
        model='fixture-image-model', credential_ref='NC_FIXTURE_IMAGE_KEY')
    db.add(Provider(id=config.id, config=config.model_dump(), enabled=True))
    db.flush()
    image = BytesIO()
    Image.new('RGB', (320, 480), '#ded9ef').save(image, 'PNG')
    source = create_asset(db, reader.id, image.getvalue())
    image = BytesIO()
    Image.new('RGB', (320, 480), '#e9e3f8').save(image, 'PNG')
    output = create_asset(db, reader.id, image.getvalue(), kind='classic', parent_id=source.id)
    (directory / 'synthetic-result.png').write_bytes(image.getvalue())
    job = Job(id='fixture-feedback-job', owner_id=reader.id, input_asset_id=source.id, output_asset_id=output.id,
        source_sha256=source.sha256, mode='classic', target_language='zh-Hans', status='succeeded', phase='completed',
        idempotency_key='fixture-complete', operation='fixture', request_hash='1' * 64, cache_key='1' * 64,
        config={}, quota_pages=0, quota_kind='classic_unlimited', settlement='included', completed_at=at)
    unknown = Job(id='fixture-unknown-job', owner_id=reader.id, input_asset_id=source.id,
        source_sha256=source.sha256, mode='redraw', target_language='zh-Hans', status='outcome_unknown', phase='outcome_unknown',
        idempotency_key='fixture-unknown', operation='fixture', request_hash='2' * 64, cache_key='2' * 64,
        config={}, quota_pages=0, quota_kind='classic_unlimited', settlement='included', unknown_since=at)
    db.add_all([job, unknown])
    db.flush()
    publish_result(db, job)
    db.add(TranslationRequest(owner_id=reader.id, id='11111111-1111-4111-8111-111111111111', job_id=job.id,
        request_hash='4' * 64, descriptor={}))
    db.flush()
    db.add(Feedback(id='fixture-feedback', owner_id=reader.id, job_id=job.id, translation_id='11111111-1111-4111-8111-111111111111', output_asset_id=output.id,
        issues=['typesetting'], comment='隔离样例：气泡文字需要调整字号。', idempotency_key='fixture-feedback', request_hash='3' * 64))
    db.add(UploadReservation(id='fixture-upload', job_id=unknown.id, owner_id=reader.id, mode='redraw',
        expected_sha256=source.sha256, expected_size=source.byte_size, mime='image/png', storage_backend='local',
        expires_at=at + timedelta(minutes=5), max_expires_at=at + timedelta(minutes=10)))
    db.add(ServiceHeartbeat(role='control-worker', instance_id='fixture-worker', heartbeat_at=at,
        last_success_at=at, consecutive_failures=0, failure_count=0))
    db.add(BillingAccount(owner_id=reader.id, trial_used_at=at - timedelta(days=10)))
    db.add(BillingCustomer(id='fixture-customer', owner_id=reader.id, provider='creem', environment='test', customer_id='cust_fixture'))
    binding = BillingPriceBinding(id='fixture-binding', price_id='plus-month-v1', provider='creem', environment='test', product_id='prod_fixture')
    db.add(binding)
    db.flush()
    checkout = BillingCheckout(id='fixture-checkout', owner_id=reader.id, environment='test', provider='creem',
        price_id='plus-month-v1', binding_id=binding.id, customer_id='cust_fixture', return_url='https://example.invalid/',
        trial=False, status='completed', session_id='ch_fixture', expires_at=at)
    db.add(checkout)
    db.flush()
    sub = BillingSubscription(id='creem:test:sub_fixture', owner_id=reader.id, checkout_id=checkout.id,
        environment='test', provider='creem', customer_id='cust_fixture', price_id='plus-month-v1', binding_id=binding.id,
        status='active', paid_starts_at=at-timedelta(days=2), paid_ends_at=at+timedelta(days=28), next_billed_at=at+timedelta(days=28))
    db.add(sub)
    db.flush()
    invoice = BillingInvoice(id='creem:test:tx_fixture', subscription_id=sub.id, currency='usd', total=999)
    order = BillingOrder(id='fixture-order', owner_id=reader.id, provider='creem', environment='test',
        checkout_id=checkout.id, subscription_id=sub.id, price_id=sub.price_id, binding_id=binding.id,
        external_id='tx_fixture', kind='initial', status='partially_refunded', currency='usd', subtotal=999, total=999, refunded_total=200)
    db.add_all([invoice, order])
    db.flush()
    term = BillingTerm(id='fixture-term', owner_id=reader.id, subscription_id=sub.id, price_id=sub.price_id,
        invoice_id=invoice.id, kind='paid', starts_at=at-timedelta(days=2), ends_at=at+timedelta(days=28))
    db.add(term)
    db.flush()
    db.add(QuotaPeriod(id='fixture-subscription-quota', owner_id=reader.id, billing_term_id=term.id, kind='redraw_monthly',
        mode='redraw', source='subscription', source_key='fixture-term:0', starts_at=term.starts_at, ends_at=term.ends_at, granted=300))
    event = BillingEvent(id='creem:test:evt_fixture', environment='test', provider='creem', event_type='refund.created',
        resource_id='refund_fixture', payload={'transaction_id': 'tx_fixture'}, occurred_at=at, status='pending',
        attempts=3, error_code='FIXTURE_PROVIDER_OFFLINE', next_attempt_at=at + timedelta(hours=1))
    db.add(event)
    db.flush()
    db.add(BillingRefund(id='fixture-refund', order_id=order.id, provider='creem', environment='test',
        external_id='refund_fixture', transaction_id='tx_fixture', currency='usd', amount=200, status='succeeded',
        occurred_at=at, observed_at=at, event_id=event.id))
    db.commit()

print(f'ADMIN_COMPLETION_IMAGE={directory / "synthetic-result.png"}', flush=True)
if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=port, access_log=False, log_level='warning')
