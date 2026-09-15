"""Initial membership/page-quota schema. Requires a fresh database; no credit migration."""
from alembic import op
import sqlalchemy as sa

revision = "membership_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('providers',
    sa.Column('id', sa.String(length=80), nullable=False),
    sa.Column('config', sa.JSON(), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('validated_at', sa.DateTime(), nullable=True),
    sa.Column('validation_job_id', sa.String(length=36), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('scheduler_state',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('last_owner_id', sa.String(length=36), nullable=False),
    sa.Column('sequence', sa.BigInteger(), nullable=False),
    sa.CheckConstraint('id = 1'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('storage_scans',
    sa.Column('backend', sa.String(length=20), nullable=False),
    sa.Column('cursor', sa.String(length=4096), nullable=True),
    sa.Column('next_scan_at', sa.DateTime(), nullable=False),
    sa.PrimaryKeyConstraint('backend')
    )
    op.create_table('users',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('subject', sa.String(length=255), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('role', sa.String(length=20), nullable=False),
    sa.Column('membership_id', sa.String(length=36), nullable=True),
    sa.Column('plus_started_at', sa.DateTime(), nullable=True),
    sa.Column('plus_expires_at', sa.DateTime(), nullable=True),
    sa.Column('plus_timezone', sa.String(length=80), nullable=True),
    sa.Column('plus_monthly_pages', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint('plus_monthly_pages >= 0'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('subject')
    )
    op.create_table('assets',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('parent_id', sa.String(length=36), nullable=True),
    sa.Column('storage_key', sa.String(length=200), nullable=False),
    sa.Column('storage_backend', sa.String(length=20), server_default='local', nullable=False),
    sa.Column('mime', sa.String(length=30), nullable=False),
    sa.Column('width', sa.Integer(), nullable=False),
    sa.Column('height', sa.Integer(), nullable=False),
    sa.Column('byte_size', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('expires_at', sa.DateTime(), nullable=False),
    sa.Column('deleted_at', sa.DateTime(), nullable=True),
    sa.Column('purged_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.ForeignKeyConstraint(['parent_id'], ['assets.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_assets_expires_at'), 'assets', ['expires_at'], unique=False)
    op.create_index(op.f('ix_assets_owner_id'), 'assets', ['owner_id'], unique=False)
    op.create_index(op.f('ix_assets_parent_id'), 'assets', ['parent_id'], unique=False)
    op.create_index(op.f('ix_assets_sha256'), 'assets', ['sha256'], unique=False)
    op.create_table('batches',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('preview_id', sa.String(length=36), nullable=False),
    sa.Column('idempotency_key', sa.String(length=128), nullable=False),
    sa.Column('request_hash', sa.String(length=64), nullable=False),
    sa.Column('quota_pages', sa.Integer(), nullable=False),
    sa.Column('cancel_requested', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('owner_id', 'idempotency_key'),
    sa.UniqueConstraint('preview_id')
    )
    op.create_index(op.f('ix_batches_owner_id'), 'batches', ['owner_id'], unique=False)
    op.create_table('membership_operations',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('transaction_key', sa.String(length=200), nullable=False),
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('operator_id', sa.String(length=36), nullable=False),
    sa.Column('request_hash', sa.String(length=64), nullable=False),
    sa.Column('details', sa.JSON(), nullable=False),
    sa.Column('result', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['operator_id'], ['users.id'], ),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('transaction_key')
    )
    op.create_index(op.f('ix_membership_operations_owner_id'), 'membership_operations', ['owner_id'], unique=False)
    op.create_table('quota_periods',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('kind', sa.String(length=30), nullable=False),
    sa.Column('mode', sa.String(length=20), nullable=False),
    sa.Column('source', sa.String(length=20), nullable=False),
    sa.Column('source_key', sa.String(length=200), nullable=False),
    sa.Column('note', sa.String(length=200), nullable=False),
    sa.Column('grants_access', sa.Boolean(), nullable=False),
    sa.Column('starts_at', sa.DateTime(), nullable=False),
    sa.Column('ends_at', sa.DateTime(), nullable=False),
    sa.Column('granted', sa.Integer(), nullable=False),
    sa.Column('used', sa.Integer(), nullable=False),
    sa.Column('reserved', sa.Integer(), nullable=False),
    sa.CheckConstraint("mode IN ('classic', 'redraw')"),
    sa.CheckConstraint("source IN ('daily', 'membership', 'grant')"),
    sa.CheckConstraint('ends_at > starts_at'),
    sa.CheckConstraint('granted >= used + reserved'),
    sa.CheckConstraint('reserved >= 0'),
    sa.CheckConstraint('used >= 0'),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('owner_id', 'source_key')
    )
    op.create_index(op.f('ix_quota_periods_owner_id'), 'quota_periods', ['owner_id'], unique=False)
    op.create_index('ix_quota_periods_owner_mode_end', 'quota_periods', ['owner_id', 'mode', 'ends_at'], unique=False)
    op.create_table('translation_previews',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('asset_ids', sa.JSON(), nullable=False),
    sa.Column('mode', sa.String(length=20), nullable=False),
    sa.Column('language', sa.String(length=20), nullable=False),
    sa.Column('config_version', sa.String(length=64), nullable=False),
    sa.Column('quota_pages', sa.Integer(), nullable=False),
    sa.Column('quota_kind', sa.String(length=30), nullable=False),
    sa.Column('entitlement_version', sa.String(length=64), nullable=False),
    sa.Column('new_pages', sa.Integer(), nullable=False),
    sa.Column('regenerate', sa.Boolean(), nullable=False),
    sa.Column('expires_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_translation_previews_owner_id'), 'translation_previews', ['owner_id'], unique=False)
    op.create_table('file_pages',
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('file_hash', sa.String(length=64), nullable=False),
    sa.Column('page_index', sa.Integer(), nullable=False),
    sa.Column('asset_id', sa.String(length=36), nullable=False),
    sa.CheckConstraint('page_index >= 0'),
    sa.ForeignKeyConstraint(['asset_id'], ['assets.id'], ),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('owner_id', 'file_hash', 'page_index')
    )
    op.create_index(op.f('ix_file_pages_asset_id'), 'file_pages', ['asset_id'], unique=False)
    op.create_table('jobs',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('input_asset_id', sa.String(length=36), nullable=False),
    sa.Column('output_asset_id', sa.String(length=36), nullable=True),
    sa.Column('batch_id', sa.String(length=36), nullable=True),
    sa.Column('ordinal', sa.Integer(), nullable=False),
    sa.Column('mode', sa.String(length=20), nullable=False),
    sa.Column('target_language', sa.String(length=20), nullable=False),
    sa.Column('status', sa.String(length=24), nullable=False),
    sa.Column('phase', sa.String(length=40), nullable=False),
    sa.Column('idempotency_key', sa.String(length=128), nullable=False),
    sa.Column('operation', sa.String(length=100), nullable=False),
    sa.Column('request_hash', sa.String(length=64), nullable=False),
    sa.Column('cache_key', sa.String(length=64), nullable=False),
    sa.Column('cache_hit', sa.Boolean(), nullable=False),
    sa.Column('config', sa.JSON(), nullable=False),
    sa.Column('quota_pages', sa.Integer(), nullable=False),
    sa.Column('quota_kind', sa.String(length=30), nullable=False),
    sa.Column('quota_period_id', sa.String(length=64), nullable=True),
    sa.Column('entitlement', sa.JSON(), nullable=False),
    sa.Column('settlement', sa.String(length=20), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('attempt_id', sa.String(length=36), nullable=True),
    sa.Column('cancel_requested', sa.Boolean(), nullable=False),
    sa.Column('discard_output', sa.Boolean(), nullable=False),
    sa.Column('error_code', sa.String(length=60), nullable=True),
    sa.Column('error_message', sa.String(length=300), nullable=True),
    sa.Column('quality_flags', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('completed_at', sa.DateTime(), nullable=True),
    sa.Column('unknown_since', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['batch_id'], ['batches.id'], ),
    sa.ForeignKeyConstraint(['input_asset_id'], ['assets.id'], ),
    sa.ForeignKeyConstraint(['output_asset_id'], ['assets.id'], ),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.ForeignKeyConstraint(['quota_period_id'], ['quota_periods.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('owner_id', 'operation', 'idempotency_key')
    )
    op.create_index(op.f('ix_jobs_batch_id'), 'jobs', ['batch_id'], unique=False)
    op.create_index(op.f('ix_jobs_cache_key'), 'jobs', ['cache_key'], unique=False)
    op.create_index(op.f('ix_jobs_input_asset_id'), 'jobs', ['input_asset_id'], unique=False)
    op.create_index(op.f('ix_jobs_owner_id'), 'jobs', ['owner_id'], unique=False)
    op.create_index('ix_jobs_owner_status_created', 'jobs', ['owner_id', 'status', 'created_at', 'ordinal', 'id'], unique=False)
    op.create_index(op.f('ix_jobs_quota_period_id'), 'jobs', ['quota_period_id'], unique=False)
    op.create_index(op.f('ix_jobs_status'), 'jobs', ['status'], unique=False)
    op.create_table('attempts',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('job_id', sa.String(length=36), nullable=False),
    sa.Column('provider_id', sa.String(length=80), nullable=False),
    sa.Column('output_storage_backend', sa.String(length=20), server_default='local', nullable=False),
    sa.Column('started_at', sa.DateTime(), nullable=False),
    sa.Column('heartbeat_at', sa.DateTime(), nullable=False),
    sa.Column('lease_expires_at', sa.DateTime(), nullable=False),
    sa.Column('call_started_at', sa.DateTime(), nullable=True),
    sa.Column('completed_at', sa.DateTime(), nullable=True),
    sa.Column('request_id', sa.String(length=200), nullable=True),
    sa.Column('usage', sa.JSON(), nullable=True),
    sa.Column('cost_state', sa.String(length=20), nullable=False),
    sa.Column('error_code', sa.String(length=60), nullable=True),
    sa.Column('recovered', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_attempts_job_id'), 'attempts', ['job_id'], unique=False)
    op.create_table('batch_items',
    sa.Column('batch_id', sa.String(length=36), nullable=False),
    sa.Column('ordinal', sa.Integer(), nullable=False),
    sa.Column('input_asset_id', sa.String(length=36), nullable=False),
    sa.Column('job_id', sa.String(length=36), nullable=False),
    sa.CheckConstraint('ordinal >= 0'),
    sa.ForeignKeyConstraint(['batch_id'], ['batches.id'], ),
    sa.ForeignKeyConstraint(['input_asset_id'], ['assets.id'], ),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
    sa.PrimaryKeyConstraint('batch_id', 'ordinal')
    )
    op.create_index(op.f('ix_batch_items_job_id'), 'batch_items', ['job_id'], unique=False)
    op.create_table('classic_states',
    sa.Column('job_id', sa.String(length=36), nullable=False),
    sa.Column('analysis', sa.JSON(), nullable=True),
    sa.Column('translations', sa.JSON(), nullable=False),
    sa.Column('timings', sa.JSON(), nullable=False),
    sa.Column('artifacts', sa.JSON(), nullable=False),
    sa.Column('local_attempts', sa.Integer(), nullable=False),
    sa.Column('started_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
    sa.PrimaryKeyConstraint('job_id')
    )
    op.create_table('job_requests',
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('operation', sa.String(length=100), nullable=False),
    sa.Column('idempotency_key', sa.String(length=128), nullable=False),
    sa.Column('request_hash', sa.String(length=64), nullable=False),
    sa.Column('job_id', sa.String(length=36), nullable=False),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('owner_id', 'operation', 'idempotency_key')
    )
    op.create_index(op.f('ix_job_requests_job_id'), 'job_requests', ['job_id'], unique=False)
    op.create_table('outbox',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('job_id', sa.String(length=36), nullable=False),
    sa.Column('published_at', sa.DateTime(), nullable=True),
    sa.Column('publish_attempts', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('job_id')
    )
    op.create_table('queue_admissions',
    sa.Column('job_id', sa.String(length=36), nullable=False),
    sa.Column('token', sa.String(length=36), nullable=False),
    sa.Column('sequence', sa.BigInteger(), nullable=False),
    sa.Column('admitted_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
    sa.PrimaryKeyConstraint('job_id'),
    sa.UniqueConstraint('sequence'),
    sa.UniqueConstraint('token')
    )
    op.create_table('translation_feedback',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('job_id', sa.String(length=36), nullable=False),
    sa.Column('output_asset_id', sa.String(length=36), nullable=False),
    sa.Column('issues', sa.JSON(), nullable=False),
    sa.Column('comment', sa.String(length=500), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('idempotency_key', sa.String(length=128), nullable=False),
    sa.Column('request_hash', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
    sa.ForeignKeyConstraint(['output_asset_id'], ['assets.id'], ),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('owner_id', 'idempotency_key')
    )
    op.create_index('ix_feedback_job', 'translation_feedback', ['job_id'], unique=False)
    op.create_index('ix_feedback_owner_created', 'translation_feedback', ['owner_id', 'created_at'], unique=False)
    op.create_table('usage_ledger',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('owner_id', sa.String(length=36), nullable=False),
    sa.Column('job_id', sa.String(length=36), nullable=True),
    sa.Column('period_id', sa.String(length=64), nullable=True),
    sa.Column('quota_kind', sa.String(length=30), nullable=True),
    sa.Column('transaction_key', sa.String(length=200), nullable=False),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('amount', sa.Integer(), nullable=False),
    sa.Column('note', sa.String(length=200), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
    sa.ForeignKeyConstraint(['period_id'], ['quota_periods.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('transaction_key')
    )
    op.create_index('ix_ledger_owner_created', 'usage_ledger', ['owner_id', 'created_at'], unique=False)
    op.create_index(op.f('ix_usage_ledger_owner_id'), 'usage_ledger', ['owner_id'], unique=False)
    op.create_index(op.f('ix_usage_ledger_period_id'), 'usage_ledger', ['period_id'], unique=False)
    op.create_table('text_calls',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('job_id', sa.String(length=36), nullable=False),
    sa.Column('attempt_id', sa.String(length=36), nullable=False),
    sa.Column('group_index', sa.Integer(), nullable=False),
    sa.Column('sequence', sa.Integer(), nullable=False),
    sa.Column('provider_id', sa.String(length=80), nullable=False),
    sa.Column('model', sa.String(length=120), nullable=False),
    sa.Column('request_id', sa.String(length=200), nullable=True),
    sa.Column('usage', sa.JSON(), nullable=True),
    sa.Column('reserved_micros', sa.Integer(), nullable=False),
    sa.Column('accounted_micros', sa.Integer(), nullable=False),
    sa.Column('cost_state', sa.String(length=24), nullable=False),
    sa.Column('error_code', sa.String(length=60), nullable=True),
    sa.Column('started_at', sa.DateTime(), nullable=False),
    sa.Column('completed_at', sa.DateTime(), nullable=True),
    sa.CheckConstraint('accounted_micros >= 0'),
    sa.ForeignKeyConstraint(['attempt_id'], ['attempts.id'], ),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('job_id', 'group_index', 'sequence')
    )
    op.create_index(op.f('ix_text_calls_job_id'), 'text_calls', ['job_id'], unique=False)
    op.execute(sa.text("INSERT INTO scheduler_state (id, last_owner_id, sequence) VALUES (1, '', 0)"))


def downgrade():
    op.drop_index(op.f('ix_text_calls_job_id'), table_name='text_calls')
    op.drop_table('text_calls')
    op.drop_index(op.f('ix_usage_ledger_period_id'), table_name='usage_ledger')
    op.drop_index(op.f('ix_usage_ledger_owner_id'), table_name='usage_ledger')
    op.drop_index('ix_ledger_owner_created', table_name='usage_ledger')
    op.drop_table('usage_ledger')
    op.drop_index('ix_feedback_owner_created', table_name='translation_feedback')
    op.drop_index('ix_feedback_job', table_name='translation_feedback')
    op.drop_table('translation_feedback')
    op.drop_table('queue_admissions')
    op.drop_table('outbox')
    op.drop_index(op.f('ix_job_requests_job_id'), table_name='job_requests')
    op.drop_table('job_requests')
    op.drop_table('classic_states')
    op.drop_index(op.f('ix_batch_items_job_id'), table_name='batch_items')
    op.drop_table('batch_items')
    op.drop_index(op.f('ix_attempts_job_id'), table_name='attempts')
    op.drop_table('attempts')
    op.drop_index(op.f('ix_jobs_status'), table_name='jobs')
    op.drop_index(op.f('ix_jobs_quota_period_id'), table_name='jobs')
    op.drop_index('ix_jobs_owner_status_created', table_name='jobs')
    op.drop_index(op.f('ix_jobs_owner_id'), table_name='jobs')
    op.drop_index(op.f('ix_jobs_input_asset_id'), table_name='jobs')
    op.drop_index(op.f('ix_jobs_cache_key'), table_name='jobs')
    op.drop_index(op.f('ix_jobs_batch_id'), table_name='jobs')
    op.drop_table('jobs')
    op.drop_index(op.f('ix_file_pages_asset_id'), table_name='file_pages')
    op.drop_table('file_pages')
    op.drop_index(op.f('ix_translation_previews_owner_id'), table_name='translation_previews')
    op.drop_table('translation_previews')
    op.drop_index('ix_quota_periods_owner_mode_end', table_name='quota_periods')
    op.drop_index(op.f('ix_quota_periods_owner_id'), table_name='quota_periods')
    op.drop_table('quota_periods')
    op.drop_index(op.f('ix_membership_operations_owner_id'), table_name='membership_operations')
    op.drop_table('membership_operations')
    op.drop_index(op.f('ix_batches_owner_id'), table_name='batches')
    op.drop_table('batches')
    op.drop_index(op.f('ix_assets_sha256'), table_name='assets')
    op.drop_index(op.f('ix_assets_parent_id'), table_name='assets')
    op.drop_index(op.f('ix_assets_owner_id'), table_name='assets')
    op.drop_index(op.f('ix_assets_expires_at'), table_name='assets')
    op.drop_table('assets')
    op.drop_table('users')
    op.drop_table('storage_scans')
    op.drop_table('scheduler_state')
    op.drop_table('providers')
