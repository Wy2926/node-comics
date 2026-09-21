"""Administrative payment recovery, event leases and real per-reversal records, using isolated transports."""
from datetime import timedelta
import pytest
from sqlalchemy import func, select
from conftest import login
from test_billing_admin import administrator, order_data
from test_creem_billing import creem_billing, complete, transaction, signed_event, rights, periods
from test_stripe_billing import billing, complete_trial, invoice


def test_historical_reconcile_targets_selected_checkout_not_owners_latest(client, administrator, order_data, monkeypatch):
    from app.db import session_factory
    from app.billing_models import BillingCheckout
    from app import billing_sync, billing_checkout
    from app import stripe_refunds
    with session_factory()() as db:
        db.get(BillingCheckout, 'checkout-0').session_id = 'cs_old'
        db.get(BillingCheckout, 'checkout-1').session_id = 'ch_new'
        db.commit()
    calls = []
    monkeypatch.setattr(billing_sync, 'sync_session', lambda value, provider: calls.append((value, provider)))
    monkeypatch.setattr(billing_checkout, 'sync_owner', lambda *_: pytest.fail('owner-wide sync must not be used'))
    monkeypatch.setattr(stripe_refunds, 'sync_invoice_reversals', lambda value: calls.append(('invoice', value)))
    response = client.post('/v1/admin/billing/orders/order-0/reconcile', headers=administrator, json={})
    assert response.status_code == 200, response.text
    assert calls == [('cs_old', 'stripe'), ('invoice', 'remote_0')]


def test_historical_reconcile_targets_selected_subscription_and_transaction(client, administrator, order_data, monkeypatch):
    from app.db import session_factory
    from app.billing_models import BillingOrder, BillingSubscription
    from app import billing_sync
    with session_factory()() as db:
        order = db.get(BillingOrder, 'order-1')
        sub = BillingSubscription(id='creem:test:sub_selected', owner_id=order.owner_id, checkout_id=order.checkout_id,
            environment=order.environment, provider=order.provider, customer_id='cust_selected', price_id=order.price_id,
            binding_id=order.binding_id, status='canceled')
        db.add(sub)
        db.flush()
        order.subscription_id = sub.id
        db.commit()
    calls = []
    monkeypatch.setattr(billing_sync, 'sync_subscription', lambda *args, **kwargs: calls.append((args, kwargs)))
    response = client.post('/v1/admin/billing/orders/order-1/reconcile', headers=administrator, json={})
    assert response.status_code == 200, response.text
    assert calls == [(('creem:test:sub_selected', 'remote_1'), {'provider': 'creem'})]


def test_reconcile_environment_and_unbound_checkout_fail_without_external_requests(client, administrator, order_data, monkeypatch):
    from app.db import session_factory
    from app.billing_models import BillingOrder
    from app.admin_audit import AdminAudit
    from app import billing_sync
    monkeypatch.setattr(billing_sync, 'sync_session', lambda *_a, **_kw: pytest.fail('must not call remote'))
    response = client.post('/v1/admin/billing/orders/order-0/reconcile', headers=administrator, json={})
    assert response.status_code == 409 and response.json()['error']['code'] == 'BILLING_CHECKOUT_UNBOUND'
    with session_factory()() as db:
        db.get(BillingOrder, 'order-0').environment = 'live'
        db.commit()
    assert client.post('/v1/admin/billing/orders/order-0/reconcile', headers=administrator, json={}).status_code == 409
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.action == 'billing.order.reconcile_failed')) == 2


def event_fixture(client, **overrides):
    from app.db import session_factory
    from app.billing_models import BillingEvent
    from app.models import now
    with session_factory()() as db:
        values = dict(id='creem:test:evt_retry', provider='creem', environment='test', event_type='refund.created',
            resource_id='ref_retry', payload={'transaction_id': 'remote_1', 'customer': 'private@example.invalid'},
            occurred_at=now(), status='pending', attempts=2, error_code='CREEM_UNAVAILABLE', next_attempt_at=now() + timedelta(minutes=2))
        values.update(overrides)
        db.add(BillingEvent(**values))
        db.commit()
    return '/v1/admin/billing/events/creem:test:evt_retry'


