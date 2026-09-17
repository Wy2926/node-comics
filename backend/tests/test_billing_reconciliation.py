"""Real HTTP adapter + isolated DB: pagination, incremental catch-up and crash replay."""
import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from sqlalchemy import event, func, select

from test_paddle_billing import billing, complete_trial, paid_transaction, rights, SUB, TXN


def history(state, count=65):
    complete_trial(state)
    for index in range(count):
        txn_id = paid_transaction(state, start=state['at'] - timedelta(days=30 * (count-index-1)))
        transaction = state['transactions'].pop(txn_id)
        transaction['id'] = 'txn_' + f'{index:026d}'
        transaction['updated_at'] = (state['at'] - timedelta(minutes=10)).isoformat()+'Z'
        state['transactions'][transaction['id']] = transaction


def test_full_scan_pages_then_incremental_scan_finds_late_completion(billing, monkeypatch):
    from app import billing_sync
    from app.billing_models import BillingSubscription, BillingTransaction
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    history(billing)
    billing_sync.sync_subscription(SUB)
    assert billing['listed_sizes'] == [30, 30, 6]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingTransaction)) == 66
        watermark = db.get(BillingSubscription, SUB).transactions_synced_at
        assert db.scalar(select(func.count()).select_from(QuotaPeriod)) == 65
    # An old transaction becomes completed later; a created_at/id-only cursor
    # would lose it, while updated_at catches it even without a webhook.
    at = watermark + timedelta(minutes=10)
    monkeypatch.setattr(billing_sync, 'now', lambda: at)
    txn_id = paid_transaction(billing, 'z', start=billing['at']+timedelta(days=30))
    billing['transactions'][txn_id].update(created_at=(at-timedelta(days=40)).isoformat()+'Z', updated_at=at.isoformat()+'Z')
    billing['listed_sizes'].clear()
    billing_sync.sync_subscription(SUB)
    # The original trial invoice is inside the overlap, the 65 old invoices aren't.
    assert billing['listed_sizes'] == [2]
    params = [params for _, path, params in billing['requests'] if path == '/transactions'][-1]
    assert params['updated_at[GTE]'] == (watermark-timedelta(minutes=5)).isoformat()+'Z'
    with session_factory()() as db:
        assert db.get(BillingTransaction, txn_id) is not None
        assert db.scalar(select(func.count()).select_from(QuotaPeriod)) == 66
        assert db.get(BillingSubscription, SUB).transactions_synced_at == at
    billing['listed_sizes'].clear()
    billing_sync.sync_subscription(SUB)
    assert billing['listed_sizes'] == [1]


def test_repeated_snapshot_and_transaction_do_not_revisit_quota(billing):
    from app.billing_sync import sync_subscription, sync_transaction
    from app.db import engine, session_factory
    from app.entitlement_models import QuotaPeriod
    complete_trial(billing)
    txn_id = paid_transaction(billing, start=billing['at'])
    sync_subscription(SUB)
    with session_factory()() as db:
        period = db.scalar(select(QuotaPeriod).where(QuotaPeriod.source_key.startswith('paddle:paid:')))
        period.used, period.reserved = 11, 3
        db.commit()
    statements = []
    def capture(conn, cursor, statement, *args):
        statements.append(statement.lower())
    event.listen(engine(), 'before_cursor_execute', capture)
    try:
        sync_subscription(SUB)
        before = len(billing['requests'])
        sync_transaction(txn_id)
    finally:
        event.remove(engine(), 'before_cursor_execute', capture)
    assert not any('quota_periods' in sql for sql in statements)
    assert not any(sql.startswith(('insert into billing_transactions', 'update billing_transactions')) for sql in statements)
    assert billing['requests'][before:] == [('GET', '/transactions/'+txn_id, {})]
    assert rights(billing)['modes']['redraw']['quota']['available'] == 286


def test_same_timestamp_boundary_and_newer_revision_preserve_usage(billing):
    from app.billing_sync import reconcile_snapshot, sync_subscription
    from app.billing_models import BillingSubscription, BillingTransaction
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    complete_trial(billing)
    txn_id = paid_transaction(billing, start=billing['at'])
    sync_subscription(SUB)
    old = copy.deepcopy(billing['transactions'][txn_id])
    with session_factory()() as db:
        watermark = db.get(BillingSubscription, SUB).transactions_synced_at
        period = db.scalar(select(QuotaPeriod).where(QuotaPeriod.source_key.startswith('paddle:paid:')))
        period.used = 17
        db.commit()
    # Revisions and inclusive timestamp ties must be processed without regranting.
    billing['transactions'][txn_id]['updated_at'] = (watermark+timedelta(seconds=1)).isoformat()+'Z'
    duplicate_period = copy.deepcopy(billing['transactions'][txn_id])
    duplicate_period['id'] = 'txn_'+'x'*26
    billing['transactions'][duplicate_period['id']] = duplicate_period
    sync_subscription(SUB)
    reconcile_snapshot(billing['sub'], [old])
    assert rights(billing)['modes']['redraw']['quota']['available'] == 283
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(QuotaPeriod)) == 1
        assert db.get(BillingTransaction, txn_id).provider_updated_at == watermark+timedelta(seconds=1)
        assert db.get(BillingTransaction, duplicate_period['id']) is not None


