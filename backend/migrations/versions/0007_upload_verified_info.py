"""Persist verified upload intent before writing the immutable original."""
from alembic import op
import sqlalchemy as sa

revision = 'shared_0007_upload_verified_info'
down_revision = 'shared_0006_compute_v2'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('upload_reservations', table_args=(sa.CheckConstraint('expected_size > 0'),)) as batch:
        batch.add_column(sa.Column('verified_info', sa.JSON(), nullable=True))
        batch.drop_column('storage_key')


def downgrade():
    raise RuntimeError('Upload protocol rollback is not supported')