def test_event_search_detail_permissions_and_no_raw_payload(client, administrator, order_data):
    path = event_fixture(client)
    assert client.get(path).status_code == 401
    assert client.get(path, headers=login(client, 'ordinary-reader')).status_code == 403
    response = client.get('/v1/admin/billing/events', headers=administrator,
        params={'provider': 'creem', 'environment': 'test', 'error_only': True, 'q': 'evt_retry', 'page_size': 1})
    assert response.status_code == 200 and response.json()['total'] == 1
    detail = client.get(path, headers=administrator)
    assert detail.json()['references'] == {'transaction_id': 'remote_1'}
    assert [item['id'] for item in detail.json()['orders']] == ['order-1']
    assert 'private@example.invalid' not in detail.text and 'payload' not in detail.text
    assert client.get('/v1/admin/billing/events', headers=administrator,
        params={'received_from': '2026-09-22', 'received_to': '2026-09-21'}).status_code == 422


def test_event_retry_is_audited_idempotent_and_rate_limited(client, administrator, monkeypatch):
    from app import billing_providers
    from app.db import session_factory
    from app.admin_audit import AdminAudit
    from app.billing_models import BillingEvent
    monkeypatch.setattr(billing_providers, 'provider_enabled', lambda _: True)
    path = event_fixture(client)
    body = {'expected_attempts': 2, 'operation_key': 'retry-operation-1', 'note': '已核对交易绑定'}
    assert client.post(path + '/retry', headers=administrator, json={**body, 'note': ' '}).status_code == 422
    for _ in range(2):
        response = client.post(path + '/retry', headers=administrator, json=body)
        assert response.status_code == 200 and response.json()['queued']
    for changes in ({'note': '改为另一项操作'}, {'expected_attempts': 3}):
        assert client.post(path + '/retry', headers=administrator, json={**body, **changes}).status_code == 409
    assert client.post(path + '/retry', headers=administrator,
        json={**body, 'operation_key': 'retry-operation-2'}).status_code == 409
    with session_factory()() as db:
        event = db.get(BillingEvent, 'creem:test:evt_retry')
        assert event.attempts == 2 and event.status == 'pending'
        audits = list(db.scalars(select(AdminAudit).where(AdminAudit.action == 'billing.event.retry')))
        assert len(audits) == 1 and audits[0].note == body['note'] and audits[0].before['attempts'] == 2
        event.status, event.attempts = 'processed', 3
        # Simulate another accepted operation having replaced the optimization field.
        event.last_retry_key = 'some-later-operation'
        db.commit()
    replay = client.post(path + '/retry', headers=administrator, json=body)
    assert replay.status_code == 200 and replay.json()['status'] == 'processed' and not replay.json()['queued']
    with session_factory()() as db:
        assert db.get(BillingEvent, 'creem:test:evt_retry').status == 'processed'
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.action == 'billing.event.retry')) == 1


@pytest.mark.parametrize('state,offset,expected', [('processed', -1, 409), ('processing', 5, 409), ('processing', -1, 200)])
def test_event_retry_honors_processing_lease(client, administrator, monkeypatch, state, offset, expected):
    from app import billing_providers
    from app.models import now
    monkeypatch.setattr(billing_providers, 'provider_enabled', lambda _: True)
    path = event_fixture(client, status=state, next_attempt_at=now() + timedelta(minutes=offset))
    response = client.post(path + '/retry', headers=administrator,
        json={'expected_attempts': 2, 'operation_key': 'retry-lease-123', 'note': '恢复过期处理'})
    assert response.status_code == expected


def test_event_retry_rejects_stale_attempts_and_wrong_environment(client, administrator, monkeypatch):
    from app import billing_providers
    monkeypatch.setattr(billing_providers, 'provider_enabled', lambda _: True)
    path = event_fixture(client)
    body = {'expected_attempts': 1, 'operation_key': 'retry-stale-123', 'note': '重试'}
    assert client.post(path + '/retry', headers=administrator, json=body).status_code == 409
    monkeypatch.setattr(billing_providers, 'provider_environment', lambda _: 'live')
    assert client.post(path + '/retry', headers=administrator, json={**body, 'expected_attempts': 2}).status_code == 409


def paid_creem(state):
    from app.creem_billing_sync import sync_subscription
    complete(state, trial=False)
    value = transaction(state)
    sync_subscription('sub_fixture')
    return value


