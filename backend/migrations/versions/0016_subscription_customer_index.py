"""Keep independent-checkout customer ownership checks indexed."""
from alembic import op

revision = 'subscription_customer_0016'
down_revision = 'classic_quotas_0015'
branch_labels = None
depends_on = None


def upgrade():
    op.create_index('ix_billing_subscriptions_customer', 'billing_subscriptions',
                    ['provider', 'environment', 'customer_id'])


def downgrade():
    op.drop_index('ix_billing_subscriptions_customer', table_name='billing_subscriptions')
