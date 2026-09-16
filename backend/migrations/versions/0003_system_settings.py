"""One versioned system configuration shared by API replicas."""
from alembic import op
import sqlalchemy as sa

revision = "shared_0003_system_settings"
down_revision = "shared_0002_request_limits"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("system_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("values", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("updated_by", sa.String(36), sa.ForeignKey("users.id"), nullable=True),
        sa.CheckConstraint("id = 1", name="ck_system_settings_singleton"),
        sa.CheckConstraint("version >= 1", name="ck_system_settings_version"))


def downgrade():
    op.drop_table("system_settings")
