"""Record the control process behind a logical resource-pool lease."""
from alembic import op
import sqlalchemy as sa

revision = "cluster_0002"
down_revision = "cluster_0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("execution_leases", sa.Column("executor_id", sa.String(160), nullable=True))
    op.create_index("ix_jobs_created_at", "jobs", ["created_at"])
    op.create_index("ix_jobs_completed_at", "jobs", ["completed_at"])


def downgrade():
    op.drop_index("ix_jobs_completed_at", table_name="jobs")
    op.drop_index("ix_jobs_created_at", table_name="jobs")
    op.drop_column("execution_leases", "executor_id")
