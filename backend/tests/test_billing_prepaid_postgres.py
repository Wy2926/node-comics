"""Opt-in prepaid races on the dedicated PostgreSQL test database, no live payment."""
import pytest
from fastapi.testclient import TestClient

from test_postgres_concurrency import pg_scope, pytestmark
from test_billing_purchases import purchase
from test_billing_prepaid import (
    prepaid,
    membership_payment_choices,
    test_concurrent_membership_payment_types_cannot_create_two_payable_intents,
    test_prepaid_concurrent_same_intent_and_notification_replay_grant_once,
    test_prepaid_concurrent_independent_payments_serialize_membership_terms,
    test_prepaid_manual_renewal_extends_without_duplicate_months,
    test_prepaid_payment_and_monthly_grants_commit_atomically,
    test_prepaid_reversal_before_payment_notification_never_grants,
)


@pytest.fixture
def client(pg_scope):
    from app.main import app
    from app.migrate import migrate
    migrate()
    with TestClient(app) as value:
        yield value
