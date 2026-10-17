"""Expand input comic titles without truncating existing cached names."""
from alembic import op
import sqlalchemy as sa

revision = 'comic_title_length_0019'
down_revision = 'document_workspaces_0018'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('comic_title_cache') as batch:
        batch.alter_column('input_name', existing_type=sa.String(60),
                           type_=sa.String(120), existing_nullable=False)


def downgrade():
    raise RuntimeError('Long comic titles require the expanded column; restore a consistent backup to roll back')
