"""Persist new purchase keys that reuse an existing unfinished checkout."""
from alembic import op
import sqlalchemy as sa

revision = 'checkout_aliases_0021'
down_revision = 'prepaid_membership_0020'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('billing_checkout_aliases',
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), primary_key=True),
        sa.Column('idempotency_key', sa.String(128), primary_key=True),
        sa.Column('checkout_id', sa.String(36), sa.ForeignKey('billing_checkouts.id'), nullable=False))


def downgrade():
    raise RuntimeError('Checkout aliases preserve accepted purchase retries; restore a consistent backup to roll back')
