"""Task submission address and a unified support inbox."""
from alembic import op
import sqlalchemy as sa

revision = 'admin_workspace_0024'
down_revision = 'execution_retention_0023'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('jobs', sa.Column('submitted_ip', sa.String(45), nullable=True))
    op.add_column('support_requests', sa.Column('status', sa.String(20), nullable=False, server_default='received'))
    op.add_column('support_requests', sa.Column('review_note', sa.String(500), nullable=False, server_default=''))
    op.add_column('support_requests', sa.Column('reviewed_at', sa.DateTime(), nullable=True))
    op.create_index('ix_support_status_created', 'support_requests', ['status', 'created_at', 'id'])
    op.create_index('ix_feedback_status_created', 'translation_feedback', ['status', 'created_at', 'id'])
    op.create_index('ix_feedback_created', 'translation_feedback', ['created_at', 'id'])
    op.create_index('ix_billing_orders_paid', 'billing_orders', ['paid_at'])


def downgrade():
    op.drop_index('ix_billing_orders_paid', table_name='billing_orders')
    op.drop_index('ix_feedback_created', table_name='translation_feedback')
    op.drop_index('ix_feedback_status_created', table_name='translation_feedback')
    op.drop_index('ix_support_status_created', table_name='support_requests')
    for name in ('reviewed_at', 'review_note', 'status'):
        op.drop_column('support_requests', name)
    op.drop_column('jobs', 'submitted_ip')
