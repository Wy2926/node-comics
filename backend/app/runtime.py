"""Dependency availability only; schema and payment-data checks belong to migration."""
import os
from sqlalchemy import text
from .config import settings
from .db import engine


def check_database():
    with engine().connect() as connection:
        connection.execute(text('SELECT 1'))


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