def send_reversal(state, transaction_id, refund_id, amount, *, event_id, currency='USD', status='succeeded', kind='refund.created'):
    obj = {'id': refund_id, 'object': kind.split('.')[0], 'mode': 'test', 'transaction': transaction_id,
        'customer': {'email': 'never-store@example.invalid'}, 'status': status}
    obj.update({'refund_amount': amount, 'refund_currency': currency} if kind == 'refund.created' else {'amount': amount, 'currency': currency})
    body, headers = signed_event(state, kind, obj, event_id)
    response = state['client'].post('/webhooks/creem', content=body, headers=headers)
    assert response.status_code == 200, response.text


def test_two_partial_refunds_keep_both_records_and_cumulative_total(creem_billing, administrator):
    from app.db import session_factory
    from app.billing_models import BillingRefund, BillingOrder, BillingEvent
    state = creem_billing
    value = paid_creem(state)
    value.update(status='partially_refunded', refunded_amount=500)
    for _ in range(2):
        send_reversal(state, value['id'], 'ref_first', 200, event_id='evt_first')
        send_reversal(state, value['id'], 'ref_second', 300, event_id='evt_second')
    with session_factory()() as db:
        refunds = list(db.scalars(select(BillingRefund).order_by(BillingRefund.amount)))
        assert [row.amount for row in refunds] == [200, 300]
        order = db.scalar(select(BillingOrder))
        assert order.status == 'partially_refunded' and order.refunded_total == 500
        order_id = order.id
        assert all('never-store' not in str(event.payload) for event in db.scalars(select(BillingEvent)))
    detail = state['client'].get(f'/v1/admin/billing/orders/{order_id}', headers=administrator).json()
    assert detail['refund_summary'] == {'reported_total': 500, 'recorded_succeeded_total': 500, 'currency': 'usd', 'details_complete': True}
    assert rights(state)['plan'] == 'plus' and len(periods()) == 1


def test_sparse_refund_is_unknown_and_currency_mismatch_stays_retryable(creem_billing, administrator):
    from app.db import session_factory
    from app.billing_models import BillingRefund, BillingEvent
    state = creem_billing
    value = paid_creem(state)
    value.update(status='partialRefund', refunded_amount=400)
    send_reversal(state, value['id'], 'ref_sparse', None, currency=None, status=None, event_id='evt_sparse')
    send_reversal(state, value['id'], 'ref_bad', 100, currency='EUR', event_id='evt_bad')
    with session_factory()() as db:
        refund = db.scalar(select(BillingRefund))
        assert refund.amount is None and refund.currency is None and refund.status == 'unknown'
        assert db.scalar(select(func.count()).select_from(BillingRefund)) == 1
        event = db.get(BillingEvent, 'creem:test:evt_bad')
        assert event.status == 'pending' and event.error_code == 'BILLING_REVERSAL_CURRENCY_MISMATCH'


def test_dispute_records_original_transaction_and_late_payment_does_not_restore_access(creem_billing, administrator):
    from app.db import session_factory
    from app.billing_models import BillingDispute, BillingOrder
    from app.creem_billing_sync import sync_subscription
    state = creem_billing
    value = paid_creem(state)
    value['status'] = 'chargeback'
    send_reversal(state, value['id'], 'disp_one', 999, event_id='evt_dispute', status=None, kind='dispute.created')
    assert rights(state)['plan'] == 'free'
    value['status'] = 'paid'
    sync_subscription('sub_fixture')
    assert rights(state)['plan'] == 'free'
    with session_factory()() as db:
        row = db.scalar(select(BillingDispute))
        assert row.amount == 999 and row.transaction_id == value['id'] and row.status == 'unknown'
        assert db.scalar(select(BillingOrder)).status == 'disputed'


