"""Comic title supplier selection, shared cache and per-user request limits."""
from alembic import op
import sqlalchemy as sa

revision = 'comic_titles_0002'
down_revision = 'translations_0001'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('comic_title_admissions',
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), primary_key=True),
        sa.Column('request_times', sa.JSON(), nullable=False))
    op.add_column('translation_providers', sa.Column('is_title_default', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_index('uq_translation_title_default', 'translation_providers', ['is_title_default'], unique=True,
        sqlite_where=sa.text('is_title_default = 1'), postgresql_where=sa.text('is_title_default'))
    op.create_table('comic_title_cache',
        sa.Column('input_key', sa.String(64), primary_key=True),
        sa.Column('language', sa.String(35), primary_key=True),
        sa.Column('input_name', sa.String(60), nullable=False),
        sa.Column('name', sa.String(2000)),
        sa.Column('output_key', sa.String(64)),
        sa.Column('actual_language', sa.String(35)),
        sa.Column('created_by', sa.String(36), sa.ForeignKey('users.id')),
        sa.Column('ready', sa.Boolean(), nullable=False),
        sa.Column('token', sa.String(36)),
        sa.Column('lease_until', sa.DateTime()))
    op.create_index('ix_comic_title_cache_output_key', 'comic_title_cache', ['output_key'])
    op.create_index('ix_comic_title_cache_token', 'comic_title_cache', ['token'], unique=True)


def downgrade():
    op.drop_table('comic_title_cache')
    op.drop_index('uq_translation_title_default', table_name='translation_providers')
    op.drop_column('translation_providers', 'is_title_default')
    op.drop_table('comic_title_admissions')
