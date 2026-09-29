"""Local immutable artifacts, independent of temporary input files."""
from alembic import op
import sqlalchemy as sa

revision = 'local_overlay_0007'
down_revision = 'quota_campaigns_0006'
branch_labels = None
depends_on = None


def upgrade():
    # Never fetch, copy or delete remote objects during schema migration.
    op.add_column('assets', sa.Column('representation', sa.String(24), nullable=False, server_default='original'))
    op.add_column('assets', sa.Column('bbox', sa.JSON(), nullable=True))
    op.add_column('assets', sa.Column('normalization_version', sa.Integer(), nullable=False, server_default='1'))
    op.add_column('jobs', sa.Column('result_description', sa.JSON(), nullable=False, server_default='{}'))


def downgrade():
    assets = sa.table('assets', sa.column('representation', sa.String()), sa.column('storage_key', sa.String()))
    jobs = sa.table('jobs', sa.column('result_description', sa.JSON()))
    connection = op.get_bind()
    if connection.scalar(sa.select(sa.func.count()).select_from(assets).where(sa.or_(assets.c.representation.in_(['overlay-v1', 'full-image-v1']), assets.c.storage_key.like('inputs/%'), assets.c.storage_key.like('results/%')))) or connection.scalar(
            sa.select(sa.func.count()).select_from(jobs).where(jobs.c.result_description['representation'].as_string().in_(['overlay-v1', 'original', 'full-image-v1']))):
        raise RuntimeError('Overlay artifacts cannot be read by the previous full-image protocol')
    # Rollback is safe only before local task inputs or new-protocol deliveries exist.
    op.drop_column('jobs', 'result_description')
    for name in ('normalization_version', 'bbox', 'representation'):
        op.drop_column('assets', name)
