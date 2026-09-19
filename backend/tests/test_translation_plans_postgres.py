"""Same admission contract exercised against row locks in isolated PostgreSQL."""
import os
import pytest
from test_postgres_concurrency import pg_scope
from test_compute_v2_postgres import client
from test_cluster_submissions import cluster
from test_translation_plans import (
    test_concurrent_devices_cannot_exceed_remaining_image_budget,
    test_idempotency_conflict_is_local_to_one_page,
    test_partial_admission_and_lookup_only_do_not_leak_rejected_rows,
    test_internal_error_rolls_back_entire_plan_and_no_receipt_escapes,
    test_cancel_does_not_refund_minute_admission,
)

pytestmark=pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY')!='1',
    reason='Requires the dedicated nodecomics_concurrency_test database')
from test_notifications import test_nested_page_savepoints_notify_only_after_outer_commit
