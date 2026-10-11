"""Pin document files to one durable node workspace; retain central text receipts."""
from importlib import import_module
from alembic import op
import sqlalchemy as sa

revision = 'document_workspaces_0018'
down_revision = 'documents_0017'
branch_labels = None
depends_on = None
_table = import_module('migrations.versions.0014_quota_purchases')._table


def upgrade():
    connection = op.get_bind()
    # Old page descriptors name R2 objects and cannot be interpreted as local
    # files. Never cancel, release paid reservations, or resend an unknown call
    # as a side effect of a schema upgrade. Drain/resolve these with old code.
    active = connection.execute(sa.text("SELECT 1 FROM jobs WHERE workflow_kind = 'document' "
        "AND status NOT IN ('succeeded', 'failed', 'cancelled') LIMIT 1")).first()
    if active:
        raise RuntimeError('Document v2 upgrade requires all existing document jobs to be terminal; '
                           'resolve active uploads, reservations and unknown LLM calls with the old version first')
    with _table('documents') as batch:
        batch.add_column(sa.Column('owner_node_id', sa.String(80), nullable=True))
        batch.create_foreign_key('fk_document_workspace_node', 'compute_nodes', ['owner_node_id'], ['id'])
        batch.add_column(sa.Column('workspace_generation', sa.Integer(), nullable=False, server_default='1'))
        batch.add_column(sa.Column('text_input_payload', sa.JSON(), nullable=True))
        batch.add_column(sa.Column('text_output_payload', sa.JSON(), nullable=True))
        batch.create_check_constraint('ck_document_workspace_generation', 'workspace_generation >= 1')
    op.create_index('ix_documents_owner_node_id', 'documents', ['owner_node_id'])
    # Administrators still own capacity; only the pool's supported work changes.
    nodes = sa.table('compute_nodes', sa.column('id'), sa.column('capabilities', sa.JSON()))
    connection.execute(nodes.update().where(nodes.c.id == 'control-document').values(capabilities=['doc_text']))


def downgrade():
    raise RuntimeError('Local document workspaces require matching code; restore a consistent backup to roll back')
