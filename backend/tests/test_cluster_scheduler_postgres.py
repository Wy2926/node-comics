"""The same scheduler and stale-output races on isolated PostgreSQL schemas."""
import os
import pytest
from test_classic_parallel_postgres import text_database
from test_cluster_scheduler import (
    scheduler_case,
    test_plus_preferred_within_oldest_candidate_window,
    test_plus_preference_does_not_scan_past_candidate_window,
    test_one_user_can_borrow_all_real_device_slots,
    test_election_queries_do_not_grow_per_page_in_a_500_page_preload,
    test_concurrent_nodes_never_lease_same_stage_twice,
    test_default_pool_concurrent_claims_do_not_checkout_nested_connections,
    test_claim_uses_one_connection_and_preserves_caller_uncommitted_writes,
    test_claim_locks_scheduler_before_autoflushing_caller_job_changes,
    test_deep_queue_fetches_only_bounded_fifo_candidates,
    test_ineligible_heads_do_not_hide_later_runnable_pages,
    test_snapshot_candidates_are_revalidated_after_queue_or_node_changes,
    test_local_missing_source_is_not_dispatched_and_pinned_source_survives_expiry,
    test_missing_local_head_releases_reservation_once_and_unblocks_later_page,
    test_provider_capacity_is_rechecked_after_snapshot,
    test_concurrent_claims_cannot_exceed_one_node_capacity,
    test_different_build_can_claim_but_disabled_node_cannot,
    test_expired_image_lease_recovers_once_and_fences_old_generation,
    test_stale_recovery_observation_cannot_end_renewed_lease,
    test_saved_late_output_recovery_preserves_existing_terminal_failure,
)
from test_control_dispatch import (
    test_batch_preserves_simple_plus_preference,
    test_batch_elects_backlog_once_and_honors_capacity,
    test_concurrent_batches_never_overbook_or_duplicate,
    test_batch_rechecks_supplier_concurrency_after_each_pick,
    test_prepared_batch_revalidates_and_does_not_repeat_full_election,
    test_claimability_check_does_not_mutate_state,
    test_claimability_uses_registered_languages,
    test_idle_delay_tracks_retry_deadline,
    test_worker_rechecks_crossed_deadline_before_sleep_without_local_overbooking,
    test_idle_delay_tracks_supplier_limit_without_reserving,
    test_thread_wakeup_requires_commit,
    test_capacity_and_supplier_changes_wake_only_after_commit,
)
from test_scheduler_readiness import (
    test_readiness_filters_without_sorting_or_materializing_jobs,
    test_readiness_is_advisory_without_scanning_local_files,
    test_control_readiness_respects_supplier_limits_and_upload_without_source,
    test_text_readiness_respects_supplier_enablement_and_rpm,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
                                reason='Requires the dedicated nodecomics_concurrency_test database')
