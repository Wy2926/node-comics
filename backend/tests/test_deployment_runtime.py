"""Deployment preflight never upgrades an unprepared or unknown database."""
import pytest
from sqlalchemy import event, text


def test_runtime_is_read_only_and_api_ready_without_workers(client):
    from app.db import engine
    from app.runtime import check_runtime
    statements = []

    def record(connection, cursor, statement, parameters, context, many):
        statements.append(statement.strip().split()[0].upper())

    event.listen(engine(), 'before_cursor_execute', record)
    try:
        check_runtime()
        response = client.get('/health/ready')
        assert response.status_code == 200
        assert 'no-store' in response.headers['cache-control']
        assert response.json()['release'] == 'development'
        assert set(statements) <= {'SELECT'}
        assert client.get('/health/cluster').status_code == 503
    finally:
        event.remove(engine(), 'before_cursor_execute', record)


def test_unknown_schema_is_rejected_without_downgrade(client):
    from app.db import engine
    from app.runtime import check_runtime
    with engine().begin() as connection:
        connection.execute(text("UPDATE alembic_version SET version_num='future_incompatible'"))
    with pytest.raises(RuntimeError, match='incompatible'):
        check_runtime()
    assert client.get('/health/ready').status_code == 503
    with engine().connect() as connection:
        assert connection.scalar(text('SELECT version_num FROM alembic_version')) == 'future_incompatible'


def test_empty_database_is_not_initialized(tmp_path, monkeypatch):
    from sqlalchemy import create_engine, inspect
    from app import runtime
    empty = create_engine('sqlite:///' + str(tmp_path / 'empty.db'))
    monkeypatch.setattr(runtime, 'engine', lambda: empty)
    try:
        with pytest.raises(Exception):
            runtime.check_runtime()
        assert inspect(empty).get_table_names() == []
    finally:
        empty.dispose()
