"""The same scheduler and stale-output races on isolated PostgreSQL schemas."""
import os
import pytest
from test_classic_parallel_postgres import text_database
from test_cluster_scheduler import (
    scheduler_case,
    test_free_realtime_precedes_member_preload,
    test_realtime_continuous_load_preserves_preload_service,
    test_plus_weight_two_gets_twice_service_without_preload_promotion,
    test_one_user_can_borrow_all_real_device_slots,
    test_election_queries_do_not_grow_per_page_in_a_500_page_preload,
    test_concurrent_nodes_never_lease_same_stage_twice,
    test_default_pool_concurrent_claims_do_not_checkout_nested_connections,
    test_claim_uses_one_connection_and_preserves_caller_uncommitted_writes,
    test_claim_locks_scheduler_before_autoflushing_caller_job_changes,
    test_deep_queue_is_ranked_in_database_without_loading_each_job,
    test_ineligible_heads_do_not_hide_later_runnable_pages,
    test_snapshot_candidates_are_revalidated_after_queue_or_node_changes,
    test_realtime_reorder_between_snapshot_and_lock_retries_fresh_election,
    test_local_missing_source_is_not_dispatched_and_pinned_source_survives_expiry,
    test_missing_local_head_releases_reservation_once_and_unblocks_later_page,
    test_provider_capacity_is_rechecked_after_snapshot,
    test_concurrent_claims_cannot_exceed_one_node_capacity,
    test_wrong_engine_or_disabled_device_does_not_take_work,
    test_expired_image_lease_recovers_once_and_fences_old_generation,
    test_actual_work_correction_preserves_fair_resource_time,
    test_late_render_upload_cannot_overwrite_new_generation_output,
    test_conflicting_completion_of_one_lease_cannot_replace_delivered_bytes,
    test_stale_recovery_observation_cannot_end_renewed_lease,
    test_saved_late_output_recovery_preserves_existing_terminal_failure,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
                                reason='Requires the dedicated nodecomics_concurrency_test database')
