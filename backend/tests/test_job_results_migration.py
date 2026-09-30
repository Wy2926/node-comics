"""Cutover removes obsolete grants without deleting financial or request evidence."""
from pathlib import Path
from datetime import datetime
from alembic import command
from alembic.config import Config
from sqlalchemy import Column, Integer, MetaData, inspect, select, text
import os
import pytest
from test_postgres_concurrency import pg_scope
from test_request_limits_migration import isolated_migration_database


def legacy_jobs():
    from app.models import Job
    table = Job.__table__.to_metadata(MetaData())
    table.append_column(Column('priority_rank', Integer, default=1))
    return table


def migrate(engine, revision):
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with engine.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, revision)


def verify_legacy_cutover(engine, *, status='succeeded', cost_state='reported'):
    from app.models import Asset, Attempt, Job, Ledger, User
    migrate(engine, 'local_overlay_0007')
    stamp = datetime(2026, 1, 1)
    metadata = MetaData()
    metadata.reflect(engine)
    with engine.begin() as connection:
        for owner in ('generator', 'recipient'):
            connection.execute(User.__table__.insert().values(id=owner, subject=owner, name=owner))
            for kind in ('original', 'classic'):
                asset_id = owner + '-' + kind
                connection.execute(Asset.__table__.insert().values(id=asset_id, owner_id=owner,
                    sha256='a' * 64, storage_key='old/' + asset_id, mime='image/png', width=1,
                    height=1, byte_size=10, kind=kind))
        connection.execute(text("UPDATE assets SET storage_backend='r2'"))
        connection.execute(legacy_jobs().insert().values(id='paid-job', owner_id='generator',
            input_asset_id='generator-original', output_asset_id='generator-classic', source_sha256='a' * 64,
            mode='classic', target_language='en', status=status, phase='completed',
            idempotency_key='paid-request', operation='translation', request_hash='b' * 64,
            cache_key='c' * 64, config={}, quota_pages=7, quota_kind='classic_daily',
            settlement='settled', completed_at=stamp))
        connection.execute(Attempt.__table__.insert().values(id='paid-attempt', job_id='paid-job',
            provider_id='legacy', lease_expires_at=stamp, call_started_at=stamp,
            completed_at=stamp, cost_state=cost_state))
        connection.execute(text("UPDATE jobs SET attempt_id='paid-attempt'"))
        connection.execute(Ledger.__table__.insert().values(id='paid-ledger', owner_id='generator',
            job_id='paid-job', transaction_key='paid-job:settle', kind='settle', amount=7))
        connection.execute(metadata.tables['translation_results'].insert().values(
            id='paid-job', cache_key='c' * 64, generated_at=stamp))
        connection.execute(metadata.tables['result_accesses'].insert().values(id='old-access', owner_id='recipient',
            result_id='paid-job', input_asset_id='recipient-original', output_asset_id='recipient-classic',
            version=1, created_at=stamp, changed_at=stamp))
        connection.execute(metadata.tables['translation_requests'].insert().values(owner_id='recipient',
            id='old-uuid', request_hash='d' * 64, access_id='old-access', descriptor={}, created_at=stamp))
        connection.execute(metadata.tables['translation_feedback'].insert().values(id='old-feedback', owner_id='recipient',
            access_id='old-access', translation_id='old-uuid', output_asset_id='recipient-classic', issues=['meaning'],
            comment='preserved feedback', status='received', idempotency_key='feedback', request_hash='e' * 64,
            created_at=stamp, updated_at=stamp))
        before = connection.execute(text('SELECT * FROM usage_ledger')).all()
    migrate(engine, 'head')
    with engine.connect() as connection:
        assert connection.execute(text('SELECT * FROM usage_ledger')).all() == before
        assert connection.execute(text('SELECT status,settlement,quota_pages FROM jobs')).one() == (status,'settled',7)
        request = connection.execute(text('SELECT * FROM translation_requests')).mappings().one()
        assert request['id'] == 'old-uuid' and request['job_id'] is None and request['revoked_at']
        assert bool(request['legacy_execution_resolved']) is (status == 'succeeded' and cost_state == 'reported')
        assert 'image' in str(request['descriptor']) and 'access_id' not in request
        assert connection.scalar(text('SELECT job_id FROM translation_feedback')) == 'paid-job'
        assert connection.scalar(text('SELECT comment FROM translation_feedback')) == 'preserved feedback'
        assert connection.scalar(text('SELECT count(*) FROM assets WHERE deleted_at IS NOT NULL')) == 4
        assert not {'file_pages','result_accesses','translation_results'} & set(inspect(connection).get_table_names())
        if engine.dialect.name == 'sqlite':
            assert connection.exec_driver_sql('PRAGMA foreign_key_check').all() == []
    from sqlalchemy import event
    from sqlalchemy.orm import Session
    from app.translation_api import translation_json
    from app.translation_requests import TranslationRequest
    statements = []
    def capture(conn, cursor, statement, *args):
        statements.append(statement.lower())
    event.listen(engine, 'before_cursor_execute', capture)
    try:
        with Session(engine) as db:
            snapshot = translation_json(db, db.get(TranslationRequest, ('recipient', 'old-uuid')))
        assert snapshot['execution_resolved'] is (status == 'succeeded' and cost_state == 'reported')
        assert snapshot['result'] is None and snapshot['error']['code'] == 'TRANSLATION_UNAVAILABLE'
        assert not any('from attempts' in sql or 'from text_calls' in sql or 'from usage_ledger' in sql for sql in statements)
    finally:
        event.remove(engine, 'before_cursor_execute', capture)


