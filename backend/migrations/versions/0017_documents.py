"""Bounded R2 documents share jobs, page allowances and fenced stage leases."""
from importlib import import_module
from alembic import op
import sqlalchemy as sa

revision = 'documents_0017'
down_revision = 'subscription_customer_0016'
branch_labels = None
depends_on = None
_table = import_module('migrations.versions.0014_quota_purchases')._table


def upgrade():
    connection = op.get_bind()
    with _table('jobs') as batch:
        batch.add_column(sa.Column('workflow_kind', sa.String(16), nullable=False, server_default='image'))
        batch.create_check_constraint('ck_job_workflow', "workflow_kind IN ('image', 'document')")
    op.create_index('ix_jobs_owner_workflow_created', 'jobs', ['owner_id', 'workflow_kind', 'created_at', 'id'])

    if connection.dialect.name == 'sqlite':
        # The baseline UNIQUE(job_id,name) is unnamed. Remove it from an exact
        # reflected copy, preserving existing leases and all other constraints.
        if not connection.connection.driver_connection.in_transaction:
            connection.exec_driver_sql('BEGIN IMMEDIATE')
        deferred = connection.exec_driver_sql('PRAGMA defer_foreign_keys').scalar()
        connection.exec_driver_sql('PRAGMA defer_foreign_keys = ON')
        stages = sa.Table('job_stages', sa.MetaData(), autoload_with=connection)
        for constraint in list(stages.constraints):
            if isinstance(constraint, sa.UniqueConstraint) and list(constraint.columns.keys()) == ['job_id', 'name']:
                stages.constraints.remove(constraint)
        with op.batch_alter_table('job_stages', copy_from=stages, recreate='always') as batch:
            batch.add_column(sa.Column('page_index', sa.Integer(), nullable=False, server_default='0'))
            batch.create_unique_constraint('uq_job_stage_page', ['job_id', 'name', 'page_index'])
        if connection.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
            raise RuntimeError('Document migration must preserve existing stage leases')
        if not deferred:
            connection.exec_driver_sql('PRAGMA defer_foreign_keys = OFF')
    else:
        old = next(item for item in sa.inspect(connection).get_unique_constraints('job_stages')
                   if item['column_names'] == ['job_id', 'name'])
        op.add_column('job_stages', sa.Column('page_index', sa.Integer(), nullable=False, server_default='0'))
        op.drop_constraint(old['name'], 'job_stages', type_='unique')
        op.create_unique_constraint('uq_job_stage_page', 'job_stages', ['job_id', 'name', 'page_index'])
    with _table('text_calls') as batch:
        batch.alter_column('reserved_micros', existing_type=sa.Integer(), type_=sa.BigInteger(), existing_nullable=False)
        batch.alter_column('accounted_micros', existing_type=sa.Integer(), type_=sa.BigInteger(), existing_nullable=False)

    op.create_table('documents',
        sa.Column('job_id', sa.String(36), sa.ForeignKey('jobs.id'), primary_key=True),
        sa.Column('filename', sa.String(240), nullable=False),
        sa.Column('source_type', sa.String(8), nullable=False),
        sa.Column('source_key', sa.String(300), nullable=False, unique=True),
        sa.Column('upload_id', sa.String(1024)),
        sa.Column('source_size', sa.Integer(), nullable=False),
        sa.Column('source_sha256', sa.String(64), nullable=False),
        sa.Column('page_count', sa.Integer()),
        sa.Column('manifest_sha256', sa.String(64)),
        sa.Column('upload_completed_at', sa.DateTime()),
        sa.Column('reserved_at', sa.DateTime()),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('output_ref', sa.JSON()),
        sa.Column('text_input_ref', sa.JSON()),
        sa.Column('text_output_ref', sa.JSON()),
        sa.Column('text_request_sha256', sa.String(64)),
        sa.Column('text_call_id', sa.String(36), sa.ForeignKey('text_calls.id')),
        sa.Column('text_state', sa.String(24), nullable=False),
        sa.Column('cleanup_after', sa.DateTime()),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.CheckConstraint("source_type IN ('zip', 'pdf')", name='ck_document_type'),
        sa.CheckConstraint('source_size > 0 AND source_size <= 200000000', name='ck_document_size'),
        sa.CheckConstraint('page_count IS NULL OR page_count BETWEEN 1 AND 200', name='ck_document_pages'))
    op.create_index('ix_documents_expires_at', 'documents', ['expires_at'])
    op.create_index('ix_documents_cleanup_after', 'documents', ['cleanup_after'])
    op.create_table('document_quota_allocations',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('job_id', sa.String(36), sa.ForeignKey('documents.job_id'), nullable=False),
        sa.Column('period_id', sa.String(64), sa.ForeignKey('quota_periods.id')),
        sa.Column('billing_term_id', sa.String(64), sa.ForeignKey('billing_terms.id')),
        sa.Column('entitlement', sa.JSON(), nullable=False),
        sa.Column('pages', sa.Integer(), nullable=False),
        sa.Column('reserved', sa.Integer(), nullable=False),
        sa.Column('used', sa.Integer(), nullable=False),
        sa.Column('released', sa.Integer(), nullable=False),
        sa.UniqueConstraint('job_id', 'period_id', name='uq_document_period'),
        sa.UniqueConstraint('job_id', 'billing_term_id', name='uq_document_unlimited_term'),
        sa.UniqueConstraint('id', 'job_id', name='uq_document_allocation_job'),
        sa.CheckConstraint('(period_id IS NOT NULL AND billing_term_id IS NULL) OR '
                           '(period_id IS NULL AND billing_term_id IS NOT NULL)', name='ck_document_allocation_source'),
        sa.CheckConstraint('pages BETWEEN 1 AND 200 AND reserved >= 0 AND used >= 0 AND released >= 0 '
                           'AND pages = reserved + used + released', name='ck_document_allocation_balance'))
    op.create_index('ix_document_quota_allocations_job_id', 'document_quota_allocations', ['job_id'])
    op.create_index('ix_document_quota_allocations_period_id', 'document_quota_allocations', ['period_id'])
    op.create_table('document_pages',
        sa.Column('job_id', sa.String(36), sa.ForeignKey('documents.job_id'), primary_key=True),
        sa.Column('page_index', sa.Integer(), primary_key=True),
        sa.Column('allocation_id', sa.String(36)),
        sa.Column('source_name', sa.String(300), nullable=False),
        sa.Column('input_ref', sa.JSON()), sa.Column('analysis_ref', sa.JSON()),
        sa.Column('text_ref', sa.JSON()), sa.Column('translations_ref', sa.JSON()), sa.Column('output_ref', sa.JSON()),
        sa.Column('status', sa.String(24), nullable=False),
        sa.Column('quality_flags', sa.JSON(), nullable=False),
        sa.Column('billable', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['allocation_id', 'job_id'],
                                ['document_quota_allocations.id', 'document_quota_allocations.job_id']),
        sa.CheckConstraint('page_index BETWEEN 1 AND 200', name='ck_document_page_index'))
    op.create_index('ix_document_pages_status', 'document_pages', ['job_id', 'status'])


def downgrade():
    raise RuntimeError('Document jobs and quota receipts require matching code; restore a consistent backup to roll back')
