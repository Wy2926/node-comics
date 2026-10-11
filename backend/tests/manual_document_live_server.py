"""Loopback document acceptance with real R2/LLM and isolated paid test accounts.

No service is started on import. Only the API role migrates/seeds the dedicated
local database; maintenance and document-worker use the same private files.
The worker keeps the mandatory Linux parser sandbox and never simulates a GPU.
"""
from argparse import ArgumentParser
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

API_PORT = 4324
DATABASE_NAME = 'nodecomics_document_local'
DATABASE_USER = 'document_local'
PAID_USERS = ('document-local-paid', 'document-local-other')
PAID_PAGES = 2000
RUNTIME_KEYS = frozenset(('DATABASE_URL', 'REDIS_URL', 'DOCUMENT_RUN_ID',
                         'DEV_AUTH_SECRET', 'STORAGE_PATH', 'DOCUMENT_SPOOL_PATH'))
COMPOSE_KEYS = frozenset(('DOCUMENT_LOCAL_DB_PASSWORD',))
R2_KEYS = ('R2_ENDPOINT_URL', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_KEY_PREFIX')


class LocalConfigurationError(RuntimeError):
    """Messages are fixed labels, never private file contents or credentials."""


def read_env(path):
    from dotenv import dotenv_values
    try:
        path = Path(path)
        if not path.is_file() or path.stat().st_size > 1024 * 1024:
            raise ValueError()
        return dotenv_values(path, encoding='utf-8-sig', interpolate=False)
    except (OSError, ValueError, UnicodeError):
        raise LocalConfigurationError('Cannot read the private environment file.') from None


def validate_local_targets(database_url, redis_url):
    """Reject alternate hosts/queries before creating an engine or migrating."""
    from sqlalchemy.engine import make_url
    try:
        database = make_url(database_url)
        redis = urlsplit(redis_url)
        valid_database = (database.drivername == 'postgresql+psycopg'
            and database.host == '127.0.0.1' and database.port == 54329
            and database.database == DATABASE_NAME and database.username == DATABASE_USER
            and bool(database.password) and not database.query and '#' not in database_url)
        valid_redis = (redis.scheme == 'redis' and redis.hostname == '127.0.0.1'
            and redis.port == 6389 and redis.path == '/0' and not redis.query and not redis.fragment)
    except Exception:
        valid_database = valid_redis = False
    if not valid_database or not valid_redis:
        raise LocalConfigurationError('Only the dedicated loopback PostgreSQL:54329 and Redis:6389 databases are allowed.')


def runtime_environment(env_file, runtime_env_file):
    """Build sensitive environment values without changing the process or files."""
    local, r2 = read_env(runtime_env_file), read_env(env_file)
    if set(local) - RUNTIME_KEYS - COMPOSE_KEYS or any(not local.get(key) for key in RUNTIME_KEYS):
        raise LocalConfigurationError('The local runtime file requires the six runtime keys; only the optional Compose password is also allowed.')
    local = {key: local[key] for key in RUNTIME_KEYS}
    validate_local_targets(local['DATABASE_URL'], local['REDIS_URL'])
    try:
        run_id = UUID(local['DOCUMENT_RUN_ID'])
        if run_id.version != 4 or str(run_id) != local['DOCUMENT_RUN_ID']:
            raise ValueError()
        root = Path(runtime_env_file).resolve().parent
        storage, spool = (Path(local[key]).resolve() for key in ('STORAGE_PATH', 'DOCUMENT_SPOOL_PATH'))
        if (not all(Path(local[key]).is_absolute() for key in ('STORAGE_PATH', 'DOCUMENT_SPOOL_PATH'))
                or any(path == root or not path.is_relative_to(root) for path in (storage, spool))
                or storage.is_relative_to(spool) or spool.is_relative_to(storage)):
            raise ValueError()
        if len(local['DEV_AUTH_SECRET']) < 32 or any(not r2.get(key) for key in R2_KEYS):
            raise ValueError()
        prefix = r2['R2_KEY_PREFIX'].strip('/') + '/document-local-' + str(run_id)
        import re
        if len(prefix) > 96 or not re.fullmatch(r'[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*', prefix):
            raise ValueError()
    except (ValueError, OSError):
        raise LocalConfigurationError('Invalid local run UUID, private paths, signing secret or R2 namespace.') from None
    return {
        **local, 'STORAGE_PATH': str(storage), 'DOCUMENT_SPOOL_PATH': str(spool),
        'APP_ENV': 'development', 'DEV_AUTH': 'true', 'DEV_ADMIN_USERNAME': 'document-local-admin',
        'SERVE_STATIC': 'false', 'ADMIN_WEB_PATH': '', 'CLASSIC_ENABLED': 'true',
        'STRIPE_ENABLED': 'false', 'CREEM_ENABLED': 'false', 'STRIPE_ENVIRONMENT': 'test',
        'CREEM_ENVIRONMENT': 'test', 'GUEST_ENABLED': 'false', 'GA4_ENABLED': 'false',
        'FREE_DAILY_PAGES': '0', 'CORS_ORIGINS': 'http://127.0.0.1:5195',
        'REDIS_NAMESPACE': 'document-local-' + run_id.hex,
        'DOCUMENT_ENABLED': 'true', 'DOCUMENT_PARSER_REQUIRE_SANDBOX': 'true',
        'DOCUMENT_WORKER_SLOTS': '1',
        **{'DOCUMENT_' + key: r2[key] for key in R2_KEYS if key != 'R2_KEY_PREFIX'},
        'DOCUMENT_R2_KEY_PREFIX': prefix,
    }


def configure_runtime(env_file, runtime_env_file):
    """Shared API/worker bootstrap; call once, before importing app.main.

    The returned mapping contains secrets. Do not log or serialize it into a
    report. Container launchers must map only the local service/path locations.
    """
    values = runtime_environment(env_file, runtime_env_file)
    from app.config import Settings, settings
    from app.documents.config import DocumentSettings, get_document_settings
    from app.db import engine
    from app import redis_state
    redis_cache = getattr(redis_state.client, 'cache_info', lambda: None)()
    if engine.cache_info().currsize or (redis_cache is not None and redis_cache.currsize):
        raise LocalConfigurationError('Start a fresh process; existing database or Redis clients cannot be reused.')
    Settings.model_config['env_file'] = None
    DocumentSettings.model_config['env_file'] = None
    owned = {key.upper() for key in Settings.model_fields} | {'DOCUMENT_' + key.upper() for key in DocumentSettings.model_fields}
    for key in list(os.environ):
        # libpq's PGHOSTADDR/PGSERVICE could otherwise bypass an explicit URL host.
        if key.upper() in owned or key.upper().startswith('PG'):
            os.environ.pop(key)
    os.environ.update(values)
    settings.cache_clear()
    get_document_settings.cache_clear()
    try:
        settings()
        get_document_settings()
    except Exception:
        raise LocalConfigurationError('The isolated application or R2 configuration is invalid.') from None
    return values


def read_providers(path):
    """Private JSON array of ProviderWrite objects; no network calls or key output."""
    from app.adapters.text import DocumentTextPolicy
    from app.translation_providers import ProviderWrite
    try:
        path = Path(path)
        if not path.is_file() or path.stat().st_size > 1024 * 1024:
            raise ValueError()
        rows = json.loads(path.read_text(encoding='utf-8-sig'))
        if not isinstance(rows, list) or not 1 <= len(rows) <= 100:
            raise ValueError()
        providers = []
        for row in rows:
            config = dict(row['config'])
            config['document'] = DocumentTextPolicy.model_validate(
                {**(config.get('document') or {}), 'enabled': True}).model_dump()
            body = ProviderWrite.model_validate({**row, 'config': config})
            if not body.enabled or body.text_weight <= 0 or body.api_key is None:
                raise ValueError()
            providers.append(body)
        if len({body.name for body in providers}) != len(providers):
            raise ValueError()
        return providers
    except Exception:
        raise LocalConfigurationError('Invalid private ProviderWrite array; include real keys and valid document budgets.') from None


def seed_local_accounts(db, providers, run_id):
    """Real entitlement rows, but no payment. Restart never refills used pages."""
    from sqlalchemy import select
    from app.billing_models import BillingPlan
    from app.entitlement_models import QuotaPeriod
    from app.models import User
    from app.scheduler import lock_scheduler
    from app.translation_models import TranslationProvider
    from app.translation_providers import write_provider
    from test_quota_purchase_admission import seed_purchase

    lock_scheduler(db)
    scopes = [set(body.text_plan_ids) - {'guest', 'free'} for body in providers
              if body.text_plan_ids is not None and 'free' not in body.text_plan_ids]
    common = set.intersection(*scopes) if scopes else {'plus'}
    if not common:
        raise LocalConfigurationError('Local test models must share an eligible paid service plan.')
    service = 'plus' if 'plus' in common else sorted(common)[0]
    marker = 'document-local:' + run_id + ':' + service
    old_markers = list(db.scalars(select(QuotaPeriod.source_key).where(
        QuotaPeriod.source_key.like('document-local:%')).distinct().limit(2)))
    if any(value != marker for value in old_markers):
        raise LocalConfigurationError('This local database belongs to another run or service plan; keep its original runtime file.')
    for plan in set().union(*(set(body.text_plan_ids or []) for body in providers)) - {'guest', 'free'}:
        if not db.get(BillingPlan, plan):
            db.add(BillingPlan(id=plan, name=plan))
    db.flush()
    for body in providers:
        existing = db.scalars(select(TranslationProvider).where(TranslationProvider.name == body.name)).one_or_none()
        write_provider(db, body, existing)
    for name in PAID_USERS:
        user = db.scalar(select(User).where(User.subject == 'dev:' + name))
        if user is None:
            user = User(subject='dev:' + name, name=name, role='user')
            db.add(user)
            db.flush()
        if db.scalar(select(QuotaPeriod.id).where(QuotaPeriod.owner_id == user.id, QuotaPeriod.source_key == marker)) is None:
            period = seed_purchase(db, user.id, pages=PAID_PAGES, service=service)
            period.source_key = marker
            period.note = 'Local paid-order fixture; no real payment.'
    db.flush()


def initialize_local_database(providers, run_id):
    from sqlalchemy import text
    from app.config import settings
    from app.db import engine, session_factory
    from app.migrate import migrate
    validate_local_targets(settings().database_url, settings().redis_url.get_secret_value())
    with engine().connect() as connection:
        if tuple(connection.execute(text('SELECT current_database(), current_user')).one()) != (DATABASE_NAME, DATABASE_USER):
            raise LocalConfigurationError('The database identity did not match the dedicated local test database.')
    migrate()
    with session_factory()() as db:
        seed_local_accounts(db, providers, run_id)
        db.commit()


def run(argv=None):
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, required=True, help='Private root env; only R2_* keys are used.')
    parser.add_argument('--runtime-env-file', type=Path, required=True,
        help='Private six-key local DB/Redis/run-ID/signing-secret/storage/spool env file.')
    parser.add_argument('--providers-file', type=Path, help='Private ProviderWrite JSON array (API role only).')
    parser.add_argument('--role', choices=('api', 'maintenance', 'document-worker'), default='api')
    args = parser.parse_args(argv)
    if args.role == 'api' and args.providers_file is None:
        parser.error('--providers-file is required for the API role')
    try:
        values = configure_runtime(args.env_file, args.runtime_env_file)
        if args.role == 'api':
            providers = read_providers(args.providers_file)
            initialize_local_database(providers, values['DOCUMENT_RUN_ID'])
            from app.main import app
            import uvicorn
            print('Local API: http://127.0.0.1:4324; paid test users: ' + ', '.join(PAID_USERS), flush=True)
            print('Real R2/LLM calls may incur costs. Paid access is a local fixture; GPU results are not mocked.', flush=True)
            uvicorn.run(app, host='127.0.0.1', port=API_PORT, access_log=False, log_level='warning')
        elif args.role == 'maintenance':
            from app.dispatcher import main
            main()
        else:
            from app.documents.worker import main
            main()
    except LocalConfigurationError as error:
        parser.exit(2, str(error) + '\n')
    except Exception as error:
        # SQL/SDK exceptions may include DSNs, signed URLs or keys. Never echo them.
        parser.exit(2, 'Local document startup failed (' + type(error).__name__ + '); check isolated services and private configuration.\n')


if __name__ == '__main__':
    run()
