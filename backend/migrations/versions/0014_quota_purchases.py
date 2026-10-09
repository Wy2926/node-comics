"""One-time page purchases without changing historical subscriptions or balances."""
from contextlib import contextmanager
from alembic import op
import sqlalchemy as sa

revision = 'quota_purchases_0014'
down_revision = 'text_plan_routing_0013'
branch_labels = None
depends_on = None


@contextmanager
def _table(name, replacing=()):
    """Retain unnamed baseline CHECKs during SQLite parent-table replacement."""
    connection = op.get_bind()
    sqlite = connection.dialect.name == 'sqlite'
    checks = sa.inspect(connection).get_check_constraints(name)
    replaced = [check for check in checks if any(match(check['sqltext']) for match in replacing)]
    retained = tuple(sa.CheckConstraint(check['sqltext']) for check in checks
                     if not check['name'] and check not in replaced)
    if sqlite:
        if not connection.connection.driver_connection.in_transaction:
            connection.exec_driver_sql('BEGIN IMMEDIATE')
        deferred = connection.exec_driver_sql('PRAGMA defer_foreign_keys').scalar()
        connection.exec_driver_sql('PRAGMA defer_foreign_keys = ON')
    with op.batch_alter_table(name, table_args=retained) as batch:
        for check in replaced:
            if check['name']:
                batch.drop_constraint(check['name'], type_='check')
        yield batch
    if sqlite:
        if connection.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
            raise RuntimeError('Purchase migration must preserve existing foreign-key references')
        if not deferred:
            connection.exec_driver_sql('PRAGMA defer_foreign_keys = OFF')


def upgrade():
    with _table('billing_plan_revisions') as batch:
        batch.add_column(sa.Column('service_plan_id', sa.String(64), nullable=True))
        batch.add_column(sa.Column('quota_pages', sa.Integer(), nullable=False, server_default='0'))
        batch.add_column(sa.Column('quota_validity_days', sa.Integer(), nullable=True))
        batch.create_check_constraint('ck_billing_revision_quota_pages', 'quota_pages BETWEEN 0 AND 1000000')
        batch.create_check_constraint('ck_billing_revision_quota_validity',
            'quota_validity_days IS NULL OR quota_validity_days BETWEEN 1 AND 36500')
        batch.create_check_constraint('ck_billing_revision_purchase',
            '(quota_pages = 0 AND quota_validity_days IS NULL AND service_plan_id IS NULL) OR '
            '(quota_pages > 0 AND service_plan_id IS NOT NULL AND monthly_redraw_pages = 0 '
            'AND trial_days = 0 AND trial_redraw_pages = 0)')
    with _table('billing_prices', (lambda sql: 'interval' in sql and "'month'" in sql,)) as batch:
        batch.create_check_constraint('ck_billing_price_interval', "interval IN ('month', 'year', 'once')")
    with _table('billing_checkouts') as batch:
        batch.add_column(sa.Column('idempotency_key', sa.String(128), nullable=True))
        batch.create_unique_constraint('uq_billing_checkout_intent', ['owner_id', 'idempotency_key'])
    with _table('quota_periods', (
            lambda sql: 'source' in sql and "'daily'" in sql,
            lambda sql: 'source' in sql and 'ends_at IS NOT NULL' in sql)) as batch:
        batch.add_column(sa.Column('billing_order_id', sa.String(36), nullable=True))
        batch.add_column(sa.Column('revoked_at', sa.DateTime(), nullable=True))
        batch.create_foreign_key('fk_quota_purchase_order', 'billing_orders', ['billing_order_id'], ['id'])
        batch.create_unique_constraint('uq_quota_purchase_order', ['billing_order_id'])
        batch.create_check_constraint('ck_quota_source',
            "source IN ('daily', 'membership', 'grant', 'subscription', 'purchase')")
        batch.create_check_constraint('ck_quota_expiry_source', "source IN ('grant', 'purchase') OR ends_at IS NOT NULL")
        batch.create_check_constraint('ck_quota_purchase_order',
            "(source = 'purchase' AND billing_order_id IS NOT NULL AND mode = 'classic') OR "
            "(source != 'purchase' AND billing_order_id IS NULL AND revoked_at IS NULL)")
    spendable = sa.text("source = 'purchase' AND revoked_at IS NULL AND granted > used + reserved")
    op.create_index('ix_quota_purchase_available', 'quota_periods',
        ['owner_id', 'mode', 'ends_at', 'starts_at', 'id'], sqlite_where=spendable, postgresql_where=spendable)
    purchased = sa.text("source = 'purchase'")
    op.create_index('ix_quota_purchase_history', 'quota_periods', ['owner_id', 'starts_at', 'id'],
        sqlite_where=purchased, postgresql_where=purchased)
    ordinary = sa.text("source != 'purchase'")
    op.create_index('ix_quota_nonpurchase', 'quota_periods', ['owner_id', 'mode', 'ends_at', 'starts_at', 'id'],
        sqlite_where=ordinary, postgresql_where=ordinary)
    op.create_index('ix_billing_events_transaction', 'billing_events',
        ['provider', 'environment', sa.text("(payload ->> 'transaction_id')"), 'event_type'])
    op.create_index('ix_billing_events_resource', 'billing_events', ['provider', 'environment', 'resource_id', 'event_type'])


def downgrade():
    raise RuntimeError('Purchased pages and payment receipts require matching code; restore a consistent backup to roll back')
