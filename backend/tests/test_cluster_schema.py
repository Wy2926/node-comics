"""Frozen clean-install schema must match the durable cluster models."""
from sqlalchemy import inspect
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext


def test_clean_baseline_matches_models_and_removes_old_queue(client):
    from app.db import Base, engine
    with engine().connect() as connection:
        inspector = inspect(connection)
        tables = set(inspector.get_table_names())
        assert not tables & {"outbox", "queue_admissions", "scheduler_states", "translation_previews", "batches", "batch_items", "translation_submissions", "submission_items", "submission_admissions", "translation_operations", "reading_sessions", "translation_policies"}
        assert {"execution_leases", "job_stages", "upload_reservations", "translation_requests"} <= tables
        assert not {"image_admissions", "control_admissions", "feedback_admissions", "comic_title_admissions",
            "upload_ingress_leases", "upload_ingress_mutex", "support_request_admissions", "translation_provider_requests"} & tables
        assert {"admin_audit_events", "translation_feedback_reviews", "billing_refunds", "billing_disputes"} <= tables
        assert not {'priority_session_id','priority_epoch','window_hash','sequence'}.intersection(
            c['name'] for c in inspector.get_columns('user_mode_queues'))
        assert not {'file_hash','page_index','change_sequence'}.intersection(
            c['name'] for c in inspector.get_columns('jobs'))
        columns = {c["name"]: c for c in inspector.get_columns("assets")}
        assert columns["expires_at"]["nullable"]
        assert "last_accessed_at" not in columns and "storage_backend" not in columns
        assert not {"result_accesses", "translation_results", "file_pages"} & tables
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []
