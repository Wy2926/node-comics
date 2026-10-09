"""Opt-in isolated permanent-purchase history benchmark; never touches live data."""
import json
import os
from statistics import median
from time import perf_counter
import tracemalloc

import pytest
from sqlalchemy import event, insert, or_, select, text

from app.billing_access import first_purchase
from app.billing_models import BillingOrder
from app.db import engine, session_factory
from app.entitlement_models import QuotaPeriod
from app.entitlements import admission_policy, entitlements_json
from app.models import User, now
from test_quota_purchase_admission import account, cluster, seed_purchase  # noqa: F401

def measure(function, count=15):
    durations = []
    for _ in range(count):
        start = perf_counter()
        function()
        durations.append((perf_counter() - start) * 1000)
    return round(median(durations), 3)


@pytest.mark.skipif(os.environ.get('RUN_QUOTA_SCALE') != '1',
    reason='Opt-in isolated purchase-history latency and memory measurement')
@pytest.mark.parametrize('history_size', [0, 50000])
def test_permanent_history_never_loads_at_admission_or_into_account_response(account, history_size):
    owner = account[2]
    with session_factory()() as db:
        active = seed_purchase(db, owner, pages=1)
        order = db.get(BillingOrder, active.billing_order_id)
        for offset in range(0, history_size, 1000):
            indexes = range(offset, min(history_size, offset + 1000))
            db.execute(insert(BillingOrder), [{'id': f'benchmark-order-{index:020}', 'owner_id': owner,
                'provider': 'stripe', 'environment': 'test', 'price_id': order.price_id, 'binding_id': order.binding_id,
                'external_id': f'benchmark-payment-{index}', 'kind': 'initial', 'status': 'paid', 'currency': 'usd',
                'total': 599, 'paid_at': active.starts_at} for index in indexes])
            db.execute(insert(QuotaPeriod), [{'id': f'benchmark-period-{index:020}', 'owner_id': owner,
                'billing_order_id': f'benchmark-order-{index:020}', 'kind': 'classic_purchase', 'mode': 'classic',
                'source': 'purchase', 'source_key': f'purchase:benchmark-order-{index}:classic',
                'starts_at': active.starts_at, 'granted': 1, 'used': 1, 'reserved': 0} for index in indexes])
        db.commit()
        active_id = active.id
        db.execute(text('ANALYZE'))
        db.commit()
    statements = []
    def record(connection, cursor, statement, parameters, context, many):
        if statement.lstrip().startswith('SELECT'):
            statements.append((statement, parameters))
    at = now()
    with session_factory()() as db:
        user = db.get(User, owner)
        first_purchase(db, owner, at)  # Compile/warm up before measuring.
        event.listen(engine(), 'before_cursor_execute', record)
        try:
            policy = admission_policy(db, user, at=at)
        finally:
            event.remove(engine(), 'before_cursor_execute', record)
        assert policy.period.id == active_id
        selector = next((sql, params) for sql, params in statements if 'JOIN billing_orders' in sql)
        assert 'LIMIT' in selector[0] and 'quota_periods.granted > quota_periods.used + quota_periods.reserved' in selector[0]
        if db.get_bind().dialect.name == 'sqlite':
            plan = db.connection().exec_driver_sql('EXPLAIN QUERY PLAN ' + selector[0], selector[1]).all()
            if history_size:
                assert any('ix_quota_purchase_available' in str(row) for row in plan), plan
        elif history_size:
            plan = db.connection().exec_driver_sql('EXPLAIN (FORMAT JSON) ' + selector[0], selector[1]).scalar_one()
            assert 'ix_quota_purchase_available' in json.dumps(plan), plan
        select_ms = measure(lambda: admission_policy(db, user, at=at))
        summary_ms = measure(lambda: entitlements_json(db, user, at), count=5)
        payload = entitlements_json(db, user, at)
        assert payload['purchase_quota']['granted'] == history_size + 1
        assert payload['purchase_quota']['available'] == 1
        assert not any(row['source'] == 'purchase' for row in payload['modes']['classic']['quota']['buckets'])
        payload_bytes = len(json.dumps(payload).encode())
        assert payload_bytes < 5000

    def bounded():
        with session_factory()() as db:
            admission_policy(db, db.get(User, owner), at=at)
    def previous_full_load():
        with session_factory()() as db:
            periods = list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.owner_id == owner,
                QuotaPeriod.mode == 'classic', QuotaPeriod.starts_at <= at,
                or_(QuotaPeriod.ends_at.is_(None), QuotaPeriod.ends_at > at))))
            return next(row.id for row in sorted(periods, key=lambda row: (row.starts_at, row.id))
                if row.granted > row.used + row.reserved)
    legacy_ms = measure(previous_full_load, count=3)
    peak_kib = {}
    for name, function in [('selector', bounded), ('legacy_full_load', previous_full_load)]:
        tracemalloc.start()
        function()
        peak_kib[name] = round(tracemalloc.get_traced_memory()[1] / 1024, 1)
        tracemalloc.stop()

    with session_factory()() as db:
        db.get(QuotaPeriod, active_id).used = 1
        db.commit()
        user = db.get(User, owner)
        fallback_statements = []
        def record_fallback(connection, cursor, statement, parameters, context, many):
            if 'source !=' in statement:
                fallback_statements.append((statement, parameters))
        event.listen(engine(), 'before_cursor_execute', record_fallback)
        try:
            assert admission_policy(db, user, at=at).service_plan == 'free'
        finally:
            event.remove(engine(), 'before_cursor_execute', record_fallback)
        if history_size:
            sql, params = fallback_statements[0]
            if db.get_bind().dialect.name == 'sqlite':
                plan = db.connection().exec_driver_sql('EXPLAIN QUERY PLAN ' + sql, params).all()
                assert any('ix_quota_nonpurchase' in str(row) for row in plan), plan
            else:
                plan = db.connection().exec_driver_sql('EXPLAIN (FORMAT JSON) ' + sql, params).scalar_one()
                assert 'ix_quota_nonpurchase' in json.dumps(plan), plan
        fallback_ms = measure(lambda: admission_policy(db, user, at=at))
    report = {'engine': engine().dialect.name, 'depleted_permanent_buckets': history_size,
        'policy_p50_ms': select_ms, 'free_fallback_p50_ms': fallback_ms, 'summary_p50_ms': summary_ms,
        'legacy_full_load_p50_ms': legacy_ms, 'peak_kib': peak_kib, 'entitlements_bytes': payload_bytes,
        'policy_select_statements': len(statements)}
    print(json.dumps(report))
    if history_size:
        assert select_ms < legacy_ms / 5
        assert peak_kib['selector'] < peak_kib['legacy_full_load'] / 20
