"""Whole-page protocol races and recovery on an explicitly isolated PostgreSQL schema."""
import os
import pytest
from test_postgres_concurrency import pg_scope
from test_compute_v3 import (
    v3,
    test_claim_receipt_capacity_shrink_and_restart,
    test_concurrent_claims_never_exceed_capacity,
    test_no_text_checkpoint_is_terminal_idempotent_and_never_calls_llm,
    test_analysis_text_revision_and_delivery_settle_once,
    test_mixed_heartbeat_cancellation_and_stopped_ack,
    test_recovery_reuses_analysis_and_running_text_without_duplicate_call,
    test_deadline_cannot_be_extended_by_heartbeats,
    test_version_languages_and_direct_input_access,
    test_result_written_before_lost_commit_is_recovered,
    test_upload_is_scoped_frozen_and_validates_pixels,
    test_late_direct_upload_cannot_publish_after_cancel_or_new_generation,
    test_cancellation_during_file_publish_never_settles,
    test_verification_finishing_after_deadline_is_never_recovered,
    test_timely_received_result_can_publish_or_recover_after_deadline,
    test_invalid_identity_file_has_no_accepted_receipt_to_recover,
    test_identity_receipt_survives_crash_before_final_commit,
    test_accepted_publish_grace_is_fixed_and_stop_cannot_revoke_it,
    test_result_multipart_total_timeout_closes_partial_file,
    test_result_ingress_full_rejects_before_reading_multipart,
    test_overlay_limit_is_independent_of_original_upload_limit,
    test_overlay_larger_than_cluster_result_limit_is_rejected,
)
from test_compute_claims import (
    test_same_claim_receipt_concurrent_retries_allocate_one_batch,
    test_same_claim_id_with_concurrent_changed_count_conflicts,
    test_legacy_count32_is_bounded_and_receipt_replays_after_configuration_change,
    test_historical_wide_claim_receipt_replays_every_lease,
    test_empty_prepared_claim_rechecks_after_commit_and_hints_bounded_retry,
    test_empty_receipt_retry_hint_is_dynamic_and_does_not_allocate,
    test_prepared_claim_rechecks_intervening_changes,
)
from test_compute_multinode import (
    test_nodes_claim_first_come_with_independent_capacity_and_receipts,
    test_three_simultaneous_nodes_fill_slots_despite_shared_candidates,
    test_idle_queue_has_one_election_and_repeated_invalidations_are_bounded,
    test_retry_preserves_missing_source_cleanup_and_releases_quota_once,
    test_retry_releases_lock_and_rechecks_current_receipt_and_policy,
    test_idle_or_incompatible_peer_never_reserves_work,
    test_lost_node_work_recovers_on_peer_and_old_lease_cannot_publish,
)
from test_compute_fastpaths import (
    test_full_node_and_replay_do_not_rank_the_queue,
    test_empty_replay_only_probes_existence_and_retry_hint_is_jittered,
    test_capacity_shrink_after_preparation_does_not_trigger_reselection,
    test_exhausted_queue_does_not_run_a_second_election,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')


@pytest.fixture
def client(pg_scope):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db import session_factory
    from translation_fixtures import configure_text_provider
    from app.migrate import migrate
    migrate()
    with TestClient(app) as client:
        with session_factory()() as db:
            configure_text_provider(db)
        yield client
