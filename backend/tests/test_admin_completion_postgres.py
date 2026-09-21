"""Opt-in completed admin capabilities on the dedicated PostgreSQL test database.

Reuse the same behavioral assertions against real SQL/row locks. pg_scope refuses
any database other than nodecomics_concurrency_test and isolates every test in a
random schema; provider requests stay on the existing simulated transports.
"""
import pytest
from fastapi.testclient import TestClient
from test_postgres_concurrency import pg_scope, pytestmark
from test_billing_admin import administrator, order_data
from test_creem_billing import creem_billing
from test_stripe_billing import billing
from test_admin_operations import (
    operations,
    test_metadata_views_never_touch_objects_or_expose_private_payloads,
    test_filters_pagination_and_reuse_relationships,
    test_availability_preserves_pinned_originals_but_never_deleted_access,
    test_statistics_separate_execution_from_grants_and_keep_unknown_cost,
    test_payment_statistics_do_not_merge_test_and_live_orders,
    test_payment_health_keeps_environment_backlogs_separate,
)
from test_admin_audit import (
    test_audit_is_admin_only_and_filters_paginate,
    test_record_audit_shares_transaction_and_deduplicates_operation,
    test_audit_redacts_nested_secrets_and_signed_url_query,
    test_node_mutations_record_configuration_without_node_credentials,
    test_text_provider_audit_and_revision_history_preserve_old_configuration,
    test_versioned_rules_affect_new_periods_and_memberships_without_rewriting_existing_grants,
)
from test_billing_admin_completion import (
    test_historical_reconcile_targets_selected_checkout_not_owners_latest,
    test_historical_reconcile_targets_selected_subscription_and_transaction,
    test_event_search_detail_permissions_and_no_raw_payload,
    test_event_retry_is_audited_idempotent_and_rate_limited,
    test_event_retry_honors_processing_lease,
    test_two_partial_refunds_keep_both_records_and_cumulative_total,
    test_sparse_refund_is_unknown_and_currency_mismatch_stays_retryable,
    test_dispute_records_original_transaction_and_late_payment_does_not_restore_access,
    test_subscription_customer_invoice_term_trace_is_paginated_and_private,
    test_stripe_refund_pages_and_dispute_replay_keep_per_record_details,
    test_stale_event_worker_cannot_overwrite_a_newer_attempt,
    test_stripe_installment_refund_is_not_misreported_as_full_invoice_refund,
    test_concurrent_manual_retry_only_creates_one_durable_receipt,
)


@pytest.fixture
def client(pg_scope):
    from app.main import app
    with TestClient(app) as value:
        yield value