def test_subscription_customer_invoice_term_trace_is_paginated_and_private(creem_billing, administrator):
    state = creem_billing
    state['price_id'] = 'creem-year'
    paid_creem(state)
    client = state['client']
    result = client.get('/v1/admin/billing/subscriptions', headers=administrator,
        params={'owner_id': state['owner'], 'provider': 'creem', 'page_size': 1}).json()
    assert result['total'] == 1
    sub = result['items'][0]
    path = '/v1/admin/billing/subscriptions/' + sub['id']
    assert client.get(path, headers=state['auth']).status_code == 403
    detail = client.get(path, headers=administrator).json()
    assert detail['checkout']['session_id'] and 'checkout_url' not in detail['checkout']
    receipts = client.get(path + '/invoices', headers=administrator, params={'page_size': 1}).json()
    assert receipts['total'] == 1 and receipts['items'][0]['total'] == 9999
    terms = client.get(path + '/terms', headers=administrator, params={'page_size': 1}).json()
    assert terms['total'] == 1 and len(terms['items'][0]['quota_periods']) == 12
    assert terms['items'][0]['invoice_id'] == receipts['items'][0]['id']
    customers = client.get('/v1/admin/billing/customers', headers=administrator, params={'q': 'cust_fixture'}).json()
    assert customers['total'] == 1 and customers['items'][0]['owner_id'] == state['owner']
    account = client.get('/v1/admin/billing/accounts/' + state['owner'], headers=administrator).json()
    assert account['trial_used_at'] and not account['trial_available']


def test_catalog_mutations_record_actor_and_exact_changes(client, administrator):
    from app.db import session_factory
    from app.admin_audit import AdminAudit
    body = {'id': 'audit-plan', 'revision_id': 'audit-plan-v1', 'name': 'Audit',
        'monthly_redraw_pages': 20, 'trial_days': 0, 'trial_redraw_pages': 0}
    for _ in range(2):
        assert client.post('/v1/admin/billing/products', headers=administrator, json=body).status_code == 200
    with session_factory()() as db:
        rows = list(db.scalars(select(AdminAudit).where(AdminAudit.action == 'billing.product.create')))
        assert len(rows) == 1 and rows[0].after == body and rows[0].actor_id


def test_stripe_refund_pages_and_dispute_replay_keep_per_record_details(billing):
    from app.billing_sync import sync_subscription
    from app.stripe_refunds import sync_refund_event, sync_invoice_reversals
    from app.db import session_factory
    from app.billing_models import BillingRefund, BillingDispute, BillingOrder
    state = billing
    complete_trial(state)
    receipt = invoice(state, start=state['at'] + 7 * 86400)
    state['sub']['status'] = 'active'
    sync_subscription('sub_fixture')
    receipt['charge'] = 'ch_refund'
    charge = {'id': 'ch_refund', 'object': 'charge', 'invoice': receipt['id'], 'livemode': False,
        'customer': 'cus_fixture', 'currency': 'usd', 'amount': 999, 'amount_refunded': 300,
        'refunded': False, 'disputed': False}
    state['charges']['ch_refund'] = charge
    for index, status in enumerate(('succeeded', 'succeeded', 'pending'), 1):
        state['refunds'][f're_{index}'] = {'id': f're_{index}', 'object': 'refund', 'charge': charge['id'],
            'currency': 'usd', 'amount': index * 100, 'status': status, 'created': state['at']}
    for _ in range(2):
        sync_refund_event({'charge_id': charge['id'], 'refund_id': 're_1'}, 'stripe:test:evt_refund')
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingRefund)) == 3
        order = db.scalar(select(BillingOrder).where(BillingOrder.external_id == receipt['id']))
        assert order.status == 'partially_refunded' and order.refunded_total == 300
    assert len([row for row in state['requests'] if row[1] == '/v1/refunds' and row[2].get('starting_after')]) == 2
    charge['disputed'] = True
    state['disputes']['du_one'] = {'id': 'du_one', 'object': 'dispute', 'charge': charge['id'],
        'livemode': False, 'amount': 999, 'currency': 'usd', 'status': 'needs_response', 'created': state['at']}
    sync_invoice_reversals(receipt['id'])
    # A won dispute updates its record without silently restoring revoked access.
    charge['disputed'] = False
    state['disputes']['du_one']['status'] = 'won'
    sync_refund_event({'charge_id': charge['id'], 'dispute_id': 'du_one'}, 'stripe:test:evt_closed')
    with session_factory()() as db:
        assert db.scalar(select(BillingDispute)).status == 'won'
        assert db.scalar(select(BillingOrder).where(BillingOrder.external_id == receipt['id'])).status == 'disputed'


