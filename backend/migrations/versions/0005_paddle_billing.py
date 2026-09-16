"""Separate subscription entitlements from operator gifts."""
from alembic import op
import sqlalchemy as sa

revision = 'shared_0005_paddle_billing'
down_revision = 'shared_0004_text_providers'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('billing_plus_started_at', sa.DateTime(), nullable=True))
    op.add_column('users', sa.Column('billing_plus_expires_at', sa.DateTime(), nullable=True))
    op.add_column('users', sa.Column('billing_membership_id', sa.String(64), nullable=True))
    op.create_table('billing_accounts',
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), primary_key=True),
        sa.Column('environment', sa.String(16), nullable=False),
        sa.Column('customer_id', sa.String(64), unique=True),
        sa.Column('trial_used_at', sa.DateTime()))
    op.create_table('billing_checkouts',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('environment', sa.String(16), nullable=False),
        sa.Column('price_id', sa.String(64), nullable=False),
        sa.Column('trial', sa.Boolean(), nullable=False),
        sa.Column('status', sa.String(24), nullable=False),
        sa.Column('transaction_id', sa.String(64), unique=True),
        sa.Column('token_hash', sa.String(64), unique=True),
        sa.Column('token_expires_at', sa.DateTime()),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('last_checked_at', sa.DateTime()),
        sa.Column('error_code', sa.String(80)))
    op.create_index('ix_billing_checkouts_owner_id', 'billing_checkouts', ['owner_id'])
    op.create_table('billing_subscriptions',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('checkout_id', sa.String(36), sa.ForeignKey('billing_checkouts.id'), nullable=False, unique=True),
        sa.Column('environment', sa.String(16), nullable=False),
        sa.Column('customer_id', sa.String(64), nullable=False),
        sa.Column('status', sa.String(24), nullable=False),
        sa.Column('trial_starts_at', sa.DateTime()), sa.Column('trial_ends_at', sa.DateTime()),
        sa.Column('paid_starts_at', sa.DateTime()), sa.Column('paid_ends_at', sa.DateTime()),
        sa.Column('next_billed_at', sa.DateTime()), sa.Column('cancel_at', sa.DateTime()),
        sa.Column('provider_updated_at', sa.DateTime(), nullable=False),
        sa.Column('synced_at', sa.DateTime(), nullable=False))
    op.create_index('ix_billing_subscriptions_owner_id', 'billing_subscriptions', ['owner_id'])
    op.create_table('billing_events',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('environment', sa.String(16), nullable=False),
        sa.Column('event_type', sa.String(80), nullable=False),
        sa.Column('resource_id', sa.String(64), nullable=False),
        sa.Column('occurred_at', sa.DateTime(), nullable=False),
        sa.Column('status', sa.String(24), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False),
        sa.Column('next_attempt_at', sa.DateTime(), nullable=False),
        sa.Column('error_code', sa.String(80)),
        sa.Column('received_at', sa.DateTime(), nullable=False),
        sa.Column('processed_at', sa.DateTime()))
    op.create_index('ix_billing_events_next_attempt_at', 'billing_events', ['next_attempt_at'])


def downgrade():
    for table in ['billing_events', 'billing_subscriptions', 'billing_checkouts', 'billing_accounts']:
        op.drop_table(table)
    for name in ['billing_membership_id', 'billing_plus_expires_at', 'billing_plus_started_at']:
        op.drop_column('users', name)
