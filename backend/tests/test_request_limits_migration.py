"""Build the current schema in an isolated database and verify repeatable startup."""
from types import SimpleNamespace

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
import pytest
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, create_engine, event, inspect, text

HEAD = "text_plan_routing_0013"
NEW_TABLES = {"guest_sessions", "guest_daily_usage", "guest_daily_budgets", "quota_campaigns", "quota_campaign_awards", "quota_periods", "comic_title_cache", "system_settings",
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
        assert not {'user_mode_queues', 'fairness_states'} & set(inspector.get_table_names())
        assert connection.scalar(text("SELECT count(*) FROM translation_providers")) == 0
        assert connection.scalar(text("SELECT count(*) FROM translation_provider_revisions")) == 0
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []
        # Alembic's metadata comparison does not detect CHECK constraints. Cover
        # them explicitly, together with the admission ownership/uniqueness keys.
        for name in NEW_TABLES:
            table = Base.metadata.tables[name]
            expected_checks = {(constraint.name, str(constraint.sqltext)) for constraint in table.constraints
                               if isinstance(constraint, CheckConstraint)}
            # PostgreSQL rewrites IN checks to typed ANY arrays and gives
            # unnamed constraints generated names; literal SQL equality is
            # meaningful only for the SQLite migration fixture.
            if connection.dialect.name == 'sqlite':
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


def test_fifo_upgrade_preserves_checkpoint_and_active_lease(isolated_migration_database):
    from pathlib import Path
    from datetime import timedelta
    from alembic import command
    from alembic.config import Config
    import sqlalchemy as sa
    from app import db
    from app.models import ClassicState, Job, User, now
    from app.queue_models import ComputeNode, ExecutionLease, JobStage
    from app.providers import digest
    from app.jobs import content_key

    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    old_config = {'mode': 'classic', 'engine': {'version': 'old-platform-build', 'protocol_version': 3}}
    old_config['version'] = digest(old_config)
    checkpoint = {'version': 'old-platform-build', 'segments': [{'id': '0', 'source': 'hello'}]}

    def values(model, **specified):
        defaults = {c.name: c.default.arg(None) if c.default.is_callable else c.default.arg
                    for c in model.__table__.columns if c.default is not None}
        return defaults | specified

    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, 'job_results_0008')
        tables = sa.MetaData()
        tables.reflect(connection)
        connection.execute(tables.tables['users'].insert(), values(User, id='fifo-owner', subject='fifo-owner', name='test'))
        connection.execute(tables.tables['jobs'].insert(), values(Job, id='fifo-job', owner_id='fifo-owner',
            mode='classic', target_language='en', status='running', source_sha256='a' * 64,
            config=old_config, cache_key='old-key', operation='translation', idempotency_key='keep-uuid',
            request_hash='b' * 64, quota_pages=1, quota_kind='classic_daily', settlement='reserved',
            priority_rank=0, realtime_until=now() + timedelta(minutes=1)))
        connection.execute(tables.tables['classic_states'].insert(), values(ClassicState, job_id='fifo-job',
            analysis=checkpoint, translations={'0': 'paid translation'}))
        connection.execute(tables.tables['compute_nodes'].insert(), values(ComputeNode, id='fifo-node',
            name='test', resource_id='fifo-device', engine_version='old-platform-build', device='fixture',
            capacity=4, capabilities=['page'], supported_languages=['en'],
            desired_config={'execution_slots': 4, 'allowed_languages': ['en']},
            runtime_report={'protocol_version': 3, 'ready': True, 'languages': ['en', 'ko']}))
        connection.execute(tables.tables['job_stages'].insert(), values(JobStage, id='fifo-stage', job_id='fifo-job',
            name='page', status='running', generation=2))
        connection.execute(tables.tables['execution_leases'].insert(), values(ExecutionLease,
            id='fifo-lease', stage_id='fifo-stage', job_id='fifo-job', node_id='fifo-node', owner_id='fifo-owner',
            token='keep-token', generation=2, resource_pool='image:old-platform-build', mode='classic',
            expires_at=now() + timedelta(minutes=1), priority_class='realtime', weight=2, estimated_seconds=30))
    db.initialize()
    db.initialize()
    with sa.orm.Session(isolated_migration_database) as session:
        job, lease = session.get(Job, 'fifo-job'), session.get(ExecutionLease, 'fifo-lease')
        assert job.config['engine'] == {'protocol_version': 3}
        assert job.cache_key == content_key('a' * 64, 'classic', 'en', job.config)
        assert (job.status, job.settlement, job.quota_pages) == ('running', 'reserved', 1)
        assert (lease.token, lease.generation, lease.completed_at) == ('keep-token', 2, None)
        state = session.get(ClassicState, job.id)
        assert state.analysis == checkpoint and state.translations == {'0': 'paid translation'}
        node = session.get(ComputeNode, 'fifo-node')
        assert node.supported_languages == ['en', 'ko'] and node.desired_config == {'execution_slots': 4}
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
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, 'translations_0001')
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
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    start, end = datetime(2026, 1, 31, 18), datetime(2026, 2, 28, 18)
    period_id = digest(['calendar-user', MONTHLY, iso(start)])
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, 'redis_admission_0004')
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
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, 'gift_renewal_0005')
        connection.execute(text("INSERT INTO users (id, subject, name, role, created_at, membership_id, plus_started_at, plus_expires_at, plus_monthly_pages) VALUES ('gift-user', 'gift-user', 'New gift', 'user', CURRENT_TIMESTAMP, 'gift-segment', CURRENT_TIMESTAMP, '2099-01-01', 300)"))
        config.attributes['connection'] = connection
        with pytest.raises(RuntimeError, match='Resolve thirty-day gift periods'):
            command.downgrade(config, 'redis_admission_0004')
    # The membership guard must preserve its own schema before a later upgrade.
    with isolated_migration_database.connect() as connection:
        assert connection.scalar(text('SELECT version_num FROM alembic_version')) == 'gift_renewal_0005'
    db.initialize()
    assert_current_schema_matches_models(isolated_migration_database)


def test_title_supplier_upgrade_preserves_body_default_without_implicit_selection(isolated_migration_database):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from app import db
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, 'translations_0001')
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
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, 'comic_titles_0002')
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


@pytest.mark.parametrize('representation,key', [('original','inputs/new/source'), ('full-image-v1','results/ne/new'), ('overlay-v1','results/ov/overlay')])
def test_overlay_upgrade_cannot_roll_back_after_local_protocol_data(isolated_migration_database, representation, key):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from app import db as database
    from app.models import Asset, User
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, 'local_overlay_0007')
    with isolated_migration_database.begin() as connection:
        from sqlalchemy import Table, MetaData
        from app.models import now
        legacy_users = Table('users', MetaData(), autoload_with=connection)
        connection.execute(legacy_users.insert().values(id='overlay-owner', subject='overlay-owner', name='Reader', role='user', plus_pending=False, created_at=now()))
        connection.execute(Asset.__table__.insert().values(id='overlay-asset', owner_id='overlay-owner',
            sha256='a'*64, storage_key=key, mime='image/png', width=1, height=1,
            byte_size=10, representation=representation))
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        with pytest.raises(RuntimeError, match='previous full-image protocol'):
            command.downgrade(config, 'quota_campaigns_0006')
        assert connection.scalar(text('SELECT version_num FROM alembic_version')) == 'local_overlay_0007'