def test_refund_late_or_sparse_status_cannot_erase_verified_success(creem_billing):
    from app.db import session_factory
    from app.billing_models import BillingRefund
    state = creem_billing
    value = paid_creem(state)
    value.update(status='partialRefund', refunded_amount=200)
    send_reversal(state, value['id'], 'ref_final', 200, event_id='evt_success')
    state['at'] -= timedelta(minutes=1)
    send_reversal(state, value['id'], 'ref_final', 200, status='pending', event_id='evt_old')
    with session_factory()() as db:
        row = db.scalar(select(BillingRefund))
        assert row.amount == 200 and row.status == 'succeeded'


def test_stale_event_worker_cannot_overwrite_a_newer_attempt(client, monkeypatch):
    from app import billing_sync
    from app.db import session_factory
    from app.billing_models import BillingEvent
    from app.models import now
    event_fixture(client, event_type='checkout.completed', resource_id='ch_event', next_attempt_at=now() - timedelta(seconds=1))
    def newer_attempt(*_args, **_kwargs):
        with session_factory()() as db:
            event = db.get(BillingEvent, 'creem:test:evt_retry')
            event.attempts += 1
            event.status, event.error_code = 'pending', 'NEWER_ATTEMPT_ERROR'
            db.commit()
    monkeypatch.setattr(billing_sync, 'sync_session', newer_attempt)
    billing_sync.process_event('creem:test:evt_retry')
    with session_factory()() as db:
        event = db.get(BillingEvent, 'creem:test:evt_retry')
        assert event.status == 'pending' and event.error_code == 'NEWER_ATTEMPT_ERROR' and event.attempts == 4


def test_stripe_installment_refund_is_not_misreported_as_full_invoice_refund(billing):
    from app.billing_sync import sync_subscription
    from app.stripe_refunds import sync_refund_event, sync_invoice_reversals
    from app.db import session_factory
    from app.billing_models import BillingOrder, BillingTerm
    state = billing
    complete_trial(state)
    receipt = invoice(state, start=state['at'] + 7 * 86400)
    state['sub']['status'] = 'active'
    sync_subscription('sub_fixture')
    for index, amount in enumerate((499, 500), 1):
        charge_id = f'ch_part{index}'
        state['charges'][charge_id] = {'id': charge_id, 'object': 'charge', 'invoice': receipt['id'],
            'livemode': False, 'customer': 'cus_fixture', 'currency': 'usd', 'amount': amount,
            'amount_refunded': amount, 'refunded': True, 'disputed': False}
        state['refunds'][f're_part{index}'] = {'id': f're_part{index}', 'object': 'refund', 'charge': charge_id,
            'currency': 'usd', 'amount': amount, 'status': 'succeeded', 'created': state['at']}
        state['invoice_payments'].append({'id': f'inpay_part{index}', 'invoice': receipt['id'],
            'status': 'paid', 'payment': {'type': 'charge', 'charge': charge_id}})
    sync_refund_event({'charge_id': 'ch_part1'}, 'stripe:test:evt_partial')
    with session_factory()() as db:
        order = db.scalar(select(BillingOrder).where(BillingOrder.external_id == receipt['id']))
        assert order.status == 'partially_refunded' and order.refunded_total is None
        assert db.scalar(select(BillingTerm).where(BillingTerm.invoice_id == 'stripe:test:' + receipt['id'])).revoked_at is None
    sync_invoice_reversals(receipt['id'])
    with session_factory()() as db:
        order = db.scalar(select(BillingOrder).where(BillingOrder.external_id == receipt['id']))
        assert order.status == 'refunded' and order.refunded_total == 999


def test_concurrent_manual_retry_only_creates_one_durable_receipt(client, administrator, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from app import billing_providers
    from app.db import session_factory
    from app.admin_audit import AdminAudit
    from app.billing_models import BillingEvent
    monkeypatch.setattr(billing_providers, 'provider_enabled', lambda _: True)
    path = event_fixture(client)
    body = {'expected_attempts': 2, 'operation_key': 'same-concurrent-retry', 'note': '原请求回包恢复'}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(client.post, path + '/retry', headers=administrator, json=body) for _ in range(2)]
        responses = [future.result(timeout=10) for future in futures]
    assert [response.status_code for response in responses] == [200, 200]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.action == 'billing.event.retry')) == 1
        assert db.get(BillingEvent, 'creem:test:evt_retry').attempts == 2
