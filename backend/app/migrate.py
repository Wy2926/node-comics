"""Explicit, one-shot schema upgrade and idempotent environment bootstrap."""
from .db import initialize, session_factory


def migrate():
    initialize()
    from .control_pools import initialize_pools
    from .system_settings import initialize_system_settings
    from .billing_catalog import initialize_catalog
    with session_factory()() as db:
        initialize_pools(db)
        initialize_system_settings(db)
        initialize_catalog(db)
        db.commit()


if __name__ == '__main__':
    migrate()
    print('Database migration and bootstrap complete')
