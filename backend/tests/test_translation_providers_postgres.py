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

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')