def test_legacy_grants_become_tombstones_and_financial_records_survive(isolated_migration_database):
    verify_legacy_cutover(isolated_migration_database)


@pytest.mark.parametrize('values', [{'status': 'failed'}, {'cost_state': 'unknown'}])
def test_shared_tombstone_requires_completed_and_verified_original_result(isolated_migration_database, values):
    verify_legacy_cutover(isolated_migration_database, **values)


@pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1', reason='requires isolated PostgreSQL')
def test_postgres_legacy_cutover_preserves_financial_evidence(pg_scope):
    from app.db import engine
    verify_legacy_cutover(engine())


@pytest.mark.parametrize('status,settlement', [('awaiting_upload','reserved'), ('unknown_released','released')])
def test_unresolved_remote_job_blocks_cutover_before_any_legacy_data_changes(isolated_migration_database, status, settlement):
    from app.models import Job, User
    engine = isolated_migration_database
    migrate(engine, 'local_overlay_0007')
    metadata = MetaData()
    metadata.reflect(engine)
    stamp = datetime(2026, 1, 1)
    with engine.begin() as connection:
        connection.execute(User.__table__.insert().values(id='waiting-user', subject='waiting', name='Waiting'))
        connection.execute(legacy_jobs().insert().values(id='waiting-job', owner_id='waiting-user',
            source_sha256='a'*64, mode='classic', target_language='en', status=status,
            phase='awaiting_upload', idempotency_key='waiting', operation='translation', request_hash='b'*64,
            cache_key='c'*64, config={}, quota_pages=1, quota_kind='classic_daily', settlement=settlement))
        connection.execute(metadata.tables['upload_reservations'].insert().values(id='waiting-upload',
            job_id='waiting-job', owner_id='waiting-user', mode='classic', expected_sha256='a'*64,
            expected_size=10, mime='image/png', storage_backend='r2', status='awaiting_upload',
            created_at=stamp, expires_at=stamp, max_expires_at=stamp))
    with pytest.raises(RuntimeError, match='Drain or reconcile'):
        migrate(engine, 'head')
    with engine.connect() as connection:
        assert connection.scalar(text('SELECT version_num FROM alembic_version')) == 'local_overlay_0007'
        assert connection.scalar(text('SELECT settlement FROM jobs')) == settlement
        assert 'result_accesses' in inspect(connection).get_table_names()
