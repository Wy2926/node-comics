"""Reader feedback and accounting lookup index."""
from alembic import op
import sqlalchemy as sa

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("translation_feedback",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("job_id", sa.String(36), sa.ForeignKey("jobs.id"), nullable=False),
        sa.Column("output_asset_id", sa.String(36), sa.ForeignKey("assets.id"), nullable=False),
        sa.Column("issues", sa.JSON(), nullable=False),
        sa.Column("comment", sa.String(500), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("owner_id", "idempotency_key"))
    op.create_index("ix_feedback_owner_created", "translation_feedback", ["owner_id", "created_at"])
    op.create_index("ix_feedback_job", "translation_feedback", ["job_id"])
    op.create_index("ix_ledger_owner_created", "usage_ledger", ["owner_id", "created_at"])


def downgrade():
    op.drop_index("ix_ledger_owner_created", table_name="usage_ledger")
    op.drop_table("translation_feedback")
