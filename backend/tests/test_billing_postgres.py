"""Opt-in Stripe reconciliation races against an isolated PostgreSQL schema."""
import pytest
from fastapi.testclient import TestClient
from test_postgres_concurrency import pg_scope, pytestmark
from test_stripe_billing import billing, test_concurrent_reconciliation_grants_once, test_partial_page_failure_rolls_back_and_recovers
from test_billing_catalog import test_annual_concurrent_reconciliation_grants_once, test_new_price_and_benefits_do_not_change_existing_subscription, test_annual_cancel_retains_year_and_failed_renewal_does_not_pregrant

@pytest.fixture
def client(pg_scope):
    from app.main import app
    with TestClient(app) as value:
        yield value
