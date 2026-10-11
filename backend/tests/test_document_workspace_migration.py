"""Safe v1/v2 cutover, historical result preservation and deferred text payloads."""
from datetime import timedelta
import os

import pytest
from sqlalchemy import MetaData, inspect, select, text

from app.documents.models import Document, DocumentPage
from app.models import Job, User, now
from app.queue_models import ComputeNode
from test_job_results_migration import migrate
from test_request_limits_migration import isolated_migration_database
from test_postgres_concurrency import pg_scope


def seed(engine, status):
    migrate(engine, 'documents_0017')
    metadata = MetaData()
    metadata.reflect(engine)
    with engine.begin() as connection:
        connection.execute(User.__table__.insert().values(id='workspace-owner', subject='workspace-owner', name='fixture', role='user'))
        connection.execute(Job.__table__.insert().values(id='historical-document', owner_id='workspace-owner',
            workflow_kind='document', mode='classic', target_language='en', operation='document',
            idempotency_key='historical-upload', request_hash='a' * 64, cache_key='b' * 64,
            config={}, quota_pages=1, quota_kind='document_pages', status=status, settlement='settled'))
        connection.execute(ComputeNode.__table__.insert().values(id='control-document', name='fixture',
            resource_id='control-document', capabilities=['doc_prepare', 'doc_text', 'doc_zip'], capacity=3,
            engine_version='control', device='network', desired_config={'execution_slots': 3}))
        connection.execute(metadata.tables['documents'].insert().values(job_id='historical-document',
            filename='legacy.zip', source_type='zip', source_key='documents/input/historical/source.zip',
            source_size=100, source_sha256='c' * 64, page_count=1, expires_at=now() + timedelta(days=2),
            output_ref={'key': 'documents/output/historical/translated.zip', 'sha256': 'd' * 64,
                        'byte_size': 200, 'mime': 'application/zip'}, text_state='received', created_at=now()))
        connection.execute(metadata.tables['document_pages'].insert().values(job_id='historical-document', page_index=1,
            source_name='1.png', input_ref={'key': 'documents/work/historical/1.png'},
            output_ref={'key': 'documents/work/historical/translated.png'}, status='translated', quality_flags=[], billable=True))
    return metadata


@pytest.mark.parametrize('status', ['uploading', 'preflight', 'awaiting_quota', 'queued', 'running', 'outcome_unknown'])
def test_upgrade_refuses_every_nonterminal_old_document_without_mutation(isolated_migration_database, status):
    engine = isolated_migration_database
    seed(engine, status)
    with pytest.raises(RuntimeError, match='all existing document jobs to be terminal'):
        migrate(engine, 'head')
    with engine.connect() as connection:
        assert connection.scalar(text('SELECT version_num FROM alembic_version')) == 'documents_0017'
        assert connection.scalar(text("SELECT status FROM jobs WHERE id='historical-document'")) == status
        assert 'owner_node_id' not in {column['name'] for column in inspect(connection).get_columns('documents')}


def verify_terminal_history(engine):
    metadata = seed(engine, 'succeeded')
    with engine.connect() as connection:
        before = connection.execute(select(metadata.tables['documents'])).one()
        page = connection.execute(select(metadata.tables['document_pages'])).one()
    migrate(engine, 'head')
    migrate(engine, 'head')
    with engine.connect() as connection:
        assert connection.execute(select(metadata.tables['documents'])).one() == before
        assert connection.execute(select(metadata.tables['document_pages'])).one() == page
        row = connection.execute(text('SELECT owner_node_id,workspace_generation,text_input_payload,text_output_payload FROM documents')).one()
        assert tuple(row) == (None, 1, None, None)
        pool = connection.execute(select(ComputeNode.capacity, ComputeNode.capabilities, ComputeNode.desired_config)).one()
        assert tuple(pool) == (3, ['doc_text'], {'execution_slots': 3})


def test_upgrade_preserves_historical_r2_result_and_admin_owned_capacity(isolated_migration_database):
    verify_terminal_history(isolated_migration_database)


@pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1', reason='Dedicated PostgreSQL test database required')
def test_workspace_upgrade_on_postgresql(pg_scope):
    from app.db import engine
    verify_terminal_history(engine())


def test_large_text_payloads_are_deferred_from_normal_document_selects():
    mapper = inspect(Document)
    assert mapper.attrs.text_input_payload.deferred and mapper.attrs.text_output_payload.deferred
    query = str(select(Document))
    assert 'text_input_payload' not in query and 'text_output_payload' not in query
    pages = str(select(DocumentPage))
    assert 'text_ref' not in pages and 'translations_ref' not in pages
