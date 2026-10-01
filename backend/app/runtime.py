"""Read-only runtime preflight. Schema changes belong to app.migrate, never startup."""
import os
from sqlalchemy import text
from .config import settings
from .db import engine

# Review explicitly when a migration changes. Do not accept unknown newer schemas.
SUPPORTED_SCHEMAS = frozenset({'simple_scheduler_0009', 'website_guests_0010'})


def check_schema(connection):
    versions = set(connection.scalars(text('SELECT version_num FROM alembic_version')))
    if len(versions) != 1 or not versions <= SUPPORTED_SCHEMAS:
        raise RuntimeError('Database schema is incompatible; run the reviewed migration before startup')
    if versions == {'website_guests_0010'} and connection.scalar(text(
            "SELECT 1 FROM users WHERE kind = 'guest' LIMIT 1")):
        raise RuntimeError('Schema bridge cannot run after guest identities have been created')


def check_database():
    from .db import check_payment_environment
    with engine().connect() as connection:
        check_schema(connection)
        check_payment_environment(connection)


def check_storage():
    root = settings().storage_path
    if not all((root / name).is_dir() and os.access(root / name, os.R_OK | os.W_OK | os.X_OK)
               for name in ('inputs', 'results', 'staging')):
        raise RuntimeError('Shared translation storage is not initialized or writable')


def check_redis():
    from .redis_state import command
    if not command('ping'):
        raise RuntimeError('Shared Redis is unavailable')


def check_runtime():
    check_database()
    check_storage()
    check_redis()
