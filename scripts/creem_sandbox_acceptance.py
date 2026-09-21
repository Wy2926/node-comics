"""Opt-in real Creem TEST acceptance; isolated PostgreSQL and private receipts.

Run with backend/.venv/Scripts/python.exe. No project .env is loaded. Every
remote mutation is journaled before dispatch and cannot be blindly repeated.
See docs/CREEM_SANDBOX_ACCEPTANCE.md for reproducible commands and boundaries.
"""
from argparse import ArgumentParser
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / 'private-test-data' / 'creem-sandbox-20260922'
STATE = PRIVATE / 'state.json'
API = 'https://test-api.creem.io/v1'
API_PORT = 18098
GATEWAY_PORT = 18102
PG_PORT = 55438
CONTAINER = 'nc-creem-sandbox-20260922'
DATABASE = 'nodecomics_creem_sandbox_20260922'


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(path.suffix + '.new')
    pending.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    pending.replace(path)


def state():
    return json.loads(STATE.read_text(encoding='utf-8'))


def key():
    value = dotenv_values(ROOT / 'private-test-data/admin-live/.env.creem').get('CREEM_API_KEY', '')
    if not value.startswith('creem_test_'):
        raise RuntimeError('A Creem test key is required; live keys are forbidden')
    return value


def remote(method, path, *, body=None, params=None, operation=None):
    if not path.startswith('/') or '://' in path:
        raise RuntimeError('Invalid test API path')
    journal = None
    if method != 'GET':
        if not operation or not re.fullmatch(r'[a-z0-9_-]+', operation):
            raise RuntimeError('A unique operation name is required')
        journal = PRIVATE / 'operations' / (operation + '.json')
        if journal.exists():
            previous = json.loads(journal.read_text(encoding='utf-8'))
            if previous['method'] != method or previous['path'] != path or previous['body'] != body:
                raise RuntimeError('Operation body changed; inspect the previous result first')
            if previous.get('status') == 'received':
                return previous['response']
            raise RuntimeError('Previous dispatch may have been accepted; reconcile before a new operation')
        journal.parent.mkdir(parents=True, exist_ok=True)
        with journal.open('x', encoding='utf-8') as stream:
            json.dump({'method': method, 'path': path, 'body': body, 'status': 'dispatched'}, stream)
            stream.flush()
            os.fsync(stream.fileno())
    try:
        response = httpx.request(method, API + path, headers={'x-api-key': key()},
            params=params, json=body, timeout=30, follow_redirects=False)
    except httpx.HTTPError:
        raise RuntimeError('Creem request outcome unknown; do not repeat a write') from None
    if not response.is_success:
        if journal:
            save(journal, {'method': method, 'path': path, 'body': body, 'status': 'http_error',
                'http_status': response.status_code, 'private_response': response.text})
        raise RuntimeError(f'Creem test API returned HTTP {response.status_code}; response omitted')
    value = response.json()
    if not isinstance(value, dict):
        raise RuntimeError('Unexpected Creem response shape')
    if value.get('mode') not in (None, 'test'):
        raise RuntimeError('Creem returned a non-test resource')
    if journal:
        save(journal, {'method': method, 'path': path, 'body': body, 'status': 'received', 'response': value})
    return value


def configure():
    value = state()
    os.environ.update(APP_ENV='test', DEV_AUTH='true', DEV_AUTH_SECRET=value['auth_secret'],
        DEV_ADMIN_USERNAME='sandbox-admin', DATABASE_URL=value['database_url'],
        RESULT_STORAGE_BACKEND='local', STORAGE_PATH=str(PRIVATE / 'objects'),
        STRIPE_ENABLED='false', CREEM_ENABLED='true', CREEM_ENVIRONMENT='test',
        CREEM_API_KEY=key(), CREEM_WEBHOOK_SECRET=value['webhook_secret'],
        CREEM_RETURN_URL=value.get('public_url', 'https://sandbox.example.invalid') + '/account/',
        ADMIN_WEB_PATH='/sandbox-console/', OPENAI_API_KEY='', PROVIDERS_JSON='',
        CLASSIC_ENABLED='false', OIDC_ISSUER='', OIDC_JWKS_URL='', OIDC_AUDIENCE='')
    sys.path.insert(0, str(ROOT / 'backend'))
    from app.config import Settings
    Settings.model_config['env_file'] = None
    from sqlalchemy.engine import make_url
    url = make_url(value['database_url'])
    if url.host != '127.0.0.1' or url.port != PG_PORT or url.database != DATABASE:
        raise RuntimeError('Refusing a database outside the isolated sandbox')
    return value


