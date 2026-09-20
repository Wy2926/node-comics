"""Stripe failures, refund mappings and disputes through its real SDK transport."""
import time
import pytest
from sqlalchemy import func, select
from test_stripe_billing import billing, complete_trial, invoice, periods, rights, signed_event


def notify(state, event_id, event_type, resource):
    value = {'id': event_id, 'object': 'event', 'type': event_type, 'livemode': False,
        'created': int(time.time()), 'data': {'object': resource}}
    body, headers = signed_event(value)
    response = state['client'].post('/webhooks/stripe', content=body, headers=headers)
    assert response.status_code == 200, response.text


def settled_invoice(state):
    from app.billing_sync import sync_subscription
    complete_trial(state)
    value = invoice(state)
    state['sub']['status'] = 'active'
    sync_subscription('sub_fixture')
    return value


def refundable_charge(state, *, modern, disputed=False, partial=False):
    value = {'id': 'ch_fixture', 'object': 'charge', 'livemode': False, 'customer': 'cus_fixture',
        'payment_intent': 'pi_fixture', 'amount': 999, 'amount_refunded': 499 if partial else 0 if disputed else 999,
        'refunded': not partial and not disputed, 'disputed': disputed}
    if not modern:
        value['invoice'] = 'in_0001'
    state['charges']['ch_fixture'] = value
    state['invoice_payments'] = [{'id': 'inpay_fixture', 'object': 'invoice_payment', 'livemode': False,
        'invoice': 'in_0001', 'status': 'paid', 'payment': {'type': 'payment_intent', 'payment_intent': 'pi_fixture'}}]
    return value


def test_failed_invoice_is_visible_and_later_settlement_grants_once(billing):
    from app.db import session_factory
    from app.billing_models import BillingEvent, BillingInvoice, BillingOrder, BillingOrderTransition
    complete_trial(billing)
    value = invoice(billing, status='open')
    value.update(attempted=True, attempt_count=1)
    billing['sub']['status'] = 'past_due'
    notify(billing, 'evt_failedinvoice', 'invoice.payment_failed', value)
    with session_factory()() as db:
        order = db.scalar(select(BillingOrder).where(BillingOrder.external_id == value['id']))
        assert order.status == 'failed' and order.paid_at is None
        order_id = order.id
        assert db.get(BillingEvent, 'stripe:test:evt_failedinvoice').status == 'processed'
    assert [period.granted for period in periods()] == [30]
    value.update(status='paid', amount_remaining=0, attempted=True, attempt_count=2)
    billing['sub']['status'] = 'active'
    for _ in range(2):
        notify(billing, 'evt_paidinvoice', 'invoice.paid', value)
    with session_factory()() as db:
        assert db.get(BillingEvent, 'stripe:test:evt_paidinvoice').status == 'processed'
        order = db.get(BillingOrder, order_id)
        assert order.status == 'paid' and order.paid_at is not None
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 1
        assert db.scalar(select(func.count()).select_from(BillingOrder).where(BillingOrder.external_id == value['id'])) == 1
        assert list(db.scalars(select(BillingOrderTransition.to_status).where(BillingOrderTransition.order_id == order_id)
            .order_by(BillingOrderTransition.created_at))) == ['failed', 'paid']
    assert sorted(period.granted for period in periods()) == [30, 300]


def test_unattempted_open_invoice_stays_pending_without_grant(billing):
    from app.db import session_factory
    from app.billing_models import BillingOrder
    from app.billing_sync import sync_subscription
    complete_trial(billing)
    value = invoice(billing, status='open')
    value.update(attempted=False, attempt_count=0)
    sync_subscription('sub_fixture')
    with session_factory()() as db:
        assert db.scalar(select(BillingOrder).where(BillingOrder.external_id == value['id'])).status == 'pending'
    assert [period.granted for period in periods()] == [30]


