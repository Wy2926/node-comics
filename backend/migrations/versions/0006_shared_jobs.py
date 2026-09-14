"""Ordered batch membership and durable receipts for active-job reuse."""
from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("batch_items",
        sa.Column("batch_id", sa.String(36), sa.ForeignKey("batches.id"), primary_key=True),
        sa.Column("ordinal", sa.Integer(), primary_key=True),
        sa.Column("input_asset_id", sa.String(36), sa.ForeignKey("assets.id"), nullable=False),
        sa.Column("job_id", sa.String(36), sa.ForeignKey("jobs.id"), nullable=False),
        sa.CheckConstraint("ordinal >= 0"))
    op.create_index("ix_batch_items_job_id", "batch_items", ["job_id"])
    op.create_table("job_requests",
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("operation", sa.String(100), primary_key=True),
        sa.Column("idempotency_key", sa.String(128), primary_key=True),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("job_id", sa.String(36), sa.ForeignKey("jobs.id"), nullable=False))
    op.create_index("ix_job_requests_job_id", "job_requests", ["job_id"])


def downgrade():
    op.drop_table("job_requests")
    op.drop_table("batch_items")
