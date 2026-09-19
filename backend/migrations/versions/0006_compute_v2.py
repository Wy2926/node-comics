"""Durable whole-page claim receipts and immutable lease limits.

No job or asset data is deleted or converted. Drain old image leases before
switching the configured engine version; new submissions use protocol v2.
"""
from alembic import op
import sqlalchemy as sa

revision = 'shared_0006_compute_v2'
down_revision = 'shared_0005_billing'
branch_labels = depends_on = None


def upgrade():
    op.add_column('execution_leases', sa.Column('limits', sa.JSON(), nullable=False, server_default='{}'))
    op.create_table('compute_claims',
        sa.Column('node_id', sa.String(80), sa.ForeignKey('compute_nodes.id'), primary_key=True),
        sa.Column('request_id', sa.String(64), primary_key=True),
        sa.Column('request_hash', sa.String(64), nullable=False),
        sa.Column('lease_ids', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False))


def downgrade():
    op.drop_table('compute_claims')
    op.drop_column('execution_leases', 'limits')
