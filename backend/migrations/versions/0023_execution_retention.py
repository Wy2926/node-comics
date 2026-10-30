"""Bounded execution payload and claim retention; no runtime version gate."""
from alembic import op
import sqlalchemy as sa

revision = 'execution_retention_0023'
down_revision = 'image_result_expiry_0022'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('classic_states', sa.Column('retention_stage', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('jobs', sa.Column('details_compacted_at', sa.DateTime(), nullable=True))
    op.create_index('ix_classic_states_retention', 'classic_states', ['retention_stage', 'job_id'])
    predicate = sa.text("details_compacted_at IS NULL AND status IN ('succeeded', 'no_text', 'failed', 'cancelled')")
    op.create_index('ix_jobs_execution_retention', 'jobs', ['completed_at', 'id'],
        sqlite_where=predicate, postgresql_where=predicate)
    # Operators can prebuild the large claim index CONCURRENTLY before migration.
    op.create_index('ix_compute_claims_retention', 'compute_claims', ['created_at', 'node_id', 'request_id'],
        if_not_exists=True)


def downgrade():
    op.drop_index('ix_compute_claims_retention', table_name='compute_claims')
    op.drop_index('ix_jobs_execution_retention', table_name='jobs')
    op.drop_index('ix_classic_states_retention', table_name='classic_states')
    op.drop_column('jobs', 'details_compacted_at')
    op.drop_column('classic_states', 'retention_stage')
