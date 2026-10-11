"""Same admission/receipt races on the isolated PostgreSQL test database only."""
import os
import pytest

from test_postgres_concurrency import pg_scope
from test_compute_v3_postgres import client
from test_compute_v3 import v3
from test_document_quota_api import document_case
from test_document_compute import (
    documents,
    test_concurrent_claim_receipt_and_configuration_replay,
    test_unreserved_pages_and_other_owners_never_claim,
    test_interactive_claim_has_constant_query_count_with_200_document_pages,
)
from test_document_borrowing import (
    test_idle_pages_borrow_total_capacity_with_fifo_and_one_lease_receipts,
    test_disabled_document_slots_preserve_active_and_empty_receipts,
    test_prepare_and_zip_do_not_borrow_but_ready_pages_can,
    test_ordinary_arrival_stops_new_document_claims_without_preemption,
    test_active_ordinary_keeps_baseline_even_with_spare_capacity,
    test_capacity_shrink_does_not_revoke_borrowed_pages,
    test_unrecovered_expired_document_still_occupies_total_capacity,
    test_only_this_nodes_eligible_ordinary_queue_blocks_borrowing,
    test_ordinary_active_on_another_resource_does_not_block_borrowing,
    test_parallel_document_claims_share_total_capacity,
    test_parallel_mixed_claims_prioritize_ordinary_and_keep_baseline,
    test_document_claim_rechecks_ordinary_ready_after_scheduler_lock,
    test_claim_query_budget_is_one_aggregate_one_exists_independent_of_backlog,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')
