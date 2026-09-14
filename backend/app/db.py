from functools import lru_cache
from sqlalchemy import create_engine, event, text
from threading import Lock
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from .config import settings


class Base(DeclarativeBase):
    pass


_migration_lock = Lock()


@lru_cache
def engine():
    url = settings().database_url
    kwargs = {"connect_args": {"check_same_thread": False, "timeout": 30}} if url.startswith("sqlite") else {}
    db = create_engine(url, pool_pre_ping=True, **kwargs)
    if url.startswith("sqlite"):
        @event.listens_for(db, "connect")
        def sqlite_pragmas(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=WAL")
    return db


def session_factory():
    return sessionmaker(bind=engine(), expire_on_commit=False)


def get_db():
    with session_factory()() as session:
        yield session


def initialize():
    from . import models  # noqa: F401
    from . import queue_models  # noqa: F401
    from . import batch_items  # noqa: F401
    from alembic import command
    from alembic.config import Config
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    with _migration_lock, engine().begin() as connection:
        if connection.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(761349210)"))
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
    settings().storage_path.mkdir(parents=True, exist_ok=True)
