"""Independent translation suppliers; no import of old LLM settings or jobs."""
from alembic import op
import sqlalchemy as sa

revision = 'shared_0004_text_providers'
down_revision = 'shared_0003_system_settings'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('translation_providers',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('channel', sa.String(40), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('is_default', sa.Boolean(), nullable=False),
        sa.Column('revision_id', sa.String(36), nullable=True),
        sa.Column('requests_per_minute', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.CheckConstraint('requests_per_minute BETWEEN 1 AND 10000'))
    op.create_index('uq_translation_default', 'translation_providers', ['is_default'], unique=True,
        sqlite_where=sa.text('is_default = 1'), postgresql_where=sa.text('is_default'))
    op.create_table('translation_provider_revisions',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('provider_id', sa.String(36), sa.ForeignKey('translation_providers.id'), nullable=False),
        sa.Column('channel', sa.String(40), nullable=False),
        sa.Column('config', sa.JSON(), nullable=False),
        sa.Column('api_key', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False))
    op.create_index('ix_translation_provider_revisions_provider_id', 'translation_provider_revisions', ['provider_id'])
    op.create_index('ix_text_calls_provider_started', 'text_calls', ['provider_id', 'started_at'])


def downgrade():
    op.drop_index('ix_text_calls_provider_started', table_name='text_calls')
    op.drop_table('translation_provider_revisions')
    op.drop_table('translation_providers')
