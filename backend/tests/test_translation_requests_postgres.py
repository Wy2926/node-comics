"""Same UUID admission contract against isolated PostgreSQL locks."""
import os
import pytest
from test_postgres_concurrency import pg_scope
from test_compute_v3_postgres import client
from test_cluster_submissions import cluster
from test_translation_requests import (
    test_legacy_priority_is_ignored_without_repeating_admission,
    test_concurrent_same_uuid_accepts_exactly_once,
    test_concurrent_devices_cannot_exceed_remaining_image_budget,
    test_rejected_page_cannot_rollback_another_independent_request,
    test_cancel_does_not_refund_minute_admission,
)
pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')
from test_notifications import (
    test_nested_page_savepoints_notify_only_after_outer_commit,
    test_reader_snapshot_is_immediate_and_owner_scoped,
    test_snapshot_handles_lost_notification_and_auth_scoped_etag,
)
from test_translation_events import (
    test_stream_only_reads_owned_requests,
    test_idle_heartbeats_do_not_query_db_and_stream_releases_resources,
)
