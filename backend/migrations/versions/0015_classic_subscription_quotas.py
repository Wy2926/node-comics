"""Finite or unlimited classic subscriptions; retire the image-edit service."""
from importlib import import_module
from alembic import op
import sqlalchemy as sa

revision = 'classic_quotas_0015'
down_revision = 'quota_purchases_0014'
branch_labels = None
depends_on = None
_table = import_module('migrations.versions.0014_quota_purchases')._table


def upgrade():
    connection = op.get_bind()
    with _table('billing_prices', (lambda sql: 'interval IN' in sql,)) as batch:
        batch.create_check_constraint('ck_billing_price_interval', "interval IN ('month', 'quarter', 'year', 'once')")
    # New benefit columns deliberately do not interpret old image-edit allowances.
    # No sold subscription needs an entitlement conversion.
    with _table('billing_plan_revisions', (
            lambda sql: 'monthly_redraw_pages' in sql or 'trial_redraw_pages' in sql,
            lambda sql: 'service_plan_id' in sql)) as batch:
        batch.drop_column('monthly_redraw_pages')
        batch.drop_column('trial_redraw_pages')
        batch.add_column(sa.Column('monthly_classic_pages', sa.Integer(), nullable=True))
        batch.add_column(sa.Column('trial_classic_pages', sa.Integer(), nullable=True))
        batch.create_check_constraint('ck_billing_monthly_classic',
            'monthly_classic_pages IS NULL OR monthly_classic_pages BETWEEN 0 AND 1000000')
        batch.create_check_constraint('ck_billing_trial_classic',
            'trial_classic_pages IS NULL OR trial_classic_pages BETWEEN 0 AND 1000000')
    connection.execute(sa.text('UPDATE billing_plan_revisions SET trial_classic_pages=0 WHERE trial_days=0'))
    connection.execute(sa.text('UPDATE billing_plan_revisions SET monthly_classic_pages=0 WHERE quota_pages>0'))
    with _table('billing_plan_revisions') as batch:
        batch.create_check_constraint('ck_billing_classic_trial_days', 'trial_days > 0 OR (trial_classic_pages IS NOT NULL AND trial_classic_pages = 0)')
        batch.create_check_constraint('ck_billing_revision_purchase',
            '(quota_pages = 0 AND quota_validity_days IS NULL) OR '
            '(quota_pages > 0 AND service_plan_id IS NOT NULL AND monthly_classic_pages IS NOT NULL AND monthly_classic_pages = 0 '
            'AND trial_days = 0 AND trial_classic_pages IS NOT NULL AND trial_classic_pages = 0)')
    # Expire obsolete test allowances without losing accounting references.
    connection.execute(sa.text("UPDATE quota_periods SET mode='classic', kind='classic_grant', "
        "granted=used+reserved, grants_access=false WHERE mode='redraw'"))
    connection.execute(sa.text("UPDATE quota_campaigns SET mode='classic', enabled=false WHERE mode='redraw'"))
    for name in ('quota_periods', 'quota_campaigns'):
        with _table(name, (lambda sql: 'mode IN' in sql,)) as batch:
            batch.create_check_constraint('ck_' + name + '_classic', "mode = 'classic'")
    # Operator gifts now explicitly choose null (unlimited) or monthly pages.
    connection.execute(sa.text('UPDATE users SET plus_monthly_pages=NULL WHERE membership_id IS NOT NULL'))
    settings = sa.table('system_settings', sa.column('id'), sa.column('values', sa.JSON()))
    for row in connection.execute(sa.select(settings.c.id, settings.c['values'])):
        values = dict(row[1])
        values.pop('plus_monthly_redraw_pages', None)
        connection.execute(settings.update().where(settings.c.id == row[0]).values(values=values))
    connection.execute(sa.text("UPDATE compute_nodes SET enabled=false WHERE id='control-redraw'"))
    op.drop_table('providers')


def downgrade():
    raise RuntimeError('Restore a consistent backup to restore removed image-edit functionality')
