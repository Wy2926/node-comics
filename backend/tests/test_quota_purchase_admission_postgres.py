"""Purchase admission and opt-in scale checks on the dedicated PostgreSQL schema."""
import os
import pytest
from test_postgres_concurrency import pg_scope  # noqa: F401
from test_quota_campaigns_postgres import client  # noqa: F401
from test_quota_purchase_admission import (
    account, cluster, admin_case, billing, lite,
    test_purchase_preserves_free_identity_and_has_separate_permanent_balance,
    test_free_pages_then_purchases_follow_earliest_expiry,
    test_purchase_expiry_hint_only_describes_remaining_available_pages,
    test_concurrent_last_purchased_page_and_uuid_replay_are_exactly_once,
    test_settlement_always_uses_original_purchase_and_cannot_reactivate_revoked_balance,
    test_subscription_uses_no_purchase_and_original_expiry_keeps_running,
    test_independent_free_gift_does_not_inherit_purchase_service,
    test_purchase_changes_share_account_rate_keys_and_do_not_reset_hour_window,
    test_purchase_upgrade_does_not_reset_existing_free_minute_usage,
    test_last_reserved_page_retains_scheduler_priority_after_expiry,
    test_purchase_history_keyset_pagination_is_private_and_bounded,
    test_model_selection_and_cache_identity_follow_actual_service_not_payment_product,
    test_same_model_reuse_survives_purchase_exhaustion_without_rebilling,
    test_lite_paid_term_takes_precedence_over_purchase_hourly_terms,
)
from test_quota_purchase_performance import test_permanent_history_never_loads_at_admission_or_into_account_response

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')
