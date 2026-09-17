"""Opt-in billing races against the existing dedicated PostgreSQL test fixture."""
import pytest
from fastapi.testclient import TestClient

from test_postgres_concurrency import pg_scope, pytestmark
from test_paddle_billing import billing
from test_billing_reconciliation import (
    test_concurrent_webhook_and_catchup_grant_once,
    test_failed_page_rolls_back_its_grants_and_receipts,
    test_partial_page_failure_retries_without_advancing_cursor_or_regranting,
)


@pytest.fixture
def client(pg_scope):
    # The billing fixture supplies sandbox config before resolving this client;
    # pg_scope replaces only the DB/identity and never uses the product database.
    from app.main import app
    with TestClient(app) as value:
        yield value
