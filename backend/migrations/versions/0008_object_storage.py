"""Keep asset and in-flight output locations stable across storage switches."""
from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("assets", sa.Column("storage_backend", sa.String(20), nullable=False, server_default="local"))
    op.add_column("attempts", sa.Column("output_storage_backend", sa.String(20), nullable=False, server_default="local"))
    op.create_table("storage_scans",
        sa.Column("backend", sa.String(20), primary_key=True),
        sa.Column("cursor", sa.String(4096)),
        sa.Column("next_scan_at", sa.DateTime(), nullable=False))


def downgrade():
    op.drop_table("storage_scans")
    op.drop_column("attempts", "output_storage_backend")
    op.drop_column("assets", "storage_backend")
