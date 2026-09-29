"""One account-private job result; revoke obsolete shared authorizations.

Financial jobs, ledgers, quotas, calls and feedback remain intact. Legacy shared
UUIDs become revoked tombstones; no remote bytes are copied or deleted.
"""
from datetime import datetime, timezone
import json
from alembic import op
import sqlalchemy as sa

revision = 'job_results_0008'
down_revision = 'local_overlay_0007'
branch_labels = None
depends_on = None


NAMING = {'fk': 'fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s',
          'ck': 'ck_%(table_name)s_%(column_0_name)s'}


def remove_access_column(table):
    inspector = sa.inspect(op.get_bind())
    checks = inspector.get_check_constraints(table)
    foreign = inspector.get_foreign_keys(table)
    indexes = inspector.get_indexes(table)
    with op.batch_alter_table(table, naming_convention=NAMING) as batch:
        for check in checks:
            if 'access_id' in check['sqltext']:
                batch.drop_constraint(check['name'] or f'ck_{table}_', type_='check')
        for key in foreign:
            if key['constrained_columns'] == ['access_id']:
                batch.drop_constraint(key['name'] or f'fk_{table}_access_id_result_accesses', type_='foreignkey')
        for index in indexes:
            if 'access_id' in index['column_names']:
                batch.drop_index(index['name'])
        batch.drop_column('access_id')
        if table == 'translation_requests':
            batch.create_check_constraint('ck_translation_request_job_or_tombstone',
                                          'job_id IS NOT NULL OR revoked_at IS NOT NULL')
        else:
            batch.alter_column('job_id', existing_type=sa.String(36), nullable=False)


