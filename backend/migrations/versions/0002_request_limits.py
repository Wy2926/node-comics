"""Bound upload ingress and feedback independently of translation quotas."""
from alembic import op
import sqlalchemy as sa

revision = "shared_0002_request_limits"
down_revision = "shared_0001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("upload_ingress_mutex", sa.Column("id", sa.Integer(), primary_key=True))
    op.create_table("upload_ingress_leases",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("upload_id", sa.String(36), sa.ForeignKey("upload_reservations.id"), nullable=False, unique=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False))
    op.create_index("ix_upload_ingress_leases_owner_id", "upload_ingress_leases", ["owner_id"])
    op.create_index("ix_upload_ingress_leases_expires_at", "upload_ingress_leases", ["expires_at"])
    op.create_table("feedback_admissions",
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("request_tokens", sa.Float(), nullable=False),
        sa.Column("refilled_at", sa.DateTime(), nullable=False),
        sa.Column("day_started_at", sa.DateTime(), nullable=False),
        sa.Column("daily_receipts", sa.Integer(), nullable=False),
        sa.CheckConstraint("daily_receipts >= 0", name="ck_feedback_admissions_daily_receipts"))


def downgrade():
    op.drop_table("feedback_admissions")
    op.drop_table("upload_ingress_leases")
    op.drop_table("upload_ingress_mutex")