def initialize():
    if STATE.exists():
        raise RuntimeError('Sandbox already exists; use status/serve without recreating it')
    key()
    PRIVATE.mkdir(parents=True, exist_ok=True)
    password = secrets.token_hex(24)
    environment = PRIVATE / 'postgres.env'
    environment.write_text(f'POSTGRES_USER=nodecomics\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB={DATABASE}\n', encoding='utf-8')
    subprocess.run(['docker', 'run', '--detach', '--name', CONTAINER,
        '--label', 'node-comics.acceptance=creem-sandbox-20260922',
        '--env-file', str(environment), '--publish', f'127.0.0.1:{PG_PORT}:5432',
        '--volume', CONTAINER + ':/var/lib/postgresql/data', 'postgres:17.6-alpine'], check=True, capture_output=True)
    save(STATE, {'database_url': f'postgresql+psycopg://nodecomics:{password}@127.0.0.1:{PG_PORT}/{DATABASE}',
        'auth_secret': secrets.token_hex(32), 'webhook_secret': secrets.token_hex(32), 'products': {},
        'created_at': datetime.now(timezone.utc).isoformat()})
    for _ in range(30):
        result = subprocess.run(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'nodecomics', '-d', DATABASE], capture_output=True)
        if result.returncode == 0:
            break
        time.sleep(1)
    configure()
    from app.db import initialize as migrate
    migrate()
    print('Created independent test database; no existing database was read or reset')


def setup_catalog():
    value = configure()
    products = remote('GET', '/products/search', params={'page_number': 1, 'page_size': 100})['items']
    from app.db import session_factory
    from app.billing_catalog import initialize_catalog
    from app.billing_models import BillingPrice, BillingPriceBinding
    from app.billing_providers import approved_binding
    from app.billing_models import BillingPlanRevision
    from app.models import User, now
    from app.billing_models import BillingAccount
    with session_factory()() as db:
        initialize_catalog(db)
        for interval, amount in (('month', 999), ('year', 9999)):
            selected = {}
            for trial_days in (0, 7):
                matches = [item for item in products if item.get('mode') == 'test'
                    and item.get('name', '').startswith('Node Comics PLUS') and item.get('price') == amount
                    and item.get('currency') == 'USD' and item.get('billing_period') == 'every-' + interval
                    and (item.get('trial_period_days') or 0) == trial_days and item.get('status') == 'active']
                if len(matches) != 1:
                    raise RuntimeError('Expected one explicitly matching test product for each interval/trial')
                selected[str(trial_days)] = matches[0]['id']
            price = db.get(BillingPrice, f'plus-{interval}-v1')
            binding = db.get(BillingPriceBinding, f'sandbox-creem-{interval}')
            if binding is None:
                binding = BillingPriceBinding(id=f'sandbox-creem-{interval}', price_id=price.id,
                    provider='creem', environment='test', product_id=selected['0'], trial_product_id=selected['7'])
                db.add(binding)
            approved_binding(binding, price, db.get(BillingPlanRevision, price.plan_revision_id))
            binding.status, price.status = 'active', 'active'
            value['products'][interval] = selected
        for name in ('sandbox-admin', 'sandbox-paid', 'sandbox-paid-month', 'sandbox-trial'):
            user = db.get(User, name)
            if user is None:
                user = User(id=name, subject='sandbox:' + name, name=name,
                    role='admin' if name == 'sandbox-admin' else 'user')
                db.add(user)
                db.flush()
            if name.startswith('sandbox-paid') and db.get(BillingAccount, name) is None:
                db.add(BillingAccount(owner_id=name, trial_used_at=now()))
        db.commit()
    save(STATE, value)
    print('Four existing test products verified; isolated catalog and acceptance users ready')