def upgrade():
    db = op.get_bind()
    stamp = datetime.now(timezone.utc).replace(tzinfo=None)
    active_remote = db.scalar(sa.text("""SELECT count(*) FROM jobs j WHERE j.status IN
        ('queued','running','awaiting_upload','validating_upload','outcome_unknown','unknown_released') AND (
        EXISTS (SELECT 1 FROM assets a WHERE a.id=j.input_asset_id AND a.storage_backend <> 'local') OR
        EXISTS (SELECT 1 FROM upload_reservations u WHERE u.job_id=j.id AND u.storage_backend <> 'local') OR
        EXISTS (SELECT 1 FROM attempts a WHERE a.id=j.attempt_id AND a.output_storage_backend <> 'local'))"""))
    if active_remote:
        raise RuntimeError('Drain or reconcile legacy remote jobs before removing their storage protocol')
    op.add_column('translation_requests', sa.Column('legacy_execution_resolved', sa.Boolean(),
        nullable=False, server_default=sa.false()))
    if db.dialect.name == 'sqlite':
        db.exec_driver_sql('PRAGMA defer_foreign_keys=ON')
    # Preserve feedback as an audit record of the real generation. It grants no
    # image/OCR access to the former recipient of a shared result.
    db.execute(sa.text("""UPDATE translation_feedback SET job_id=(SELECT result_id FROM result_accesses
        WHERE result_accesses.id=translation_feedback.access_id), access_id=NULL WHERE access_id IS NOT NULL"""))
    requests = sa.table('translation_requests', sa.column('owner_id', sa.String()), sa.column('id', sa.String()),
        sa.column('descriptor', sa.JSON()), sa.column('revoked_at', sa.DateTime()),
        sa.column('legacy_execution_resolved', sa.Boolean()))
    legacy = db.execute(sa.text("""SELECT r.owner_id,r.id,r.descriptor,j.mode,j.target_language,
        j.source_sha256,a.byte_size,a.mime,
        CASE WHEN t.id IS NOT NULL AND j.status IN ('succeeded','no_text') AND j.completed_at IS NOT NULL
        AND j.settlement IN ('settled','released')
        AND NOT EXISTS (SELECT 1 FROM execution_leases l WHERE l.job_id=j.id AND l.completed_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM text_calls c WHERE c.job_id=j.id AND c.completed_at IS NULL)
        AND (EXISTS (SELECT 1 FROM usage_ledger u WHERE u.job_id=j.id AND u.owner_id=j.owner_id
                AND u.kind='reconcile' AND u.transaction_key=j.id || :reconcile_suffix) OR (
            (EXISTS (SELECT 1 FROM attempts p WHERE p.job_id=j.id AND p.id=j.attempt_id)
                OR (j.attempt_id IS NULL AND j.status='no_text'))
            AND NOT EXISTS (SELECT 1 FROM attempts p WHERE p.job_id=j.id AND p.call_started_at IS NOT NULL
                AND (p.completed_at IS NULL OR p.cost_state NOT IN ('reported','estimated')))
            AND NOT EXISTS (SELECT 1 FROM text_calls c WHERE c.job_id=j.id
                AND c.cost_state NOT IN ('reported','estimated'))))
        THEN true ELSE false END AS execution_resolved FROM translation_requests r
        JOIN result_accesses x ON x.id=r.access_id JOIN jobs j ON j.id=x.result_id
        LEFT JOIN translation_results t ON t.id=j.id
        JOIN assets a ON a.id=x.input_asset_id"""), {'reconcile_suffix': ':reconcile'})
    for row in legacy:
        descriptor = json.loads(row.descriptor) if isinstance(row.descriptor, str) else row.descriptor
        if not descriptor or not descriptor.get('image'):
            descriptor = {'mode': row.mode, 'target_language': row.target_language,
                'image': {'sha256': row.source_sha256, 'byte_size': row.byte_size,
                          'content_type': row.mime, 'normalization_version': 1}}
        db.execute(requests.update().where(requests.c.owner_id == row.owner_id, requests.c.id == row.id)
                   .values(descriptor=descriptor, revoked_at=stamp,
                           legacy_execution_resolved=bool(row.execution_resolved)))
    # Remote history is deliberately unavailable after this protocol cutover.
    db.execute(sa.text("""UPDATE translation_requests SET revoked_at=COALESCE(revoked_at,:stamp)
        WHERE job_id IN (SELECT j.id FROM jobs j JOIN assets a
        ON a.id=j.input_asset_id OR a.id=j.output_asset_id WHERE a.storage_backend <> 'local')"""), {'stamp': stamp})
    db.execute(sa.text("UPDATE assets SET deleted_at=COALESCE(deleted_at,:stamp) WHERE storage_backend <> 'local'"), {'stamp': stamp})
    remove_access_column('translation_feedback')
    remove_access_column('translation_requests')
    op.drop_table('file_pages')
    op.drop_table('result_accesses')
    op.drop_table('translation_results')
    with op.batch_alter_table('assets') as batch:
        batch.drop_index('ix_assets_storage_key')
        batch.drop_column('storage_backend')
        batch.drop_index('ix_assets_last_accessed_at')
        batch.drop_column('last_accessed_at')
        batch.create_index('ix_assets_storage_key', ['storage_key'])
    with op.batch_alter_table('attempts') as batch:
        batch.drop_column('output_storage_backend')
    with op.batch_alter_table('upload_reservations', table_args=[sa.CheckConstraint(c['sqltext'])
            for c in sa.inspect(db).get_check_constraints('upload_reservations') if not c['name']]) as batch:
        batch.drop_column('storage_backend')
    if db.dialect.name == 'sqlite':
        # Recreated parent tables leave SQLite's deferred counter stale even
        # after every reference resolves. Verify all references before reset.
        if db.exec_driver_sql('PRAGMA foreign_key_check').first() is not None:
            raise RuntimeError('Foreign key validation failed after job-result cutover')
        db.exec_driver_sql('PRAGMA defer_foreign_keys=OFF')


def downgrade():
    raise RuntimeError('Shared authorizations were revoked; restore the paired pre-cutover backup to roll back')