def test_partial_page_failure_retries_without_advancing_cursor_or_regranting(billing):
    from app import paddle_client
    from app.billing_sync import sync_subscription
    from app.billing_models import BillingSubscription, BillingTransaction
    from app.db import engine, session_factory
    from app.entitlement_models import QuotaPeriod
    history(billing, 35)
    billing['fail_next_page'] = True
    with pytest.raises(paddle_client.PaddleError):
        sync_subscription(SUB)
    with session_factory()() as db:
        assert db.get(BillingSubscription, SUB).transactions_synced_at is None
        assert db.scalar(select(func.count()).select_from(BillingTransaction)) == 30
        period = db.scalar(select(QuotaPeriod).order_by(QuotaPeriod.starts_at))
        period_id = period.id
        period.used = 9
        db.commit()
    engine().dispose()  # Recovery cannot depend on a process-local cache.
    billing['fail_next_page'] = False
    sync_subscription(SUB)
    with session_factory()() as db:
        assert db.get(BillingSubscription, SUB).transactions_synced_at is not None
        assert db.scalar(select(func.count()).select_from(BillingTransaction)) == 36
        assert db.scalar(select(func.count()).select_from(QuotaPeriod)) == 35
        assert db.get(QuotaPeriod, period_id).used == 9


def test_failed_page_rolls_back_its_grants_and_receipts(billing, monkeypatch):
    from app import billing_sync, paddle_client
    from app.billing_models import BillingTransaction
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    history(billing, 2)
    original = billing_sync.grant_period
    calls = 0
    def fail_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise paddle_client.PaddleError('ISOLATED_FAILURE')
        return original(*args, **kwargs)
    monkeypatch.setattr(billing_sync, 'grant_period', fail_second)
    with pytest.raises(paddle_client.PaddleError):
        billing_sync.sync_subscription(SUB)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingTransaction)) == 0
        assert db.scalar(select(func.count()).select_from(QuotaPeriod)) == 0
    monkeypatch.setattr(billing_sync, 'grant_period', original)
    billing_sync.sync_subscription(SUB)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingTransaction)) == 3
        assert db.scalar(select(func.count()).select_from(QuotaPeriod)) == 2


def test_concurrent_webhook_and_catchup_grant_once(billing):
    from app.billing_sync import sync_subscription, sync_transaction
    from app.billing_models import BillingTransaction
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    complete_trial(billing)
    txn_id = paid_transaction(billing, start=billing['at'])
    with ThreadPoolExecutor(max_workers=3) as pool:
        tasks = [pool.submit(sync_subscription, SUB), pool.submit(sync_transaction, txn_id),
                 pool.submit(sync_subscription, SUB)]
        for task in tasks:
            task.result(timeout=15)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(BillingTransaction)) == 2
        assert db.scalar(select(func.count()).select_from(QuotaPeriod)) == 1
    assert rights(billing)['modes']['redraw']['quota']['available'] == 300


def test_an_older_scan_finishing_last_cannot_regress_progress(billing, monkeypatch):
    from app import billing_sync, paddle_client
    from app.billing_models import BillingSubscription
    from app.db import session_factory
    complete_trial(billing)
    older, newer = billing['at'], billing['at']+timedelta(minutes=10)
    monkeypatch.setattr(billing_sync, 'now', lambda: older)
    pages = paddle_client.transaction_pages
    interleaved = False
    def interleave(**filters):
        nonlocal interleaved
        yield from pages(**filters)
        if not interleaved:
            interleaved = True
            monkeypatch.setattr(billing_sync, 'now', lambda: newer)
            billing_sync.sync_subscription(SUB)
            monkeypatch.setattr(billing_sync, 'now', lambda: older)
    monkeypatch.setattr(paddle_client, 'transaction_pages', interleave)
    billing_sync.sync_subscription(SUB)
    with session_factory()() as db:
        assert db.get(BillingSubscription, SUB).transactions_synced_at == newer


def test_processed_transaction_cannot_be_rebound_by_duplicate_fast_path(billing):
    from app import paddle_client
    from app.billing_sync import sync_subscription, sync_transaction
    complete_trial(billing)
    txn_id = paid_transaction(billing, start=billing['at'])
    sync_subscription(SUB)
    billing['transactions'][txn_id]['subscription_id'] = 'sub_'+'z'*26
    with pytest.raises(paddle_client.PaddleError, match='PADDLE_BINDING_MISMATCH'):
        sync_transaction(txn_id)
    assert rights(billing)['modes']['redraw']['quota']['available'] == 300


@pytest.mark.parametrize('ambiguous', [False, True])
def test_unknown_checkout_searches_beyond_first_page_without_posting_again(billing, ambiguous):
    billing['uncertain'] = True
    client, auth = billing['client'], billing['auth']
    assert client.post('/v1/billing/checkouts', headers=auth).status_code == 503
    for index in range(31):
        transaction = copy.deepcopy(billing['transactions'][TXN])
        transaction['id'] = 'txn_'+f'{index:026d}'
        if not ambiguous or index != 30:
            transaction['custom_data'] = {'app':'node_comics', 'checkout_intent_id':'another-intent'}
        billing['transactions'][transaction['id']] = transaction
    response = client.post('/v1/billing/checkouts', headers=auth)
    assert response.status_code == (409 if ambiguous else 200), response.text
    assert billing['listed_sizes'] == [30, 2]
    assert billing['posts'] == 1