@pytest.mark.parametrize('modern', [False, True])
@pytest.mark.parametrize('refund_kind', ['full', 'partial', 'dispute'])
def test_signed_refunds_map_invoice_and_keep_access_rules_on_replay(billing, modern, refund_kind):
    from app.db import session_factory
    from app.billing_models import BillingEvent, BillingInvoice, BillingOrder, BillingOrderTransition, BillingTerm
    from app.billing_sync import sync_subscription
    settled_invoice(billing)
    charge = refundable_charge(billing, modern=modern, disputed=refund_kind == 'dispute', partial=refund_kind == 'partial')
    kind = 'charge.dispute.created' if refund_kind == 'dispute' else 'charge.refunded'
    resource = {'id': 'dp_fixture', 'object': 'dispute', 'charge': charge['id']} if refund_kind == 'dispute' else charge
    for _ in range(2):
        notify(billing, 'evt_reversal', kind, resource)
    # Re-reading a paid invoice after its charge was refunded cannot erase the reversal.
    sync_subscription('sub_fixture')
    expected = {'full': 'refunded', 'partial': 'partially_refunded', 'dispute': 'disputed'}[refund_kind]
    with session_factory()() as db:
        event = db.get(BillingEvent, 'stripe:test:evt_reversal')
        assert event.status == 'processed' and event.attempts == 1
        order = db.scalar(select(BillingOrder).where(BillingOrder.external_id == 'in_0001'))
        assert order.status == expected
        term = db.scalar(select(BillingTerm).where(BillingTerm.invoice_id == 'stripe:test:in_0001'))
        assert (term.revoked_at is not None) is (refund_kind != 'partial')
        assert db.scalar(select(func.count()).select_from(BillingInvoice)) == 1
        assert db.scalar(select(func.count()).select_from(BillingOrderTransition).where(
            BillingOrderTransition.order_id == order.id, BillingOrderTransition.to_status == expected)) == 1
    assert rights(billing)['plan'] == ('plus' if refund_kind == 'partial' else 'free')
    assert any(path == '/v1/charges/ch_fixture' for _, path, _, _ in billing['requests'])
    mappings = [params for _, path, params, _ in billing['requests'] if path == '/v1/invoice_payments']
    assert bool(mappings) is modern
    if modern:
        assert all(params == {'payment[type]': 'payment_intent', 'payment[payment_intent]': 'pi_fixture', 'limit': '100'}
            for params in mappings)


@pytest.mark.parametrize('invalid', ['missing_intent', 'ambiguous_invoice', 'wrong_customer', 'wrong_environment'])
def test_unbound_refund_stays_pending_without_revoking_other_payment(billing, invalid):
    from app.db import session_factory
    from app.billing_models import BillingEvent, BillingOrder, BillingTerm
    settled_invoice(billing)
    charge = refundable_charge(billing, modern=True)
    if invalid == 'missing_intent':
        charge.pop('payment_intent')
    elif invalid == 'ambiguous_invoice':
        billing['invoice_payments'].append({**billing['invoice_payments'][0], 'id': 'inpay_other', 'invoice': 'in_other'})
    elif invalid == 'wrong_customer':
        charge['customer'] = 'cus_other'
    else:
        charge['livemode'] = True
    # The signed event can be valid while the independently fetched resource is not.
    notify(billing, 'evt_unboundrefund', 'refund.created', {'id': 're_fixture', 'object': 'refund', 'charge': 'ch_fixture'})
    with session_factory()() as db:
        event = db.get(BillingEvent, 'stripe:test:evt_unboundrefund')
        assert event.status == 'pending' and event.error_code
        assert db.scalar(select(BillingOrder).where(BillingOrder.external_id == 'in_0001')).status == 'paid'
        assert db.scalar(select(BillingTerm).where(BillingTerm.invoice_id == 'stripe:test:in_0001')).revoked_at is None
    assert rights(billing)['plan'] == 'plus'
    if invalid == 'missing_intent':
        assert not any(path == '/v1/invoice_payments' for _, path, _, _ in billing['requests'])


def test_delayed_partial_refund_cannot_overwrite_newer_full_refund(billing, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event, current_thread
    from app import stripe_refunds
    from app.billing_models import BillingOrder
    from app.db import session_factory
    settled_invoice(billing)
    charge = refundable_charge(billing, modern=False, partial=True)
    before_lock, resume = Event(), Event()
    original_lock = stripe_refunds.locked_user

    def delayed_lock(db, owner_id):
        if current_thread().name.startswith('old-refund'):
            before_lock.set()
            assert resume.wait(10)
        return original_lock(db, owner_id)

    monkeypatch.setattr(stripe_refunds, 'locked_user', delayed_lock)
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix='old-refund') as pool:
        old = pool.submit(stripe_refunds.sync_refund_event, {'charge_id': 'ch_fixture'}, 'evt_oldpartial')
        try:
            assert before_lock.wait(10)
            charge.update(refunded=True, amount_refunded=999)
            stripe_refunds.sync_refund_event({'charge_id': 'ch_fixture'}, 'evt_newfull')
        finally:
            resume.set()
        old.result(timeout=10)
    with session_factory()() as db:
        assert db.scalar(select(BillingOrder).where(BillingOrder.external_id == 'in_0001')).status == 'refunded'
    assert rights(billing)['plan'] == 'free'
