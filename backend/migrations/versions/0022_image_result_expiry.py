"""Index pending image expiry without rescanning already reclaimed history."""
from alembic import op
import sqlalchemy as sa

revision = 'image_result_expiry_0022'
down_revision = 'checkout_aliases_0021'
branch_labels = None
depends_on = None


def upgrade():
    predicate = sa.text("workflow_kind = 'image' AND quota_kind != 'guest_trial' "
        "AND status IN ('succeeded', 'no_text') AND discard_output IS FALSE")
    # Large live databases may prebuild this same index CONCURRENTLY before migration.
    op.create_index('ix_jobs_image_result_expiry', 'jobs', ['completed_at', 'id'],
        sqlite_where=predicate, postgresql_where=predicate, if_not_exists=True)


def downgrade():
    op.drop_index('ix_jobs_image_result_expiry', table_name='jobs')
