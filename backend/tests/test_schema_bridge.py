"""Only the reviewed schema/settings extension is accepted; no guest service."""
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, event, text

from app.config import Settings
from app.runtime import check_schema
from app.system_settings import SystemSettings, get_request_limits, stored_limits
from conftest import login
from test_system_settings import DEFAULTS, PATH


@pytest.mark.parametrize('schema', ['simple_scheduler_0009', 'website_guests_0010'])
def test_bridge_schema_check_is_read_only_and_preserves_registered_identity(schema):
    engine = create_engine('sqlite://')
    with engine.begin() as connection:
        connection.execute(text('CREATE TABLE alembic_version (version_num TEXT PRIMARY KEY)'))
        connection.execute(text('INSERT INTO alembic_version VALUES (:schema)'), {'schema': schema})
        # 0009 has no kind column; its check must not reference that extension.
        connection.execute(text('CREATE TABLE users (id TEXT PRIMARY KEY, subject TEXT NOT NULL' +
                                (", kind TEXT NOT NULL DEFAULT 'registered')" if schema.endswith('0010') else ')')))
        connection.execute(text("INSERT INTO users (id,subject) VALUES ('registered-id','oidc-subject')"))
    statements = []
    def record(_connection, _cursor, statement, *_args):
        statements.append(statement.strip().split()[0].upper())
    event.listen(engine, 'before_cursor_execute', record)
    try:
        with engine.connect() as connection:
            check_schema(connection)
            assert connection.execute(text('SELECT id,subject FROM users')).one() == ('registered-id','oidc-subject')
        assert set(statements) == {'SELECT'}
        if schema.endswith('0010'):
            with engine.begin() as connection:
                connection.execute(text("UPDATE users SET kind='guest'"))
            with engine.connect() as connection:
                with pytest.raises(RuntimeError, match='guest identities'):
                    check_schema(connection)
    finally:
        engine.dispose()


def test_bridge_guest_switch_fails_closed(monkeypatch):
    monkeypatch.setenv('GUEST_ENABLED', 'true')
    with pytest.raises(ValidationError, match='GUEST_ENABLED=false'):
        Settings(_env_file=None, app_env='test')
    monkeypatch.setenv('GUEST_ENABLED', 'false')
    assert Settings(_env_file=None, app_env='test').guest_enabled is False


def test_bridge_reads_extended_settings_and_preserves_guest_values_on_legacy_put(client):
    from app.db import session_factory
    auth = login(client, 'admin')
    original = client.get(PATH, headers=auth).json()
    values = original['values']
    guest = {'guest_daily_limit': 7, 'guest_network_daily_limit': 120, 'guest_global_daily_limit': 12000}
    with session_factory()() as db:
        row = db.get(SystemSettings, 1)
        row.values = {**row.values, **guest}
        db.commit()
        assert get_request_limits(db).model_dump() == values
        assert row.version == original['version']
    assert client.get(PATH, headers=auth).json() == original
    changed = {**values, 'free_images_per_minute': 11}
    body = {'expected_version': original['version'], 'values': changed}
    response = client.put(PATH, headers=auth, json=body)
    assert response.status_code == 200
    assert response.json()['values'] == changed
    with session_factory()() as db:
        row = db.get(SystemSettings, 1)
        assert row.values == {**changed, **guest}
        assert get_request_limits(db).free_images_per_minute == 11
    assert client.put(PATH, headers=auth, json=body).status_code == 409


def test_bridge_does_not_accept_unknown_persisted_setting_fields():
    with pytest.raises(ValidationError) as failure:
        stored_limits({**DEFAULTS, 'future_unknown_budget': 1})
    assert failure.value.errors()[0]['type'] == 'extra_forbidden'
