"""The same retention cases run on an isolated PostgreSQL schema."""
import os
import pytest
from test_postgres_concurrency import pg_scope
from test_compute_v3_postgres import client
from test_execution_retention import (
    test_terminal_masks_removed_but_valid_details_and_timing_remain,
    test_expired_image_details_follow_registered_and_guest_policy,
    test_running_unsettled_and_unknown_calls_keep_their_checkpoints,
    test_claim_ttl_uses_all_lease_and_job_end_times_and_bounded_batches,
    test_history_compacts_once_preserving_billing_identity_and_terminal_receipts,
    test_database_retention_changes_apply_without_restart,
    test_document_text_expires_without_changing_page_accounting_or_result,
    test_checkpoint_batches_are_bounded_and_resume,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')


def test_claim_cleanup_uses_retention_index_with_large_recent_history(client):
    from sqlalchemy import event, text
    from app.db import session_factory
    from app.execution_retention import cleanup_execution_data
    from app.models import now, uid
    from app.queue_models import ComputeClaim
    from test_execution_retention import seed, add_claim
    with session_factory()() as db:
        _, node, _ = seed(db, days=2)
        add_claim(db, node, [], 2)
        db.execute(ComputeClaim.__table__.insert(), [{'node_id': node, 'request_id': uid(),
            'request_hash': 'a' * 64, 'lease_ids': [], 'created_at': now()} for _ in range(50000)])
        db.execute(text('ANALYZE compute_claims'))
        connection, plans = db.connection(), []

        def explain(conn, cursor, statement, parameters, context, executemany):
            if statement.startswith('DELETE FROM compute_claims'):
                plans.append(conn.exec_driver_sql('EXPLAIN (FORMAT JSON) ' + statement, parameters).scalar())

        event.listen(connection, 'before_cursor_execute', explain)
        try:
            assert cleanup_execution_data(db)['claims'] == 1
        finally:
            event.remove(connection, 'before_cursor_execute', explain)
        assert 'ix_compute_claims_retention' in str(plans)
