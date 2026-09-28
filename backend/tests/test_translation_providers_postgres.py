"""The same supplier scheduling and atomic mutations on an isolated PG schema."""
import os
import pytest
from test_classic_parallel_postgres import text_database
from test_classic import text_case
from test_cluster_scheduler import scheduler_case
from test_translation_providers import (
    test_disabled_supplier_pauses_before_request_without_metering,
    test_saturated_supplier_does_not_block_another_supplier,
    test_first_provider_creation_is_atomic_across_replicas,
    test_parallel_requests_obey_supplier_limit,
    test_disable_after_reservation_does_not_spend_retry_or_rpm,
    test_mid_page_rate_wait_releases_shared_slot,
    test_upstream_429_yields_with_durable_attempt_budget,
)
from test_provider_limits import (
    test_body_and_title_share_upstream_budget,
    test_parallel_body_and_title_cannot_overbook_supplier,
    test_title_disabled_before_transport_reclaims_upstream_admission,
    test_unknown_request_keeps_reservation_until_window_expires,
    test_supplier_cleanup_does_not_change_other_supplier_window,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')