def register_webhook(url):
    if not re.fullmatch(r'https://[a-z0-9-]+\.trycloudflare\.com', url):
        raise RuntimeError('Expected the temporary Cloudflare HTTPS origin')
    value = configure()
    from app.billing_api import CREEM_EVENTS
    if value.get('webhook_id'):
        webhook = remote('PATCH', '/webhooks/' + value['webhook_id'],
            operation='update-webhook-' + hashlib.sha256(url.encode()).hexdigest()[:12],
            body={'url': url + '/webhooks/creem'})
        if webhook.get('mode') != 'test':
            raise RuntimeError('Webhook was not verified as test')
        value['public_url'] = url
    else:
        webhook = remote('POST', '/webhooks', operation='create-webhook', body={
            'url': url + '/webhooks/creem', 'delivery_mode': 'http',
            'name': 'Node Comics isolated sandbox 20260922', 'events': sorted(CREEM_EVENTS)})
        if webhook.get('mode') != 'test' or not webhook.get('secret'):
            raise RuntimeError('Webhook was not verified as test with its signing secret')
        value.update(public_url=url, webhook_id=webhook['id'], webhook_secret=webhook['secret'])
    save(STATE, value)
    print('Registered isolated test webhook; secret stored privately. Restart serve to load it.')


def serve(gateway=False):
    value = configure()
    import uvicorn
    if gateway:
        from fastapi import FastAPI, Request
        from fastapi.responses import HTMLResponse, Response
        app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

        @app.post('/webhooks/creem')
        async def proxy(request: Request):
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 262144:
                    return Response(status_code=413)
            body = bytes(body)
            signature = request.headers.get('creem-signature', '')
            # Read the private configuration each time so registration need not
            # expose an endpoint with a temporary verification secret.
            expected = hmac.new(state()['webhook_secret'].encode(), body, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, signature.lower()):
                return Response(status_code=401)
            async with httpx.AsyncClient(timeout=60) as client:
                response = await client.post(f'http://127.0.0.1:{API_PORT}/webhooks/creem', content=body,
                    headers={'creem-signature': signature, 'content-type': 'application/json'})
            if response.is_success:
                event_id = json.loads(body).get('id', '')
                if re.fullmatch(r'evt_[A-Za-z0-9]+', event_id):
                    save(PRIVATE / 'receipts' / (event_id + '.json'), {'body': body.decode(), 'signature': signature})
            return Response(content=response.content, status_code=response.status_code, media_type='application/json')

        @app.get('/payment/success/')
        def success():
            return HTMLResponse('<!doctype html><script>history.replaceState(null,"","/payment/success/")</script>'
                '<title>Creem test completed</title><p>Sandbox checkout returned. Access is verified by signed webhook.</p>',
                headers={'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store'})
        port = GATEWAY_PORT
    else:
        from app.main import app
        from app import creem_client
        original_call = creem_client.call

        def observed_call(method, path, **kwargs):
            # No headers, bodies, customer data or URLs are logged.
            with (PRIVATE / 'provider-reads.jsonl').open('a', encoding='utf-8') as stream:
                stream.write(json.dumps({'method': method, 'path': path,
                    'params': kwargs.get('params'), 'at': datetime.now(timezone.utc).isoformat()}) + '\n')
            return original_call(method, path, **kwargs)
        creem_client.call = observed_call
        from fastapi.responses import RedirectResponse
        from app.billing_sync import run
        stopping = threading.Event()
        threading.Thread(target=run, args=(stopping,), daemon=True).start()

        @app.get('/sandbox/checkout/{scenario}', include_in_schema=False)
        def launch(scenario: str):
            if scenario not in ('paid-year', 'paid-month', 'trial-month'):
                from fastapi import HTTPException
                raise HTTPException(status_code=404)
            checkout = json.loads((PRIVATE / f'checkout-{scenario}.json').read_text(encoding='utf-8'))
            return RedirectResponse(checkout['checkout_url'], status_code=303)
        app.router.routes.insert(0, app.router.routes.pop())
        port = API_PORT
    print(f'Isolated {"webhook gateway" if gateway else "API"} listening on 127.0.0.1:{port}', flush=True)
    uvicorn.run(app, host='127.0.0.1', port=port, access_log=False, log_level='warning')


