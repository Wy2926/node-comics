"""Separate payment renewal from membership duration without rewriting sold offers."""
from importlib import import_module
from alembic import op
import sqlalchemy as sa

revision = 'prepaid_membership_0020'
down_revision = 'comic_title_length_0019'
branch_labels = None
depends_on = None
_table = import_module('migrations.versions.0014_quota_purchases')._table


def upgrade():
    with _table('billing_prices') as batch:
        batch.add_column(sa.Column('billing_type', sa.String(12), nullable=False, server_default='recurring'))
    op.get_bind().execute(sa.text("UPDATE billing_prices SET billing_type='onetime' WHERE interval='once'"))
    with _table('billing_prices') as batch:
        batch.create_check_constraint('ck_billing_price_type',
            "(billing_type = 'recurring' AND interval IN ('month', 'quarter', 'year')) OR "
            "(billing_type = 'onetime' AND interval IN ('quarter', 'year', 'once'))")
        batch.drop_index('uq_billing_active_offer')
        batch.create_index('uq_billing_active_offer', ['plan_id', 'environment', 'currency', 'interval', 'billing_type'],
            unique=True, sqlite_where=sa.text("status = 'active'"), postgresql_where=sa.text("status = 'active'"))
    with _table('billing_terms') as batch:
        batch.alter_column('subscription_id', existing_type=sa.String(320), nullable=True)
        batch.add_column(sa.Column('billing_order_id', sa.String(36), nullable=True))
        batch.create_foreign_key('fk_billing_term_order', 'billing_orders', ['billing_order_id'], ['id'])
        batch.create_unique_constraint('uq_billing_term_order', ['billing_order_id'])
        batch.create_check_constraint('ck_billing_term_source',
            '(subscription_id IS NOT NULL AND billing_order_id IS NULL) OR '
            "(subscription_id IS NULL AND billing_order_id IS NOT NULL AND kind = 'paid' AND invoice_id IS NULL)")


def downgrade():
    raise RuntimeError('Prepaid membership requires matching payment and entitlement code; restore a consistent backup to roll back')
