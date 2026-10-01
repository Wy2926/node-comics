"""Hourly admission against the dedicated PostgreSQL test database and Redis."""
import os
import pytest
from test_postgres_concurrency import pg_scope
from test_compute_v3_postgres import client
from test_hourly_image_limit import (
    billing, lite,
    test_lite_seven_day_zero_redraw_trial_and_paid_version,
    test_annual_lite_grants_full_year_without_empty_redraw_buckets,
    test_admin_monitor_identifies_and_filters_effective_lite_plan,
    test_rolling_hour_counts_new_jobs_across_modes_languages_and_devices,
    test_hourly_concurrent_last_slot_and_owner_isolation,
    test_database_rollback_and_minute_rejection_release_hourly_reservation,
    test_quota_rejection_releases_only_its_hourly_reservation,
    test_result_reuse_and_sql_session_savepoints_keep_only_committed_admissions,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')
