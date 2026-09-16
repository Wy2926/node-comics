"""Upgrade only isolated databases, preserving existing users and durable receipts."""
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
import pytest
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, create_engine, event, inspect, select, text
from sqlalchemy.orm import Session

HEAD = "shared_0004_text_providers"
NEW_TABLES = {"upload_ingress_mutex", "upload_ingress_leases", "feedback_admissions", "system_settings",
              "translation_providers", "translation_provider_revisions"}


@pytest.fixture
def isolated_migration_database(tmp_path, monkeypatch):
    """No environment files, configured database, identity or object store is used."""
    from app import db
    private_engine = create_engine(f"sqlite:///{(tmp_path / 'upgrade.db').as_posix()}")
    @event.listens_for(private_engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
    monkeypatch.setattr(db, "engine", lambda: private_engine)
    monkeypatch.setattr(db, "settings", lambda: SimpleNamespace(storage_path=tmp_path / "objects"))
    try:
        yield private_engine
    finally:
        private_engine.dispose()


def upgrade_to(engine, revision):
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, revision)


def assert_current_schema_matches_models(engine):
    from app.db import Base
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == HEAD
        inspector = inspect(connection)
        assert NEW_TABLES <= set(inspector.get_table_names())
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


def seed_baseline_receipts(engine):
    from app.models import Asset, Job, User
    from app.providers import digest
    from app.reader_api import Feedback
    from app.upload_models import UploadReservation
    at = datetime(2026, 9, 16, 1, 0)
    with Session(engine) as session:
        session.add(User(id="legacy-owner", subject="isolated:legacy-owner", name="合成旧账户"))
        session.flush()
        source = Asset(id="legacy-original", owner_id="legacy-owner", sha256="a" * 64,
                       storage_key="isolated/original", storage_backend="r2", kind="original",
                       mime="image/png", width=10, height=10, byte_size=100)
        output = Asset(id="legacy-output", owner_id="legacy-owner", sha256="b" * 64,
                       storage_key="isolated/result", storage_backend="r2", kind="classic",
                       parent_id="legacy-original", mime="image/png", width=10, height=10, byte_size=100)
        session.add(source)
        session.flush()
        session.add(output)
        session.flush()
        common = dict(owner_id="legacy-owner", mode="classic", target_language="en",
                      operation="isolated-migration", request_hash="a" * 64, cache_key="a" * 64,
                      config={}, quota_pages=0, quota_kind="classic_daily", settlement="free")
        session.add_all([
            Job(id="legacy-result-job", idempotency_key="old-result", input_asset_id=source.id,
                output_asset_id=output.id, source_sha256=source.sha256, status="succeeded", **common),
            Job(id="legacy-upload-job", idempotency_key="old-upload", source_sha256="c" * 64,
                status="awaiting_upload", **common),
        ])
        session.flush()
        session.add(UploadReservation(
            id="legacy-upload", job_id="legacy-upload-job", owner_id="legacy-owner", mode="classic",
            expected_sha256="c" * 64, expected_size=100, mime="image/png", storage_key="isolated/upload",
            storage_backend="r2", status="uploaded", expires_at=at + timedelta(minutes=15),
            max_expires_at=at + timedelta(hours=1), created_at=at,
        ))
        session.add(Feedback(
            id="legacy-feedback", owner_id="legacy-owner", job_id="legacy-result-job", output_asset_id=output.id,
            issues=["meaning"], comment="合成旧反馈", status="reviewing", idempotency_key="legacy-feedback-key",
            request_hash=digest({"job_id": "legacy-result-job", "output_asset_id": output.id,
                                 "issues": ["meaning"], "comment": "合成旧反馈"}),
            created_at=at, updated_at=at,
        ))
        session.commit()


def baseline_snapshot(engine):
    from app.models import Asset, Job, User
    from app.reader_api import Feedback
    from app.upload_models import UploadReservation
    with engine.connect() as connection:
        return {model.__tablename__: [dict(row) for row in connection.execute(
                    select(model.__table__).order_by(model.id)).mappings()]
                for model in (User, Asset, Job, Feedback, UploadReservation)}


def test_upgrade_preserves_existing_users_feedback_and_uploads(isolated_migration_database, monkeypatch):
    from app import db, system_settings
    from app.feedback_models import FeedbackAdmission
    from app.models import User
    from app.reader_api import FeedbackRequest, submit_feedback
    engine = isolated_migration_database
    upgrade_to(engine, "shared_0001")
    assert not NEW_TABLES & set(inspect(engine).get_table_names())
    seed_baseline_receipts(engine)
    before = baseline_snapshot(engine)
    # Exercise the actual startup migration path, not metadata.create_all().
    db.initialize()
    assert baseline_snapshot(engine) == before
    assert_current_schema_matches_models(engine)
    db.initialize()  # Restarting the upgraded application is safe and repeatable.
    assert baseline_snapshot(engine) == before
    monkeypatch.setattr(system_settings, "settings", lambda: SimpleNamespace(
        feedback_request_burst=10, feedback_requests_per_minute=30, feedback_receipts_per_day=100,
        upload_user_concurrency=10, upload_global_concurrency=16, upload_idle_timeout_seconds=15,
        upload_body_timeout_seconds=120, upload_ingress_lease_seconds=45))
    with Session(engine, expire_on_commit=False) as session:
        receipt = submit_feedback("legacy-result-job", FeedbackRequest(issues=["meaning"], comment="合成旧反馈"),
                                  "legacy-feedback-key", session.get(User, "legacy-owner"), session)
        assert receipt["id"] == "legacy-feedback" and receipt["status"] == "reviewing"
        assert session.get(FeedbackAdmission, "legacy-owner").daily_receipts == 0
    assert baseline_snapshot(engine) == before


def test_fresh_startup_creates_current_request_limit_schema(isolated_migration_database):
    from app import db
    db.initialize()
    assert_current_schema_matches_models(isolated_migration_database)
