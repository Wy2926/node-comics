"""Frozen clean-install schema must match the durable cluster models."""
from sqlalchemy import inspect
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext


def test_clean_baseline_matches_models_and_removes_old_queue(client):
    from app.db import Base, engine
    with engine().connect() as connection:
        inspector = inspect(connection)
        tables = set(inspector.get_table_names())
        assert not tables & {"outbox", "queue_admissions", "scheduler_states", "translation_previews", "batches", "batch_items"}
        assert {"execution_leases", "job_stages", "upload_reservations", "translation_submissions", "submission_items"} <= tables
        columns = {c["name"]: c for c in inspector.get_columns("assets")}
        assert columns["expires_at"]["nullable"]
        assert columns["last_accessed_at"]["nullable"]
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []
