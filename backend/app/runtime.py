"""Read-only runtime preflight. Schema changes belong to app.migrate, never startup."""
import os
from sqlalchemy import inspect, text
from .config import settings
from .db import Base, engine, load_models


def check_schema(connection):
    """Require used tables/columns, not an exact Alembic head. Additions are compatible."""
    load_models()
    columns = inspect(connection).get_multi_columns(filter_names=list(Base.metadata.tables))
    for table in Base.metadata.tables.values():
        present = {column['name'] for column in columns.get((table.schema, table.name), ())}
        if not set(table.columns.keys()) <= present:
            raise RuntimeError(f'Database structure is incomplete for {table.name}; run the required migration')


def check_database(*, startup=False):
    from .db import check_payment_environment
    with engine().connect() as connection:
        connection.execute(text('SELECT 1'))
        if startup:
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
    check_database(startup=True)
    check_storage()
    check_redis()
