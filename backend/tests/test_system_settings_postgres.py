"""Shared settings races against the dedicated PostgreSQL database only."""
import os
import pytest
from test_classic_parallel_postgres import text_database
from test_system_settings import (
    system_case,
    test_only_administrators_can_read_and_change_settings,
    test_environment_only_seeds_once_and_initializer_leaves_commit_to_caller,
    test_request_snapshots_refresh_without_extra_connections_or_implicit_commit,
    test_concurrent_initialization_chooses_one_seed,
    test_concurrent_updates_cannot_overwrite_another_administrator,
)

pytestmark = pytest.mark.skipif(os.environ.get("RUN_POSTGRES_CONCURRENCY") != "1",
    reason="Requires the dedicated nodecomics_concurrency_test database")
