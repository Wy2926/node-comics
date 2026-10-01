"""Visitor admission and isolation on real PostgreSQL, never the product database."""
import os
import pytest
from test_postgres_concurrency import pg_scope
from test_compute_v3_postgres import client
from test_cluster_submissions import cluster
from test_website_guests import (
    visitor,
    test_guest_identity_is_not_a_registered_account,
    test_origin_protocol_and_proof_are_all_required,
    test_durable_five_attempts_replay_conflict_and_cancel,
    test_network_budget_survives_cookie_reset_and_ip_header_spoof,
    test_same_content_reuses_job_and_concurrent_new_content_has_one_slot,
    test_global_budget_rollback_does_not_consume_guest_or_network,
    test_independent_guests_cannot_race_past_shared_limits,
    test_upload_read_and_guest_result_expiry,
    test_activity_and_manual_grants_cannot_award_visitors,
    test_disabled_feature_still_allows_existing_task_reads,
    test_redis_outage_blocks_anonymous_api_before_new_admission,
    test_guest_credentials_are_not_an_oidc_account_and_identity_constraints_hold,
    test_guest_session_status_shares_the_read_request_limit,
    test_remote_verification_releases_database_connection,
    test_expired_sessions_bound_unused_owner_cleanup_and_keep_task_evidence,
)

pytestmark=pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY')!='1',
    reason='Requires the dedicated nodecomics_concurrency_test database')
