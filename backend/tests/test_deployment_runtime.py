"""Additive schemas can roll forward; startup never creates missing structures."""
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
        assert set(statements) <= {'SELECT', 'PRAGMA'}  # SQLite catalog inspection is read-only.
        assert client.get('/health/cluster').status_code == 503
    finally:
        event.remove(engine(), 'before_cursor_execute', record)


@pytest.mark.parametrize('revision', ['future_additive', 'older_stamp'])
def test_schema_stamp_does_not_gate_compatible_structures(client, revision):
    from app.db import engine
    from app.runtime import check_runtime
    with engine().begin() as connection:
        connection.execute(text('UPDATE alembic_version SET version_num=:revision'), {'revision': revision})
        connection.execute(text('ALTER TABLE users ADD COLUMN additive_note TEXT'))
    check_runtime()
    assert client.get('/health/ready').status_code == 200
    with engine().connect() as connection:
        assert connection.scalar(text('SELECT version_num FROM alembic_version')) == revision


@pytest.mark.parametrize('ddl', ['DROP TABLE billing_checkout_aliases',
    'ALTER TABLE users RENAME COLUMN name TO retired_name'])
def test_startup_rejects_missing_used_tables_or_columns(client, ddl):
    from app.db import engine
    from app.runtime import check_runtime
    with engine().begin() as connection:
        connection.execute(text(ddl))
    with pytest.raises(RuntimeError, match='structure is incomplete'):
        check_runtime()


def test_readiness_does_not_rescan_schema_or_payment_rows(client, monkeypatch):
    from app import runtime, db
    monkeypatch.setattr(runtime, 'check_schema', lambda *_: pytest.fail('schema scanned by health'))
    monkeypatch.setattr(db, 'check_payment_environment', lambda *_: pytest.fail('billing scanned by health'))
    assert client.get('/health/ready').status_code == 200
    monkeypatch.setattr(runtime, 'engine', lambda: (_ for _ in ()).throw(RuntimeError('offline')))
    assert client.get('/health/ready').status_code == 503


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
