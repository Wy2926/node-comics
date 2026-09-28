"""Replace ephemeral admission tables with shared Redis state."""
from alembic import op
import sqlalchemy as sa

revision = 'redis_admission_0004'
down_revision = 'text_routing_0003'
branch_labels = None
depends_on = None

TABLES = ('comic_title_admissions', 'control_admissions', 'image_admissions',
    'feedback_admissions', 'support_request_admissions', 'upload_ingress_leases', 'upload_ingress_mutex')


def upgrade():
    # Drain API uploads and stop old workers before upgrading all replicas.
    # These transient counters restart empty; durable receipts/quotas are untouched.
    for name in TABLES:
        op.drop_table(name)
    # Also accept the unpublished predecessor used in local routing development.
    if sa.inspect(op.get_bind()).has_table('translation_provider_requests'):
        op.drop_table('translation_provider_requests')


def downgrade():
    # A rollback restores schemas, never resurrects expired tokens/counters.
    op.create_table('comic_title_admissions',
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), primary_key=True),
        sa.Column('request_times', sa.JSON(), nullable=False))
    op.create_table('control_admissions',
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), primary_key=True),
        sa.Column('scope', sa.String(24), primary_key=True),
        sa.Column('tokens', sa.Float(), nullable=False),
        sa.Column('refilled_at', sa.DateTime(), nullable=False),
        sa.Column('leases', sa.JSON(), nullable=False))
    op.create_table('image_admissions',
        sa.Column('job_id', sa.String(36), sa.ForeignKey('jobs.id'), primary_key=True),
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('admitted_at', sa.DateTime(), nullable=False))
    op.create_index('ix_image_admissions_owner_time', 'image_admissions', ['owner_id', 'admitted_at'])
    op.create_table('feedback_admissions',
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), primary_key=True),
        sa.Column('request_tokens', sa.Float(), nullable=False),
        sa.Column('refilled_at', sa.DateTime(), nullable=False),
        sa.Column('day_started_at', sa.DateTime(), nullable=False),
        sa.Column('daily_receipts', sa.Integer(), nullable=False),
        sa.CheckConstraint('daily_receipts >= 0', name='ck_feedback_admissions_daily_receipts'))
    op.create_table('support_request_admissions',
        sa.Column('client_hash', sa.String(64), primary_key=True),
        sa.Column('minute_started_at', sa.DateTime(), nullable=False),
        sa.Column('minute_count', sa.Integer(), nullable=False),
        sa.Column('day_started_at', sa.DateTime(), nullable=False),
        sa.Column('day_count', sa.Integer(), nullable=False))
    op.create_index('ix_support_request_admissions_day_started_at', 'support_request_admissions', ['day_started_at'])
    op.create_table('upload_ingress_mutex', sa.Column('id', sa.Integer(), primary_key=True))
    op.create_table('upload_ingress_leases',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('upload_id', sa.String(36), sa.ForeignKey('upload_reservations.id'), nullable=False, unique=True),
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False))
    op.create_index('ix_upload_ingress_leases_owner_id', 'upload_ingress_leases', ['owner_id'])
    op.create_index('ix_upload_ingress_leases_expires_at', 'upload_ingress_leases', ['expires_at'])
