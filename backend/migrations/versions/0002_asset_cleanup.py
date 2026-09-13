"""Track physical cleanup so tombstones cannot starve later expiration batches."""
from alembic import op
from sqlalchemy import Column, DateTime, inspect

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    if "purged_at" not in {column["name"] for column in inspect(op.get_bind()).get_columns("assets")}:
        op.add_column("assets", Column("purged_at", DateTime(), nullable=True))


def downgrade():
    op.drop_column("assets", "purged_at")
