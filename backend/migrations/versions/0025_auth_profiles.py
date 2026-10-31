"""Additive admin profile cache and per-user sync queue."""
from alembic import op
import sqlalchemy as sa

revision = 'auth_profiles_0025'
down_revision = 'admin_workspace_0024'
branch_labels = depends_on = None


def upgrade():
    op.create_table('user_auth_profiles',
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('email', sa.String(320)), sa.Column('username', sa.String(128)),
        sa.Column('name', sa.String(256)), sa.Column('phone', sa.String(64)),
        sa.Column('suspended', sa.Boolean()), sa.Column('deleted', sa.Boolean(), nullable=False, server_default='0'),
        sa.Column('auth_created_at', sa.DateTime()), sa.Column('last_sign_in_at', sa.DateTime()),
        sa.Column('synced_at', sa.DateTime()), sa.Column('attempted_at', sa.DateTime()),
        sa.Column('event_at', sa.DateTime()), sa.Column('next_sync_at', sa.DateTime()),
        sa.Column('generation', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('claim', sa.String(36)), sa.Column('error_code', sa.String(32)))
    op.create_index('ix_auth_profiles_due', 'user_auth_profiles', ['next_sync_at', 'owner_id'])


def downgrade():
    op.drop_table('user_auth_profiles')
