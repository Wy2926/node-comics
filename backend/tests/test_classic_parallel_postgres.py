"""Opt-in PostgreSQL proof of atomic call metering and lease fencing."""
import os
from uuid import uuid4
import pytest
from sqlalchemy import URL, create_engine, text
from app.config import settings
from app.db import Base, engine, session_factory
from app.queue_models import SchedulerMutex
from test_classic import text_case
from translation_fixtures import configure_text_provider
from test_classic_parallel import (
    test_inflight_llm_does_not_hold_scheduler_or_image_resources,
    test_parallel_groups_meter_every_call_without_cost_cap,
    test_parallel_same_group_cannot_duplicate_calls,
    test_new_node_reuses_paid_translation_after_image_cache_loss,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
                                reason='Requires the dedicated nodecomics_concurrency_test database')


@pytest.fixture
def text_database(tmp_path, monkeypatch):
    # This fixture can run without importing the HTTP app or other test modules.
    from app import plan_models, system_settings, results, billing_models  # noqa: F401
    database = os.environ.get('TEST_PG_DATABASE', 'nodecomics_concurrency_test')
    if database != 'nodecomics_concurrency_test':
        pytest.fail('Refusing to use a product database')
    password = os.environ.get('TEST_PG_PASSWORD') or os.environ.get('POSTGRES_PASSWORD')
    if not password:
        pytest.fail('TEST_PG_PASSWORD is required')
    base = URL.create('postgresql+psycopg', username=os.environ.get('TEST_PG_USER', 'nodecomics'), password=password,
                      host=os.environ.get('TEST_PG_HOST', 'postgres'), port=int(os.environ.get('TEST_PG_PORT', '5432')),
                      database=database)
    administration = create_engine(base, isolation_level='AUTOCOMMIT')
    schema = 'nc_classic_' + uuid4().hex
    with administration.connect() as connection:
        assert connection.scalar(text('SELECT current_database()')) == database
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    try:
        url = base.update_query_dict({'options': f'-csearch_path={schema} -clock_timeout=8000 -cstatement_timeout=15000'})
        monkeypatch.setenv('DATABASE_URL', url.render_as_string(hide_password=False))
        monkeypatch.setenv('DEV_AUTH', 'true')
        monkeypatch.setenv('CLASSIC_ENABLED', 'true')
        monkeypatch.setenv('STORAGE_PATH', str(tmp_path / 'images'))
        settings.cache_clear()
        if engine.cache_info().currsize:
            engine().dispose()
        engine.cache_clear()
        Base.metadata.create_all(engine())
        with session_factory()() as db:
            db.add(SchedulerMutex(id=1, revision=0))
            db.commit()
            configure_text_provider(db)
        yield
    finally:
        if engine.cache_info().currsize:
            engine().dispose()
        engine.cache_clear()
        settings.cache_clear()
        with administration.connect() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        administration.dispose()
