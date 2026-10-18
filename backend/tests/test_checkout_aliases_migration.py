"""The additive alias migration preserves historical purchases and accepted keys."""
from datetime import datetime
import os
from pathlib import Path

from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import MetaData, inspect, text
from sqlalchemy.exc import IntegrityError

from test_job_results_migration import migrate
from test_postgres_concurrency import pg_scope  # noqa: F401
from test_request_limits_migration import isolated_migration_database  # noqa: F401


def test_checkout_alias_upgrade_preserves_original_orders_and_keys(isolated_migration_database):
    engine = isolated_migration_database
    migrate(engine, 'prepaid_membership_0020')
    metadata = MetaData()
    metadata.reflect(engine)
    stamp, end = datetime(2026, 1, 1), datetime(2026, 1, 2)
    preserved = ('billing_prices', 'billing_price_bindings', 'billing_checkouts', 'billing_orders')
    with engine.begin() as db:
        def add(table, **values):
            db.execute(metadata.tables[table].insert().values(**values))
        for owner in ('buyer', 'other'):
            add('users', id=owner, subject=owner, name=owner, role='user', plus_pending=False, created_at=stamp)
        for plan, interval, pages in [('plus', 'quarter', 0), ('pack', 'once', 100)]:
            add('billing_plans', id=plan, name=plan, created_at=stamp)
            add('billing_plan_revisions', id=plan + '-v1', plan_id=plan, version=1, name=plan,
                monthly_classic_pages=300 if plan == 'plus' else 0, trial_days=0, trial_classic_pages=0,
                quota_pages=pages, service_plan_id='lite' if pages else None, created_at=stamp)
            add('billing_prices', id=plan + '-price', plan_id=plan, plan_revision_id=plan + '-v1',
                environment='test', currency='usd', unit_amount=399, interval=interval,
                billing_type='onetime', status='active', created_at=stamp)
            add('billing_price_bindings', id=plan + '-binding', price_id=plan + '-price', provider='creem',
                environment='test', product_id='prod_' + plan, status='active', created_at=stamp)
        for checkout, owner, plan, key, status in [
                ('pack-open', 'buyer', 'pack', 'original-pack', 'open'),
                ('pack-unknown', 'buyer', 'pack', 'original-unknown', 'unknown'),
                ('prepaid-paid', 'buyer', 'plus', 'original-prepaid', 'completed'),
                ('other-open', 'other', 'pack', 'original-pack', 'open')]:
            add('billing_checkouts', id=checkout, owner_id=owner, idempotency_key=key, provider='creem',
                environment='test', price_id=plan + '-price', binding_id=plan + '-binding',
                session_id=None if status == 'unknown' else 'ch_' + checkout,
                return_url='https://example.test/account/', trial=False, status=status,
                expires_at=end, created_at=stamp, last_checked_at=stamp)
            add('billing_orders', id=checkout + '-order', owner_id=owner, provider='creem', environment='test',
                checkout_id=checkout, price_id=plan + '-price', binding_id=plan + '-binding', kind='initial',
                status='paid' if status == 'completed' else status if status == 'unknown' else 'pending',
                currency='usd', total=399, created_at=stamp, updated_at=stamp)
        before = {table: db.execute(metadata.tables[table].select()
            .order_by(metadata.tables[table].c.id)).all() for table in preserved}

    migrate(engine, 'head')
    with engine.connect() as db:
        assert db.scalar(text('SELECT version_num FROM alembic_version')) == 'checkout_aliases_0021'
        assert db.scalar(text('SELECT count(*) FROM billing_checkout_aliases')) == 0
        for table in preserved:
            assert db.execute(metadata.tables[table].select().order_by(metadata.tables[table].c.id)).all() == before[table]
        if engine.dialect.name == 'sqlite':
            assert db.exec_driver_sql('PRAGMA foreign_key_check').first() is None
    inspector = inspect(engine)
    assert inspector.get_pk_constraint('billing_checkout_aliases')['constrained_columns'] == ['owner_id', 'idempotency_key']
    foreign_keys = {(tuple(value['constrained_columns']), value['referred_table'], tuple(value['referred_columns']))
        for value in inspector.get_foreign_keys('billing_checkout_aliases')}
    assert foreign_keys == {(('owner_id',), 'users', ('id',)), (('checkout_id',), 'billing_checkouts', ('id',))}
    insert = text('INSERT INTO billing_checkout_aliases (owner_id,idempotency_key,checkout_id) '
        'VALUES (:owner,:key,:checkout)')
    with engine.begin() as db:
        for owner, checkout in [('buyer', 'pack-open'), ('other', 'other-open')]:
            db.execute(insert, {'owner': owner, 'key': 'alternate-key', 'checkout': checkout})
    for values in [
            {'owner': 'buyer', 'key': 'alternate-key', 'checkout': 'pack-unknown'},
            {'owner': 'missing', 'key': 'new-key', 'checkout': 'pack-open'},
            {'owner': 'buyer', 'key': 'new-key', 'checkout': 'missing'}]:
        with pytest.raises(IntegrityError):
            with engine.begin() as db:
                db.execute(insert, values)
    migrate(engine, 'head')
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with pytest.raises(RuntimeError, match='Checkout aliases preserve accepted purchase retries'):
        with engine.begin() as db:
            config.attributes['connection'] = db
            command.downgrade(config, 'prepaid_membership_0020')
    with engine.connect() as db:
        assert db.scalar(text('SELECT version_num FROM alembic_version')) == 'checkout_aliases_0021'
        assert db.scalar(text('SELECT count(*) FROM billing_checkout_aliases')) == 2
        for table in preserved:
            assert db.execute(metadata.tables[table].select().order_by(metadata.tables[table].c.id)).all() == before[table]


@pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1', reason='Requires dedicated PostgreSQL test database')
def test_checkout_alias_upgrade_on_postgres(pg_scope):
    from app.db import engine
    test_checkout_alias_upgrade_preserves_original_orders_and_keys(engine())
