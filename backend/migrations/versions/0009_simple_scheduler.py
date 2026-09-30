"""FIFO scheduling; build fingerprints no longer partition compatible v3 work."""
import hashlib
import json

from alembic import op
import sqlalchemy as sa

revision = 'simple_scheduler_0009'
down_revision = 'job_results_0008'
branch_labels = None
depends_on = None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True,
        separators=(',', ':')).encode()).hexdigest()


def upgrade():
    db = op.get_bind()
    # Bounded migration; never change request UUIDs, checkpoints, calls or settlement.
    jobs = sa.table('jobs', sa.column('id', sa.String()), sa.column('mode', sa.String()),
        sa.column('config', sa.JSON()), sa.column('cache_key', sa.String()),
        sa.column('source_sha256', sa.String()), sa.column('target_language', sa.String()))
    cursor = ''
    while rows := db.execute(sa.select(jobs).where(jobs.c.mode == 'classic', jobs.c.id > cursor)
                            .order_by(jobs.c.id).limit(500)).mappings().all():
        for row in rows:
            config = dict(row['config'])
            if config.get('engine', {}).get('protocol_version') != 3:
                continue
            config.pop('version', None)
            config['engine'] = {'protocol_version': 3}
            config['version'] = digest(config)
            key = digest({'hash': row['source_sha256'], 'mode': 'classic',
                'language': row['target_language'], 'config_version': config['version'],
                'normalization_version': 1, 'result_protocol': 'overlay-v1'})
            db.execute(jobs.update().where(jobs.c.id == row['id']).values(config=config, cache_key=key))
        cursor = rows[-1]['id']

    nodes = sa.table('compute_nodes', sa.column('id', sa.String()), sa.column('desired_config', sa.JSON()),
        sa.column('supported_languages', sa.JSON()), sa.column('runtime_report', sa.JSON()))
    for row in db.execute(sa.select(nodes)).mappings().all():
        config = dict(row['desired_config'])
        config.pop('allowed_languages', None)
        languages = row['runtime_report'].get('languages', row['supported_languages'])
        db.execute(nodes.update().where(nodes.c.id == row['id']).values(
            desired_config=config, supported_languages=languages))
    system = sa.table('system_settings', sa.column('id', sa.Integer()), sa.column('values', sa.JSON()))
    for row in db.execute(sa.select(system)).mappings().all():
        values = dict(row['values'])
        values.pop('free_scheduler_weight', None)
        values.pop('plus_scheduler_weight', None)
        db.execute(system.update().where(system.c.id == row['id']).values(values=values))
    op.drop_table('fairness_states')
    op.drop_table('user_mode_queues')
    op.drop_index('ix_jobs_realtime_until', table_name='jobs')
    # Native DROP COLUMN avoids SQLite table rebuilds with live foreign keys.
    for column in ('priority_rank', 'realtime_until'):
        op.drop_column('jobs', column)
    for column in ('priority_class', 'weight', 'estimated_seconds'):
        op.drop_column('execution_leases', column)
    op.drop_index('ix_stage_ready', table_name='job_stages')
    op.create_index('ix_stage_ready', 'job_stages', ['status', 'name', 'available_at', 'id'])
    op.create_index('ix_lease_node_active', 'execution_leases', ['node_id', 'completed_at'])


def downgrade():
    raise RuntimeError('FIFO scheduling requires restoring a pre-upgrade database backup for rollback')
