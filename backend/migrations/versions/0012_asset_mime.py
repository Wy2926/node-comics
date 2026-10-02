"""Allow MIME types for negotiated overlay tile containers."""
from alembic import op
import sqlalchemy as sa

revision = 'asset_mime_0012'
down_revision = 'hourly_image_limit_0011'
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    if connection.dialect.name != 'sqlite':
        op.alter_column('assets', 'mime', existing_type=sa.String(30), type_=sa.String(128), existing_nullable=False)
        return
    # SQLite must rebuild this parent table. Defer its NO ACTION references
    # until the replacement exists; keep foreign-key enforcement enabled.
    # The sqlite3 legacy transaction mode does not BEGIN for DDL; without an
    # actual transaction CREATE TABLE would immediately reset the deferral.
    if not connection.connection.driver_connection.in_transaction:
        connection.exec_driver_sql('BEGIN')
    deferred = connection.exec_driver_sql('PRAGMA defer_foreign_keys').scalar()
    connection.exec_driver_sql('PRAGMA defer_foreign_keys=ON')
    try:
        with op.batch_alter_table('assets') as batch:
            batch.alter_column('mime', existing_type=sa.String(30), type_=sa.String(128), existing_nullable=False)
        if connection.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
            raise RuntimeError('Asset MIME migration left an invalid foreign-key reference')
    finally:
        if not deferred:
            connection.exec_driver_sql('PRAGMA defer_foreign_keys=OFF')


def downgrade():
    raise RuntimeError('Tile artifacts require the expanded MIME column; restore a consistent backup to roll back')
