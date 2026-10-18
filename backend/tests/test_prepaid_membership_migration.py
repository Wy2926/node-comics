"""Preserve sold subscriptions and packs while allowing order-backed paid terms."""
from datetime import datetime
import os
from sqlalchemy import MetaData, inspect, text
from sqlalchemy.exc import IntegrityError
import pytest
from test_job_results_migration import migrate
from test_request_limits_migration import isolated_migration_database  # noqa: F401
from test_postgres_concurrency import pg_scope  # noqa: F401


def test_prepaid_upgrade_preserves_existing_prices_terms_and_quota(isolated_migration_database):
    engine = isolated_migration_database
    migrate(engine, 'comic_title_length_0019')
    meta = MetaData()
    meta.reflect(engine)
    stamp, end = datetime(2026, 1, 31), datetime(2026, 2, 28)
    with engine.begin() as db:
        def add(table, **values):
            db.execute(meta.tables[table].insert().values(**values))
        add('users', id='buyer', subject='buyer', name='Buyer', role='user', plus_pending=False, created_at=stamp)
        for plan, interval, pages in [('plus', 'month', 0), ('pack', 'once', 100)]:
            add('billing_plans', id=plan, name=plan, created_at=stamp)
            add('billing_plan_revisions', id=plan + '-v1', plan_id=plan, version=1, name=plan,
                monthly_classic_pages=0 if pages else 300, trial_days=0, trial_classic_pages=0,
                quota_pages=pages, service_plan_id='plus' if pages else None, created_at=stamp)
            add('billing_prices', id=plan + '-price', plan_id=plan, plan_revision_id=plan + '-v1',
                environment='test', currency='usd', unit_amount=999, interval=interval, status='active', created_at=stamp)
            add('billing_price_bindings', id=plan + '-binding', price_id=plan + '-price', provider='stripe',
                environment='test', product_id='prod_' + plan, provider_price_id='price_' + plan, status='active', created_at=stamp)
            add('billing_checkouts', id=plan + '-checkout', owner_id='buyer', provider='stripe', environment='test',
                price_id=plan + '-price', binding_id=plan + '-binding', return_url='https://example.test/account/',
                trial=False, status='completed', expires_at=end, created_at=stamp)
        add('billing_subscriptions', id='stripe:test:legacy', owner_id='buyer', checkout_id='plus-checkout',
            provider='stripe', environment='test', customer_id='cus_buyer', price_id='plus-price',
            binding_id='plus-binding', status='active', synced_at=stamp)
        add('billing_terms', id='legacy-term', owner_id='buyer', subscription_id='stripe:test:legacy',
            price_id='plus-price', kind='paid', starts_at=stamp, ends_at=end)
        add('billing_orders', id='pack-order', owner_id='buyer', provider='stripe', environment='test',
            checkout_id='pack-checkout', price_id='pack-price', binding_id='pack-binding', kind='initial',
            status='paid', currency='usd', total=999, created_at=stamp, updated_at=stamp)
        for source, term, order, granted, used in [('subscription', 'legacy-term', None, 300, 17),
                ('purchase', None, 'pack-order', 100, 9)]:
            add('quota_periods', id=source + '-quota', owner_id='buyer', billing_term_id=term, billing_order_id=order,
                kind='classic_grant', mode='classic', source=source, source_key=source + ':fixture',
                note='', grants_access=source == 'subscription', starts_at=stamp,
                ends_at=end if term else None, granted=granted, used=used, reserved=2)
    migrate(engine, 'head')
    with engine.connect() as db:
        assert dict(db.execute(text('SELECT id,billing_type FROM billing_prices')).all()) == {
            'plus-price': 'recurring', 'pack-price': 'onetime'}
        term = db.execute(text('SELECT subscription_id,billing_order_id,starts_at,ends_at FROM billing_terms')).one()
        assert term[:2] == ('stripe:test:legacy', None)
        assert str(term.starts_at).startswith('2026-01-31') and str(term.ends_at).startswith('2026-02-28')
        assert list(db.execute(text('SELECT granted,used,reserved FROM quota_periods ORDER BY id'))) == [(100, 9, 2), (300, 17, 2)]
        assert db.scalar(text('SELECT count(*) FROM billing_price_bindings')) == 2
        if engine.dialect.name == 'sqlite':
            assert db.exec_driver_sql('PRAGMA foreign_key_check').first() is None
    columns = {column['name']: column for column in inspect(engine).get_columns('billing_terms')}
    assert columns['subscription_id']['nullable'] and columns['billing_order_id']['nullable']
    with engine.begin() as db:
        db.execute(text("INSERT INTO billing_terms (id,owner_id,subscription_id,billing_order_id,price_id,kind,starts_at,ends_at) "
            "VALUES ('prepaid','buyer',NULL,'pack-order','plus-price','paid','2026-03-01','2026-06-01')"))
    for subscription, order, kind in [(None, None, 'paid'), ('stripe:test:legacy', 'pack-order', 'paid'),
            (None, 'pack-order', 'trial'), (None, 'pack-order', 'paid')]:
        with pytest.raises(IntegrityError):
            with engine.begin() as db:
                db.execute(text('INSERT INTO billing_terms '
                    '(id,owner_id,subscription_id,billing_order_id,price_id,kind,starts_at,ends_at) '
                    "VALUES ('invalid','buyer',:subscription,:order,'plus-price',:kind,'2027-03-01','2027-06-01')"),
                    {'subscription': subscription, 'order': order, 'kind': kind})
    migrate(engine, 'head')


@pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1', reason='Requires dedicated PostgreSQL test database')
def test_prepaid_upgrade_on_postgres(pg_scope):
    from app.db import engine
    test_prepaid_upgrade_preserves_existing_prices_terms_and_quota(engine())
