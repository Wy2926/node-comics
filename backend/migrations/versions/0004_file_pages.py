"""Account-private file SHA-256 and original page index lookup; no legacy backfill."""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("file_pages",
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("file_hash", sa.String(64), primary_key=True),
        sa.Column("page_index", sa.Integer(), primary_key=True),
        sa.Column("asset_id", sa.String(36), sa.ForeignKey("assets.id"), nullable=False),
        sa.CheckConstraint("page_index >= 0"),
    )
    op.create_index("ix_file_pages_asset_id", "file_pages", ["asset_id"])


def downgrade():
    op.drop_table("file_pages")
