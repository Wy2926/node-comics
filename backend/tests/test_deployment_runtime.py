"""Runtime checks availability; explicit migration owns structure validation."""
import pytest
from sqlalchemy import event, text


def test_startup_and_readiness_only_probe_dependencies(client):
    from app.db import engine
    from app.runtime import check_runtime
    with engine().begin() as connection:
        connection.execute(text("UPDATE alembic_version SET version_num='future_additive'"))
    statements = []

    def record(connection, cursor, statement, parameters, context, many):
        statements.append(statement.strip().upper())

    event.listen(engine(), 'before_cursor_execute', record)
    try:
        check_runtime()
        response = client.get('/health/ready')
        assert response.status_code == 200
        assert 'no-store' in response.headers['cache-control']
        assert response.json()['release'] == 'development'
        assert statements and set(statements) == {'SELECT 1'}
    finally:
        event.remove(engine(), 'before_cursor_execute', record)
    assert client.get('/health/cluster').status_code == 503


def test_migration_rejects_missing_structure(client):
    from app.db import engine
    from app.migrate import migrate
    with engine().begin() as connection:
        connection.execute(text('DROP TABLE billing_checkout_aliases'))
    with pytest.raises(RuntimeError, match='structure is incomplete'):
        migrate()


def test_database_outage_is_not_reported_ready(client, monkeypatch):
    from app import runtime
    monkeypatch.setattr(runtime, 'engine', lambda: (_ for _ in ()).throw(RuntimeError('offline')))
    assert client.get('/health/ready').status_code == 503


def test_database_probe_does_not_initialize_empty_database(tmp_path, monkeypatch):
    from sqlalchemy import create_engine, inspect
    from app import runtime
    empty = create_engine('sqlite:///' + str(tmp_path / 'empty.db'))
    monkeypatch.setattr(runtime, 'engine', lambda: empty)
    try:
        runtime.check_database()
        assert inspect(empty).get_table_names() == []
    finally:
        empty.dispose()
