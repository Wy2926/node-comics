"""Restrict body LLM candidates by the user's effective membership plan."""
from alembic import op
import sqlalchemy as sa

revision = 'text_plan_routing_0013'
down_revision = 'asset_mime_0012'
branch_labels = None
depends_on = None


def upgrade():
    # NULL keeps every existing supplier's unrestricted routing unchanged.
    op.add_column('translation_providers', sa.Column('text_plan_ids', sa.JSON(none_as_null=True), nullable=True))


def downgrade():
    raise RuntimeError('Removing plan restrictions can widen model access; restore a reviewed backup to roll back')
