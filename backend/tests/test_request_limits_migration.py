"""Build the current schema in an isolated database and verify repeatable startup."""
from types import SimpleNamespace

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
import pytest
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, create_engine, event, inspect, text

HEAD = "quota_campaigns_0006"
NEW_TABLES = {"quota_campaigns", "quota_campaign_awards", "quota_periods", "comic_title_cache", "translation_results", "result_accesses", "system_settings",
              "translation_providers", "translation_provider_revisions", "billing_accounts",
              "billing_customers", "billing_price_bindings", "billing_orders", "billing_order_transitions", "billing_plans", "billing_plan_revisions", "billing_prices", "billing_terms", "billing_checkouts", "billing_subscriptions", "billing_events", "billing_invoices", "compute_claims", "upload_reservations", "translation_requests"}


@pytest.fixture
def isolated_migration_database(tmp_path, monkeypatch):
    """No environment files, configured database, identity or object store is used."""
    from app import billing_providers, db
    private_engine = create_engine(f"sqlite:///{(tmp_path / 'upgrade.db').as_posix()}")
    @event.listens_for(private_engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
    monkeypatch.setattr(db, "engine", lambda: private_engine)
    isolated_settings = lambda: SimpleNamespace(storage_path=tmp_path / "objects", stripe_enabled=False, creem_enabled=False)
    monkeypatch.setattr(db, "settings", isolated_settings)
    monkeypatch.setattr(billing_providers, "settings", isolated_settings)
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


def test_title_cache_upgrade_preserves_existing_baseline_data(isolated_migration_database):
    from datetime import datetime
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from app import db
    at = datetime(2026, 1, 1)
    leases = [{'id': 'preserve-control-token', 'until': '2026-01-01T00:00:30'}]
    db.initialize()
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.downgrade(config, 'translations_0001')
        connection.execute(text("INSERT INTO users (id, subject, name, role, created_at) VALUES ('preserved-user', 'existing-user', 'Existing', 'user', :at)"), {'at': at})
        connection.execute(text("INSERT INTO control_admissions VALUES ('preserved-user', 'translation', 2.5, :at, :leases)"),
            {'at': at, 'leases': __import__('json').dumps(leases)})
    db.initialize()
    with isolated_migration_database.connect() as connection:
        assert connection.scalar(text('SELECT name FROM users WHERE id = :id'), {'id': 'preserved-user'}) == 'Existing'
        assert connection.scalar(text('SELECT plus_pending FROM users WHERE id = :id'), {'id': 'preserved-user'}) == 0
        assert not {'control_admissions', 'comic_title_admissions', 'image_admissions', 'feedback_admissions',
            'support_request_admissions', 'upload_ingress_leases', 'upload_ingress_mutex',
            'translation_provider_requests'} & set(inspect(connection).get_table_names())
    assert_current_schema_matches_models(isolated_migration_database)


def test_gift_upgrade_preserves_calendar_segment_and_used_reserved_bucket(isolated_migration_database):
    from datetime import datetime
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from sqlalchemy.orm import Session
    from app import db
    from app.entitlement_models import QuotaPeriod
    from app.entitlements import MONTHLY, allowance_json, iso
    from app.models import User
    from app.providers import digest
    db.initialize()
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    start, end = datetime(2026, 1, 31, 18), datetime(2026, 2, 28, 18)
    period_id = digest(['calendar-user', MONTHLY, iso(start)])
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.downgrade(config, 'redis_admission_0004')
        connection.execute(text("INSERT INTO users (id, subject, name, role, created_at, membership_id, plus_started_at, plus_expires_at, plus_timezone, plus_monthly_pages) VALUES ('calendar-user', 'calendar-user', 'Existing', 'user', :start, 'calendar-segment', :start, :end, 'America/New_York', 300)"), {'start': start, 'end': end})
        connection.execute(QuotaPeriod.__table__.insert().values(id=period_id, owner_id='calendar-user',
            kind=MONTHLY, mode='redraw', source='membership', source_key=f'{MONTHLY}:{iso(start)}',
            starts_at=start, ends_at=end, granted=300, used=125, reserved=3))
    db.initialize()
    with Session(isolated_migration_database) as session:
        user = session.get(User, 'calendar-user')
        assert user.plus_timezone == 'America/New_York' and not user.plus_pending
        quota = allowance_json(session, user, MONTHLY, datetime(2026, 2, 1))
        assert quota['id'] == period_id
        assert (quota['used'], quota['reserved'], quota['available']) == (125, 3, 172)
        assert quota['resets_at'] == iso(end)
    assert_current_schema_matches_models(isolated_migration_database)


def test_gift_downgrade_rejects_unfinished_thirty_day_segment(isolated_migration_database):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from app import db
    db.initialize()
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        connection.execute(text("INSERT INTO users (id, subject, name, role, created_at, membership_id, plus_started_at, plus_expires_at, plus_monthly_pages) VALUES ('gift-user', 'gift-user', 'New gift', 'user', CURRENT_TIMESTAMP, 'gift-segment', CURRENT_TIMESTAMP, '2099-01-01', 300)"))
        config.attributes['connection'] = connection
        with pytest.raises(RuntimeError, match='Resolve thirty-day gift periods'):
            command.downgrade(config, 'redis_admission_0004')
    # The empty campaign migration can already have been downgraded on SQLite;
    # the membership guard must preserve its own schema and data.
    db.initialize()
    assert_current_schema_matches_models(isolated_migration_database)


def test_title_supplier_upgrade_preserves_body_default_without_implicit_selection(isolated_migration_database):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from app import db
    db.initialize()
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.downgrade(config, 'translations_0001')
        connection.execute(text("INSERT INTO translation_providers "
            "(id, name, channel, enabled, is_default, revision_id, requests_per_minute, created_at, updated_at) "
            "VALUES ('existing', 'Existing body supplier', 'openai', true, true, 'existing-revision', 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"))
    db.initialize()
    with isolated_migration_database.connect() as connection:
        row = connection.execute(text('SELECT * FROM translation_providers')).mappings().one()
        assert row['text_weight'] == 1 and row['title_weight'] == 0
        assert 'is_default' not in row and 'is_title_default' not in row
        assert row['revision_id'] == 'existing-revision' and row['requests_per_minute'] == 30


def test_weighted_upgrade_preserves_independent_choices_and_immutable_revisions(isolated_migration_database):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from app import db
    from app.translation_models import TranslationProviderRevision
    db.initialize()
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.downgrade(config, 'comic_titles_0002')
        for provider_id in ['body', 'title', 'unused']:
            connection.execute(text('INSERT INTO translation_providers '
                '(id, name, channel, enabled, is_default, is_title_default, revision_id, requests_per_minute, created_at, updated_at) '
                'VALUES (:id, :id, \'openai\', :enabled, :body, :title, :revision, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'),
                {'id': provider_id, 'enabled': provider_id != 'title', 'body': provider_id == 'body',
                 'title': provider_id == 'title', 'revision': provider_id + '-revision'})
            connection.execute(TranslationProviderRevision.__table__.insert().values(
                id=provider_id + '-revision', provider_id=provider_id, channel='openai',
                config={'model': 'legacy-model'}, api_key='isolated-preserved-key'))
        revisions = connection.execute(text('SELECT * FROM translation_provider_revisions ORDER BY id')).all()
    db.initialize()
    with isolated_migration_database.connect() as connection:
        rows = connection.execute(text('SELECT id, text_weight, title_weight, enabled FROM translation_providers ORDER BY id')).all()
        assert rows == [('body', 1, 0, True), ('title', 0, 1, False), ('unused', 0, 0, True)]
        assert revisions == connection.execute(text('SELECT * FROM translation_provider_revisions ORDER BY id')).all()
    # Startup is repeatable and does not normalize or rewrite existing revisions.
    db.initialize()
    with isolated_migration_database.connect() as connection:
        assert revisions == connection.execute(text('SELECT * FROM translation_provider_revisions ORDER BY id')).all()
