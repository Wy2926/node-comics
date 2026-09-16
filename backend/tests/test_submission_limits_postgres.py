"""Real PostgreSQL row locks enforce admission across independent API sessions."""
import os
import pytest
from test_classic_parallel_postgres import text_database
from test_cluster_scheduler import scheduler_case
from test_submission_limits import (
    test_independent_sessions_enforce_same_account_concurrency,
    test_expired_admission_lease_does_not_permanently_block_account,
    test_independent_sessions_share_request_and_item_bursts,
)

pytestmark = pytest.mark.skipif(os.environ.get("RUN_POSTGRES_CONCURRENCY") != "1",
    reason="Requires the dedicated nodecomics_concurrency_test database")
