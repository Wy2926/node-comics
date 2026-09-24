"""Build the current schema in an isolated database and verify repeatable startup."""
from types import SimpleNamespace

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
import pytest
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, create_engine, event, inspect, text

HEAD = "translations_0001"
NEW_TABLES = {"translation_results", "result_accesses", "upload_ingress_mutex", "upload_ingress_leases", "feedback_admissions", "system_settings",
              "translation_providers", "translation_provider_revisions", "billing_accounts",
              "billing_customers", "billing_price_bindings", "billing_orders", "billing_order_transitions", "billing_plans", "billing_plan_revisions", "billing_prices", "billing_terms", "billing_checkouts", "billing_subscriptions", "billing_events", "billing_invoices", "compute_claims", "upload_reservations", "translation_requests", "image_admissions", "control_admissions"}


@pytest.fixture
def isolated_migration_database(tmp_path, monkeypatch):
    """No environment files, configured database, identity or object store is used."""
    from app import db
    private_engine = create_engine(f"sqlite:///{(tmp_path / 'upgrade.db').as_posix()}")
    @event.listens_for(private_engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
    monkeypatch.setattr(db, "engine", lambda: private_engine)
    monkeypatch.setattr(db, "settings", lambda: SimpleNamespace(storage_path=tmp_path / "objects", stripe_enabled=False, creem_enabled=False))
    try:
        yield private_engine
    finally:
        private_engine.dispose()


def assert_current_schema_matches_models(engine):
    from app.db import Base
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == HEAD
        inspector = inspect(connection)
        assert NEW_TABLES <= set(inspector.get_table_names())
        assert not {"translation_operations", "reading_sessions", "translation_policies"} & set(inspector.get_table_names())
        queue_columns = {column['name'] for column in inspector.get_columns('user_mode_queues')}
        assert not {'session_id', 'session_epoch', 'session_expires_at'} & queue_columns
        assert connection.scalar(text("SELECT count(*) FROM translation_providers")) == 0
        assert connection.scalar(text("SELECT count(*) FROM translation_provider_revisions")) == 0
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []
        # Alembic's metadata comparison does not detect CHECK constraints. Cover
        # them explicitly, together with the admission ownership/uniqueness keys.
        for name in NEW_TABLES:
            table = Base.metadata.tables[name]
            expected_checks = {(constraint.name, str(constraint.sqltext)) for constraint in table.constraints
                               if isinstance(constraint, CheckConstraint)}
            assert {(constraint["name"], constraint["sqltext"]) for constraint in inspector.get_check_constraints(name)} == expected_checks
            assert inspector.get_pk_constraint(name)["constrained_columns"] == [column.name for column in table.primary_key]
            expected_unique = {tuple(column.name for column in constraint.columns) for constraint in table.constraints
                               if isinstance(constraint, UniqueConstraint)}
            assert {tuple(constraint["column_names"]) for constraint in inspector.get_unique_constraints(name)} == expected_unique
            expected_foreign = {(tuple(column.name for column in constraint.columns),
                                 constraint.elements[0].column.table.name,
                                 tuple(element.column.name for element in constraint.elements))
                                for constraint in table.constraints if isinstance(constraint, ForeignKeyConstraint)}
            actual_foreign = {(tuple(constraint["constrained_columns"]), constraint["referred_table"],
                               tuple(constraint["referred_columns"]))
                              for constraint in inspector.get_foreign_keys(name)}
            assert actual_foreign == expected_foreign


def test_fresh_startup_creates_current_request_limit_schema(isolated_migration_database):
    from app import db
    db.initialize()
    assert_current_schema_matches_models(isolated_migration_database)
    db.initialize()
    assert_current_schema_matches_models(isolated_migration_database)


def test_old_database_is_rejected_without_mutation(isolated_migration_database):
    from app import db
    with isolated_migration_database.begin() as connection:
        connection.execute(text('CREATE TABLE users (id TEXT PRIMARY KEY)'))
        connection.execute(text("INSERT INTO users VALUES ('preserve-existing-data')"))
    with pytest.raises(RuntimeError, match='requires an empty database'):
        db.initialize()
    with isolated_migration_database.connect() as connection:
        assert connection.scalar(text('SELECT id FROM users')) == 'preserve-existing-data'
