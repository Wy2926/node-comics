"""Whole-page protocol races and recovery on an explicitly isolated PostgreSQL schema."""
import os
import pytest
from test_postgres_concurrency import pg_scope
from test_compute_v2 import (
    v2,
    test_claim_receipt_capacity_fairness_shrink_and_restart,
    test_concurrent_claims_never_exceed_capacity,
    test_no_text_checkpoint_is_terminal_idempotent_and_never_calls_llm,
    test_analysis_text_revision_and_delivery_settle_once,
    test_mixed_heartbeat_cancellation_and_stopped_ack,
    test_recovery_reuses_analysis_and_running_text_without_duplicate_call,
    test_deadline_cannot_be_extended_by_heartbeats,
    test_version_languages_and_r2_authorization_do_not_probe_objects,
    test_result_written_before_lost_commit_is_recovered,
    test_upload_is_scoped_frozen_bounded_and_center_never_reads_images,
    test_late_direct_upload_cannot_publish_after_cancel_or_new_generation,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')


@pytest.fixture
def client(pg_scope):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db import session_factory
    from translation_fixtures import configure_text_provider
    with TestClient(app) as client:
        with session_factory()() as db:
            configure_text_provider(db)
        yield client