def checkout(scenario):
    configure()
    from app.billing_checkout import start_checkout
    if scenario not in ('paid-year', 'paid-month', 'trial-month'):
        raise RuntimeError('Unknown acceptance scenario')
    owner = {'trial-month': 'sandbox-trial', 'paid-year': 'sandbox-paid', 'paid-month': 'sandbox-paid-month'}[scenario]
    interval = 'year' if scenario == 'paid-year' else 'month'
    result = start_checkout(owner, f'plus-{interval}-v1', 'creem')
    save(PRIVATE / f'checkout-{scenario}.json', result)
    print(f'Test checkout ready at http://127.0.0.1:{API_PORT}/sandbox/checkout/{scenario}')


def status():
    configure()
    from sqlalchemy import select, func
    from app.db import session_factory
    from app.billing_models import BillingOrder, BillingSubscription, BillingEvent, BillingRefund, BillingTerm
    from app.entitlement_models import QuotaPeriod
    report = {}
    with session_factory()() as db:
        for name, model, fields in (
            ('orders', BillingOrder, ('id', 'owner_id', 'external_id', 'subscription_id', 'status', 'total', 'currency', 'refunded_total')),
            ('subscriptions', BillingSubscription, ('id', 'owner_id', 'status', 'trial_starts_at', 'trial_ends_at', 'paid_starts_at', 'paid_ends_at')),
            ('events', BillingEvent, ('id', 'event_type', 'status', 'attempts', 'error_code')),
            ('refunds', BillingRefund, ('external_id', 'order_id', 'amount', 'currency', 'status')),
            ('terms', BillingTerm, ('id', 'owner_id', 'kind', 'revoked_at'))):
            report[name] = [{field: str(getattr(row, field)) if isinstance(getattr(row, field), datetime)
                else getattr(row, field) for field in fields} for row in db.scalars(select(model))]
        report['quota_bucket_count'] = db.scalar(select(func.count()).select_from(QuotaPeriod))
    save(PRIVATE / 'latest-report.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def reconcile(order_id):
    configure()
    from app.auth import token_for
    from app.models import User
    from app.db import session_factory
    with session_factory()() as db:
        token = token_for(db.get(User, 'sandbox-admin'))
    response = httpx.post(f'http://127.0.0.1:{API_PORT}/v1/admin/billing/orders/{order_id}/reconcile',
        headers={'Authorization': 'Bearer ' + token}, json={}, timeout=60)
    print('RECONCILE_HTTP', response.status_code)
    if not response.is_success:
        print('RECONCILE_ERROR', response.json().get('error', {}).get('code'))
    response.raise_for_status()


def refund(order_id):
    configure()
    from app.db import session_factory
    from app.billing_models import BillingOrder
    with session_factory()() as db:
        order = db.get(BillingOrder, order_id)
        if not order or order.environment != 'test' or order.owner_id != 'sandbox-paid' or order.status != 'paid':
            raise RuntimeError('Only this run\'s paid sandbox order can be refunded')
        transaction_id = order.external_id
    transaction = remote('GET', '/transactions', params={'transaction_id': transaction_id})
    if transaction.get('id') != transaction_id or transaction.get('mode') != 'test' or transaction.get('status') != 'paid':
        raise RuntimeError('Remote test transaction does not match the paid order')
    response = remote('POST', '/refunds', body={'transaction_id': transaction_id}, operation='refund-' + order_id)
    print('SANDBOX_REFUND_STATUS', response.get('status'))


def replay():
    configure()
    receipts = list((PRIVATE / 'receipts').glob('evt_*.json'))
    if not receipts:
        raise RuntimeError('No real signed webhook receipts have arrived')
    for receipt in receipts:
        value = json.loads(receipt.read_text(encoding='utf-8'))
        response = httpx.post(f'http://127.0.0.1:{GATEWAY_PORT}/webhooks/creem', content=value['body'].encode(),
            headers={'creem-signature': value['signature'], 'content-type': 'application/json'}, timeout=60)
        response.raise_for_status()
    print('Replayed original signed webhook receipts:', len(receipts))


def verify():
    configure()
    from sqlalchemy import select, func
    from app.auth import token_for
    from app.db import session_factory
    from app.models import User, now
    from app.billing_models import BillingEvent, BillingOrder, BillingOrderTransition, BillingInvoice, BillingTerm, BillingRefund
    from app.entitlement_models import QuotaPeriod
    evidence = {'checked_at': datetime.now(timezone.utc).isoformat(), 'environment': 'test', 'owners': {}}
    with session_factory()() as db:
        for owner, total, buckets, grant in (('sandbox-paid', 9999, 12, 300),
                ('sandbox-paid-month', 999, 1, 300), ('sandbox-trial', 0, 1, 30)):
            order = db.scalar(select(BillingOrder).where(BillingOrder.owner_id == owner))
            periods = list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.owner_id == owner)))
            assert order is not None and order.status == ('trialing' if total == 0 else 'paid')
            assert order.total == total and order.currency == 'usd'
            assert len(periods) == buckets and all(row.granted == grant for row in periods)
            assert sum(row.starts_at <= now() < row.ends_at for row in periods) == 1
            evidence['owners'][owner] = {'order_total': total, 'currency': 'usd', 'bucket_count': buckets,
                'pages_per_bucket': grant, 'currently_active_buckets': 1}
        events = list(db.scalars(select(BillingEvent)))
        assert events and all(row.status == 'processed' and row.error_code is None for row in events)
        evidence['processed_events'] = len(events)
        token = token_for(db.get(User, 'sandbox-trial'))
    response = httpx.get(f'http://127.0.0.1:{API_PORT}/v1/admin/billing/orders',
        headers={'Authorization': 'Bearer ' + token}, timeout=10)
    assert response.status_code == 403
    evidence['non_admin_denied'] = True
    models = (BillingEvent, BillingOrderTransition, BillingInvoice, BillingTerm, BillingRefund, QuotaPeriod)
    def counts():
        with session_factory()() as db:
            return {model.__tablename__: db.scalar(select(func.count()).select_from(model)) for model in models}
    before = counts()
    replay()
    assert counts() == before
    evidence['duplicate_receipts_preserve_counts'] = before
    # An invalid signature cannot create even a pending event.
    response = httpx.post(f'http://127.0.0.1:{API_PORT}/webhooks/creem', content=b'{}',
        headers={'creem-signature': '0' * 64}, timeout=10)
    assert response.status_code == 401 and counts() == before
    evidence['invalid_signature_denied'] = True
    save(PRIVATE / 'verified-acceptance.json', evidence)
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


def verify_history(order_id):
    configure()
    from datetime import timedelta
    from sqlalchemy import select, delete
    from app.db import session_factory
    from app.models import now, uid
    from app.billing_models import BillingOrder, BillingCheckout
    synthetic_id, sentinel = uid(), 'ch_sandbox_history_sentinel'
    with session_factory()() as db:
        order = db.get(BillingOrder, order_id)
        if not order or order.environment != 'test' or not order.owner_id.startswith('sandbox-'):
            raise RuntimeError('Expected this run\'s sandbox order')
        source = db.get(BillingCheckout, order.checkout_id)
        # A deliberately synthetic, unsubmitted newer local purchase is a guard:
        # selecting this owner\'s latest checkout must never replace the real
        # historical transaction being reconciled. No extra remote POST is made.
        db.add(BillingCheckout(id=synthetic_id, owner_id=order.owner_id, provider='creem',
            environment='test', price_id=source.price_id, binding_id=source.binding_id,
            return_url=source.return_url, trial=False, status='canceled', session_id=sentinel,
            created_at=now() + timedelta(seconds=1), expires_at=now() + timedelta(hours=1)))
        transaction, subscription = order.external_id, order.subscription_id.split(':', 2)[-1]
        db.commit()
    trace = PRIVATE / 'provider-reads.jsonl'
    offset = trace.stat().st_size if trace.exists() else 0
    try:
        reconcile(order_id)
        with trace.open('rb') as stream:
            stream.seek(offset)
            calls = [json.loads(line) for line in stream]
        assert any(row['path'] == '/transactions' and row['params'] == {'transaction_id': transaction} for row in calls)
        assert any(row['path'] == '/subscriptions' and row['params'] == {'subscription_id': subscription} for row in calls)
        assert sentinel not in json.dumps(calls)
        evidence = {'real_transaction_queried': True, 'real_subscription_queried': True,
            'synthetic_newer_checkout_queried': False, 'calls': calls}
        save(PRIVATE / 'verified-history.json', evidence)
        print('Historical order queried its real bound transaction and subscription; newer synthetic checkout untouched')
    finally:
        with session_factory()() as db:
            db.execute(delete(BillingCheckout).where(BillingCheckout.id == synthetic_id))
            db.commit()


def cancel_test_subscriptions():
    configure()
    from sqlalchemy import select
    from app.db import session_factory
    from app.billing_models import BillingSubscription
    from app import creem_client
    from app.billing_sync import sync_subscription
    with session_factory()() as db:
        subscriptions = list(db.scalars(select(BillingSubscription)))
    results = []
    for subscription in subscriptions:
        if subscription.environment != 'test' or subscription.owner_id not in ('sandbox-paid', 'sandbox-paid-month', 'sandbox-trial'):
            raise RuntimeError('Refusing a subscription outside this acceptance run')
        external_id = subscription.id.split(':', 2)[-1]
        current = remote('GET', '/subscriptions', params={'subscription_id': external_id})
        if current.get('mode') != 'test' or current.get('id') != external_id or creem_client.intent_id(current) != subscription.checkout_id:
            raise RuntimeError('Remote test subscription is not bound to this acceptance checkout')
        if current['status'] != 'canceled':
            remote('POST', '/subscriptions/' + external_id + '/cancel', body={'mode': 'immediate', 'onExecute': 'cancel'},
                operation='cancel-' + external_id.lower())
        current = remote('GET', '/subscriptions', params={'subscription_id': external_id})
        if current.get('mode') != 'test' or current.get('status') != 'canceled':
            raise RuntimeError('Test subscription cancellation is not confirmed')
        sync_subscription(external_id, provider='creem')
        results.append({'owner': subscription.owner_id, 'status': 'canceled'})
    save(PRIVATE / 'verified-cancellations.json', results)
    print('Confirmed canceled test subscriptions:', len(results))


def disable_webhook():
    value = configure()
    webhook = remote('GET', '/webhooks/' + value['webhook_id'])
    if webhook.get('mode') != 'test' or webhook.get('url') != value['public_url'] + '/webhooks/creem':
        raise RuntimeError('Refusing to disable a webhook outside this acceptance run')
    remote('PATCH', '/webhooks/' + value['webhook_id'], body={'status': 'disabled'}, operation='disable-webhook')
    webhook = remote('GET', '/webhooks/' + value['webhook_id'])
    if webhook.get('mode') != 'test' or webhook.get('status') != 'disabled':
        raise RuntimeError('Webhook disable was not confirmed')
    save(PRIVATE / 'verified-webhook-disabled.json', {'mode': 'test', 'status': 'disabled'})
    print('Confirmed this run\'s test webhook is disabled')


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('init', 'catalog', 'register-webhook', 'serve', 'gateway', 'checkout', 'status',
        'reconcile', 'refund', 'replay', 'verify', 'verify-history', 'cancel-test-subscriptions', 'disable-webhook'))
    parser.add_argument('--url')
    parser.add_argument('--scenario')
    parser.add_argument('--order-id')
    args = parser.parse_args()
    if args.action == 'init': initialize()
    elif args.action == 'catalog': setup_catalog()
    elif args.action == 'register-webhook': register_webhook(args.url)
    elif args.action == 'serve': serve()
    elif args.action == 'gateway': serve(gateway=True)
    elif args.action == 'checkout': checkout(args.scenario)
    elif args.action == 'status': status()
    elif args.action == 'reconcile': reconcile(args.order_id)
    elif args.action == 'refund': refund(args.order_id)
    elif args.action == 'replay': replay()
    elif args.action == 'verify': verify()
    elif args.action == 'verify-history': verify_history(args.order_id)
    elif args.action == 'cancel-test-subscriptions': cancel_test_subscriptions()
    elif args.action == 'disable-webhook': disable_webhook()


if __name__ == '__main__':
    main()
