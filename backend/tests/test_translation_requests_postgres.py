"""Same UUID admission contract against isolated PostgreSQL locks."""
import os
import pytest
from test_postgres_concurrency import pg_scope
from test_compute_v2_postgres import client
from test_cluster_submissions import cluster
from test_translation_requests import (
    test_concurrent_same_uuid_accepts_exactly_once,
    test_concurrent_devices_cannot_exceed_remaining_image_budget,
    test_rejected_page_cannot_rollback_another_independent_request,
    test_cancel_does_not_refund_minute_admission,
)
pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')
from test_notifications import (
    test_nested_page_savepoints_notify_only_after_outer_commit,
    test_reader_long_poll_is_owner_scoped_and_releases_database,
    test_snapshot_handles_lost_notification_and_auth_scoped_etag,
)
