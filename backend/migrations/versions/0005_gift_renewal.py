"""Gift renewal fields; no historical payment conversion or parallel schema."""
from alembic import op
import sqlalchemy as sa

revision = 'gift_renewal_0005'
down_revision = 'redis_admission_0004'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('plus_pending', sa.Boolean(), nullable=False, server_default=sa.false()))
    for column in (
        sa.Column('auto_renew', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('gift_membership_id', sa.String(36)),
        sa.Column('gift_deferred', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('resume_at', sa.DateTime()),
        sa.Column('renewal_action', sa.String(12)),
        sa.Column('renewal_action_at', sa.DateTime()),
        sa.Column('renewal_error', sa.String(80)),
    ):
        op.add_column('billing_subscriptions', column)


def downgrade():
    if op.get_bind().scalar(sa.text('SELECT count(*) FROM billing_subscriptions WHERE gift_deferred OR renewal_action IS NOT NULL')):
        raise RuntimeError('Resolve gift renewal operations before rolling back billing workers')
    if op.get_bind().scalar(sa.text('SELECT count(*) FROM users WHERE plus_timezone IS NULL AND plus_started_at IS NOT NULL AND plus_expires_at > CURRENT_TIMESTAMP')):
        raise RuntimeError('Resolve thirty-day gift periods before rolling back membership code')
    for name in ('renewal_error', 'renewal_action_at', 'renewal_action', 'resume_at',
                 'gift_deferred', 'gift_membership_id', 'auto_renew'):
        op.drop_column('billing_subscriptions', name)
    op.drop_column('users', 'plus_pending')
