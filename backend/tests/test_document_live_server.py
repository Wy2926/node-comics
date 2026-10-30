"""Offline launcher safety; no real DB/Redis, object-store, GPU or LLM calls."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import pytest
from sqlalchemy import func, select

import manual_document_live_server as live


@pytest.fixture
def private_files(tmp_path):
    runtime = {
        'DATABASE_URL': 'postgresql+psycopg://document_local:local-only@127.0.0.1:54329/nodecomics_document_local',
        'REDIS_URL': 'redis://127.0.0.1:6389/0', 'DOCUMENT_RUN_ID': str(uuid4()),
        'DEV_AUTH_SECRET': 'isolated-document-signing-secret-not-live',
        'STORAGE_PATH': str(tmp_path / 'storage'),
    }
    source = {'R2_ENDPOINT_URL': 'https://isolated.r2.cloudflarestorage.com', 'R2_BUCKET': 'offline-fixture',
        'R2_ACCESS_KEY_ID': 'isolated-key-id', 'R2_SECRET_ACCESS_KEY': 'literal-${DO_NOT_EXPAND}',
        'R2_KEY_PREFIX': 'allowed/test-prefix', 'DATABASE_URL': 'postgresql://production.invalid/live',
        'APP_ENV': 'production', 'DEV_AUTH': 'false'}
    root_file, runtime_file = tmp_path / 'source.private.env', tmp_path / 'runtime.env'
    def save():
        for path, values in ((root_file, source), (runtime_file, runtime)):
            path.write_text('\n'.join(f'{key}={value}' for key, value in values.items()), encoding='utf-8')
    save()
    return root_file, runtime_file, runtime, source, save


def test_runtime_uses_only_explicit_isolated_values(private_files, monkeypatch):
    root, runtime_file, runtime, _, _ = private_files
    monkeypatch.setenv('DO_NOT_EXPAND', 'wrong-value')
    monkeypatch.setenv('DATABASE_URL', 'postgresql://ambient-production.invalid/live')
    values = live.runtime_environment(root, runtime_file)
    assert values['DATABASE_URL'] == runtime['DATABASE_URL']
    assert values['DOCUMENT_R2_SECRET_ACCESS_KEY'] == 'literal-${DO_NOT_EXPAND}'
    assert values['DOCUMENT_R2_KEY_PREFIX'] == 'allowed/test-prefix/document-local-' + runtime['DOCUMENT_RUN_ID']
    assert values['REDIS_NAMESPACE'] == 'document-local-' + runtime['DOCUMENT_RUN_ID'].replace('-', '')
    assert values['APP_ENV'] == 'development' and values['DEV_AUTH'] == 'true'
    assert values['STRIPE_ENABLED'] == values['CREEM_ENABLED'] == 'false'
    assert values['CORS_ORIGINS'] == 'http://127.0.0.1:5195'
    assert 'R2_SECRET_ACCESS_KEY' not in values
    assert os.environ['DATABASE_URL'] == 'postgresql://ambient-production.invalid/live'


def test_optional_compose_password_is_not_exported_to_application(private_files):
    root, runtime_file, runtime, _, save = private_files
    runtime['DOCUMENT_LOCAL_DB_PASSWORD'] = 'compose-local-only'
    save()
    values = live.runtime_environment(root, runtime_file)
    assert 'DOCUMENT_LOCAL_DB_PASSWORD' not in values


@pytest.mark.parametrize('field,value', [
    ('DATABASE_URL', 'sqlite:///local.db'),
    ('DATABASE_URL', 'postgresql+psycopg://document_local:secret@production.invalid:54329/nodecomics_document_local'),
    ('DATABASE_URL', 'postgresql+psycopg://document_local:secret@127.0.0.1:5432/nodecomics_document_local'),
    ('DATABASE_URL', 'postgresql+psycopg://document_local:secret@localhost:54329/nodecomics_document_local'),
    ('DATABASE_URL', 'postgresql+psycopg://postgres:secret@127.0.0.1:54329/nodecomics_document_local'),
    ('DATABASE_URL', 'postgresql+psycopg://document_local:secret@127.0.0.1:54329/production'),
    ('DATABASE_URL', 'postgresql+psycopg://document_local:secret@127.0.0.1:54329/nodecomics_document_local?host=production.invalid'),
    ('DATABASE_URL', 'postgresql+psycopg://document_local:secret@127.0.0.1:54329/nodecomics_document_local?hostaddr=203.0.113.1'),
    ('REDIS_URL', 'redis://127.0.0.1:6379/0'),
    ('REDIS_URL', 'redis://production.invalid:6389/0'),
    ('REDIS_URL', 'redis://127.0.0.1:6389/1'),
    ('REDIS_URL', 'redis://127.0.0.1:6389/0?host=production.invalid'),
    ('REDIS_URL', 'redis://127.0.0.1:6389/0#private'),
])
def test_rejects_non_dedicated_targets_before_migration(private_files, monkeypatch, field, value):
    root, runtime_file, runtime, _, save = private_files
    runtime[field] = value
    save()
    monkeypatch.setattr(live, 'initialize_local_database', lambda *_: pytest.fail('unsafe migration'))
    with pytest.raises(live.LocalConfigurationError, match='dedicated loopback') as error:
        live.runtime_environment(root, runtime_file)
    assert 'secret' not in str(error.value) and 'production.invalid' not in str(error.value)


@pytest.mark.parametrize('change', ['uuid', 'paths', 'secret', 'prefix', 'prefix_length', 'extra'])
def test_rejects_unsafe_local_namespace_and_paths(private_files, change):
    root, runtime_file, runtime, source, save = private_files
    if change == 'uuid': runtime['DOCUMENT_RUN_ID'] = 'not-a-uuid'
    elif change == 'paths': runtime['STORAGE_PATH'] = str(runtime_file.parent.parent)
    elif change == 'secret': runtime['DEV_AUTH_SECRET'] = 'short'
    elif change == 'prefix': source['R2_KEY_PREFIX'] = '/'
    elif change == 'prefix_length': source['R2_KEY_PREFIX'] = 'x' * 97
    elif change == 'extra': runtime['DOCUMENT_UNKNOWN_SETTING'] = 'false'
    save()
    with pytest.raises(live.LocalConfigurationError):
        live.runtime_environment(root, runtime_file)


def test_configure_disables_dotenv_and_clears_ambient_clients_in_fresh_process(private_files):
    root, runtime_file, _, _, _ = private_files
    code = '''import os, sys
from manual_document_live_server import configure_runtime
configure_runtime(sys.argv[1], sys.argv[2])
from app.config import Settings, settings
from app.documents.config import DocumentSettings, get_document_settings
assert Settings.model_config['env_file'] is None
assert DocumentSettings.model_config['env_file'] is None
assert settings().app_env == 'development' and settings().dev_auth
assert settings().oidc_issuer == '' and not settings().stripe_enabled
assert get_document_settings().enabled
assert 'PGHOSTADDR' not in os.environ and 'PGSERVICE' not in os.environ
print('isolated-configuration-ok')
'''
    env = {**os.environ, 'PYTHONPATH': str(Path(live.__file__).parent),
        'APP_ENV': 'production', 'PGHOSTADDR': '203.0.113.1', 'PGSERVICE': 'production',
        'OIDC_ISSUER': 'https://production.invalid', 'STRIPE_ENABLED': 'true'}
    result = subprocess.run([sys.executable, '-c', code, str(root), str(runtime_file)],
        env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'isolated-configuration-ok'


@pytest.fixture
def providers_file(tmp_path):
    rows = [{'name': 'Local real-route profile', 'channel': 'openai', 'enabled': True, 'text_weight': 1,
        'text_plan_ids': ['plus', 'pro'], 'title_weight': 0, 'requests_per_minute': 60,
        'api_key': 'offline-fixture-key-not-real', 'config': {
            'model': 'operator-selected-model', 'base_url': 'https://openrouter.ai/api/v1',
            'protocol': 'chat_completions', 'reasoning_effort': 'minimal',
            'user_agent': 'LocalDocument/1', 'openrouter_providers': ['operator/upstream'],
            'max_output_tokens': 32768, 'timeout_seconds': 60}}]
    path = tmp_path / 'providers.private.json'
    def save(): path.write_text(json.dumps(rows), encoding='utf-8')
    save()
    return path, rows, save


def test_preserves_provider_route_and_independent_document_budget(providers_file):
    path, rows, save = providers_file
    rows[0]['config']['document'] = {'enabled': False, 'context_tokens': 1048576,
        'max_input_tokens': 96000, 'max_output_tokens': 65536, 'timeout_seconds': 600}
    save()
    body, = live.read_providers(path)
    for key, value in rows[0]['config'].items():
        if key != 'document': assert body.config[key] == value
    assert body.text_plan_ids == ['plus', 'pro']
    assert body.config['document']['enabled'] is True
    assert body.config['document']['max_output_tokens'] == 65536
    assert body.config['document']['max_response_bytes'] == 8 * 1024 * 1024
    assert body.api_key.get_secret_value() == rows[0]['api_key']
    assert rows[0]['api_key'] not in repr(body)


@pytest.mark.parametrize('change', ['bad_key', 'missing_key', 'bad_protocol', 'disabled', 'duplicate', 'budget'])
def test_provider_errors_do_not_leak_private_values(providers_file, change):
    path, rows, save = providers_file
    if change == 'bad_key': rows[0]['api_key'] = 'secret invalid key'
    elif change == 'missing_key': rows[0].pop('api_key')
    elif change == 'bad_protocol': rows[0]['config']['protocol'] = 'secret-protocol'
    elif change == 'disabled': rows[0]['enabled'] = False
    elif change == 'duplicate': rows.append(copy.deepcopy(rows[0]))
    elif change == 'budget': rows[0]['config']['document'] = {'context_tokens': 1024}
    save()
    with pytest.raises(live.LocalConfigurationError) as error:
        live.read_providers(path)
    assert 'secret' not in str(error.value) and 'offline-fixture-key' not in str(error.value)


def test_paid_seed_is_idempotent_and_uses_real_entitlement_rules(client, providers_file, monkeypatch):
    from types import SimpleNamespace
    from app.billing_models import BillingOrder, BillingPlanRevision
    from app.db import session_factory
    from app.documents import api
    from app.entitlement_models import QuotaPeriod
    from app.models import User
    from app.translation_models import TranslationProvider
    providers, run_id = live.read_providers(providers_file[0]), str(uuid4())
    with session_factory()() as db:
        live.seed_local_accounts(db, providers, run_id)
        db.commit()
        users = list(db.scalars(select(User).where(User.name.in_(live.PAID_USERS))))
        assert len(users) == 2 and all(user.role == 'user' for user in users)
        periods = list(db.scalars(select(QuotaPeriod).where(QuotaPeriod.source_key.like('document-local:%'))))
        assert len(periods) == 2 and all(row.granted == 2000 for row in periods)
        assert {row.owner_id for row in periods} == {user.id for user in users}
        periods[0].used = 7
        db.commit()
        live.seed_local_accounts(db, providers, run_id)
        db.commit()
        assert db.scalar(select(func.count()).select_from(BillingOrder)) == 2
        assert db.get(QuotaPeriod, periods[0].id).used == 7
        assert db.scalar(select(func.count()).select_from(TranslationProvider).where(
            TranslationProvider.name == providers[0].name)) == 1
        assert db.scalar(select(BillingPlanRevision.service_plan_id).where(
            BillingPlanRevision.quota_pages == 2000).limit(1)) == 'plus'
        with pytest.raises(live.LocalConfigurationError, match='another run'):
            live.seed_local_accounts(db, providers, str(uuid4()))
    response = client.post('/v1/auth/dev', json={'username': live.PAID_USERS[0]})
    assert response.status_code == 200 and response.json()['access_token']
    monkeypatch.setattr(api, 'get_document_settings', lambda: SimpleNamespace(enabled=True,
        upload_part_bytes=16 * 1024 * 1024, waiting_retention_hours=24))
    capability = client.get('/v1/documents/capabilities', headers={
        'Authorization': 'Bearer ' + response.json()['access_token']}).json()
    assert capability['enabled'] and capability['models'][0]['name'] == providers[0].name
    unpaid = client.post('/v1/auth/dev', json={'username': 'document-local-unpaid'}).json()
    assert client.get('/v1/documents/capabilities', headers={
        'Authorization': 'Bearer ' + unpaid['access_token']}).json()['models'] == []


def test_disjoint_model_scopes_do_not_get_privilege_widening(client, providers_file):
    from app.db import session_factory
    path, rows, save = providers_file
    rows[0]['text_plan_ids'] = ['plus']
    rows.append({**copy.deepcopy(rows[0]), 'name': 'Other scoped provider', 'text_plan_ids': ['pro']})
    save()
    with session_factory()() as db, pytest.raises(live.LocalConfigurationError, match='share an eligible'):
        live.seed_local_accounts(db, live.read_providers(path), str(uuid4()))


@pytest.mark.parametrize('role,module', [('maintenance', 'app.dispatcher'), ('document-worker', 'app.documents.worker')])
def test_non_api_roles_never_migrate_or_seed(monkeypatch, role, module):
    import importlib
    called = []
    monkeypatch.setattr(live, 'configure_runtime', lambda *_: {})
    monkeypatch.setattr(live, 'initialize_local_database', lambda *_: pytest.fail('non-API migration'))
    monkeypatch.setattr(live, 'read_providers', lambda *_: pytest.fail('non-API provider seeding'))
    monkeypatch.setattr(importlib.import_module(module), 'main', lambda: called.append(role))
    live.run(['--env-file', 'unused.private.env', '--runtime-env-file', 'unused.runtime.env', '--role', role])
    assert called == [role]


def test_existing_database_client_cannot_be_reconfigured(client, private_files):
    with pytest.raises(live.LocalConfigurationError, match='fresh process'):
        live.configure_runtime(private_files[0], private_files[1])


@pytest.mark.parametrize('identity', [('production', live.DATABASE_USER), (live.DATABASE_NAME, 'postgres')])
def test_migration_checks_actual_database_identity_first(private_files, monkeypatch, identity):
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from app import config, db, migrate
    values = live.runtime_environment(private_files[0], private_files[1])
    monkeypatch.setattr(config, 'settings', lambda: SimpleNamespace(database_url=values['DATABASE_URL'],
        redis_url=SimpleNamespace(get_secret_value=lambda: values['REDIS_URL'])))
    connection = MagicMock()
    connection.execute.return_value.one.return_value = identity
    database = MagicMock()
    database.connect.return_value.__enter__.return_value = connection
    monkeypatch.setattr(db, 'engine', lambda: database)
    monkeypatch.setattr(migrate, 'migrate', lambda: pytest.fail('wrong database must not migrate'))
    with pytest.raises(live.LocalConfigurationError, match='database identity'):
        live.initialize_local_database([], values['DOCUMENT_RUN_ID'])


def test_api_role_binds_only_dedicated_loopback_and_does_not_log_keys(client, providers_file, monkeypatch, capsys):
    import uvicorn
    events = []
    run_id = str(uuid4())
    monkeypatch.setattr(live, 'configure_runtime', lambda *_: {'DOCUMENT_RUN_ID': run_id})
    monkeypatch.setattr(live, 'initialize_local_database', lambda providers, key: events.append(('seed', key)))
    monkeypatch.setattr(uvicorn, 'run', lambda app, **options: events.append(('serve', options)))
    live.run(['--env-file', 'unused.private.env', '--runtime-env-file', 'unused.runtime.env',
        '--providers-file', str(providers_file[0])])
    assert events == [('seed', run_id), ('serve', {
        'host': '127.0.0.1', 'port': 4324, 'access_log': False, 'log_level': 'warning'})]
    output = capsys.readouterr().out
    assert 'offline-fixture-key' not in output and 'Real R2/LLM' in output
