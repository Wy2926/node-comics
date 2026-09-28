"""Configurable awards; preserve all existing quota, ledger and account rows."""
from alembic import op
from contextlib import contextmanager
import sqlalchemy as sa

revision = 'quota_campaigns_0006'
down_revision = 'gift_renewal_0005'
branch_labels = None
depends_on = None


def upgrade():
    with _quota_table() as batch:
        batch.alter_column('ends_at', existing_type=sa.DateTime(), nullable=True)
        batch.create_check_constraint('ck_quota_expiry_source', "source = 'grant' OR ends_at IS NOT NULL")
    op.create_table('quota_campaigns',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('mode', sa.String(20), nullable=False),
        sa.Column('pages', sa.Integer(), nullable=False),
        sa.Column('audience', sa.String(20), nullable=False),
        sa.Column('starts_at', sa.DateTime(), nullable=False),
        sa.Column('ends_at', sa.DateTime()),
        sa.Column('validity_days', sa.Integer()),
        sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('request_hash', sa.String(64), nullable=False),
        sa.Column('created_by', sa.String(36), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.CheckConstraint("mode IN ('classic', 'redraw')"),
        sa.CheckConstraint("audience IN ('all', 'existing', 'new')"),
        sa.CheckConstraint('pages BETWEEN 1 AND 1000000'),
        sa.CheckConstraint('validity_days IS NULL OR validity_days BETWEEN 1 AND 36500'),
        sa.CheckConstraint('ends_at IS NULL OR ends_at > starts_at'),
        sa.CheckConstraint('version >= 1'))
    op.create_table('quota_campaign_awards',
        sa.Column('campaign_id', sa.String(64), sa.ForeignKey('quota_campaigns.id'), primary_key=True),
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), primary_key=True),
        sa.Column('period_id', sa.String(64), sa.ForeignKey('quota_periods.id'), nullable=False, unique=True),
        sa.Column('created_at', sa.DateTime(), nullable=False))


def downgrade():
    if op.get_bind().scalar(sa.text('SELECT count(*) FROM quota_campaigns')) or op.get_bind().scalar(
            sa.text('SELECT count(*) FROM quota_periods WHERE ends_at IS NULL')):
        raise RuntimeError('Campaign configuration or non-expiring grants exist; preserve award receipts and compatible code')
    op.drop_table('quota_campaign_awards')
    op.drop_table('quota_campaigns')
    with _quota_table() as batch:
        batch.drop_constraint('ck_quota_expiry_source', type_='check')
        batch.alter_column('ends_at', existing_type=sa.DateTime(), nullable=False)


def _unnamed_checks():
    # SQLite's table rebuild otherwise silently drops the baseline checks.
    return tuple(sa.CheckConstraint(check['sqltext']) for check in
                 sa.inspect(op.get_bind()).get_check_constraints('quota_periods') if not check['name'])


@contextmanager
def _quota_table():
    connection = op.get_bind()
    sqlite = connection.dialect.name == 'sqlite'
    if sqlite:
        # SQLite rebuilds the parent table. Keep references enforced, but defer
        # their check until the replacement table and original rows are present.
        if not connection.connection.driver_connection.in_transaction:
            connection.exec_driver_sql('BEGIN IMMEDIATE')
        deferred = connection.exec_driver_sql('PRAGMA defer_foreign_keys').scalar()
        connection.exec_driver_sql('PRAGMA defer_foreign_keys = ON')
    with op.batch_alter_table('quota_periods', table_args=_unnamed_checks()) as batch:
        yield batch
    if sqlite:
        if connection.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
            raise RuntimeError('Quota migration must preserve every foreign-key reference')
        if not deferred:
            connection.exec_driver_sql('PRAGMA defer_foreign_keys = OFF')
