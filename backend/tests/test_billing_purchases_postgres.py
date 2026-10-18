"""Opt-in purchase isolation and concurrency on an isolated PostgreSQL schema."""
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_postgres_concurrency import pg_scope, pytestmark
from test_creem_checkout_failures import test_quota_pack_http_failure_preserves_original_intent_without_reposting
from test_billing_purchases import (
    purchase, buy,
    test_one_time_purchase_grants_once_and_replays_same_intent,
    test_unknown_creation_recovers_original_order_without_new_charge,
    test_concurrent_same_purchase_intent_never_creates_second_order,
    test_concurrent_purchase_notifications_grant_and_log_once,
    test_payment_order_quota_and_ledger_commit_atomically,
    test_reversal_before_checkout_notification_never_grants,
    test_reversal_preserves_usage_and_reservations_and_does_not_restore,
    test_existing_subscription_does_not_block_purchase_or_get_hidden_from_sync,
    test_first_purchase_preflight_failure_allows_only_explicit_new_intent,
    test_unknown_purchase_cannot_be_released_by_a_later_preflight_failure,
    test_stripe_preflight_cannot_dispatch_after_a_competing_failure,
    test_stripe_dispute_is_checked_before_first_grant_despite_stale_charge,
    test_stripe_won_dispute_does_not_restore_purchase_with_stale_charge,
    test_stripe_refund_is_checked_before_first_grant_despite_stale_charge,
    test_incomplete_stripe_reversal_read_cannot_commit_a_purchase,
)
from test_billing_checkout_categories import (
    category_buyer,
    test_subscription_pending_does_not_lock_same_or_other_quota_prices,
    test_distinct_key_concurrency_reuses_one_checkout_per_price,
    test_unknown_same_price_reuses_original_intent_without_blocking_other_quotes,
    test_customerless_purchases_settle_with_distinct_customers,
    test_quota_before_customerless_subscription_does_not_claim_canonical,
    test_later_canonical_customer_cannot_block_bound_purchase_refund,
)
from test_billing_checkout_reuse import (
    test_alternate_key_is_durable_without_replacing_original_intent,
    test_new_key_reuses_oldest_pending_without_merging_historical_checkouts,
    test_alias_never_resolves_another_accounts_checkout,
    test_alias_replay_cannot_change_quote_or_provider,
    test_same_key_is_scoped_to_its_account,
)


@pytest.fixture
def client(pg_scope):
    from app.main import app
    from app.migrate import migrate
    migrate()
    with TestClient(app) as value:
        yield value


def test_purchase_event_correlation_uses_postgres_expression_index(purchase):
    if purchase['provider'] != 'creem':
        pytest.skip('Creem transaction event lookup')
    from app.billing_models import BillingEvent
    from app.billing_purchases import creem_purchase_events
    from app.db import session_factory
    with session_factory()() as db:
        db.add_all([BillingEvent(id=f'creem:test:evt_history{index}', provider='creem', environment='test',
            event_type='checkout.completed', resource_id=f'ch_history{index}',
            payload={'transaction_id': f'tran_history{index}'}, occurred_at=purchase['at']) for index in range(2000)])
        db.flush()
        db.connection().exec_driver_sql('ANALYZE billing_events')
        statement = creem_purchase_events(db, 'tran_history1999').where(BillingEvent.event_type == 'checkout.completed')
        compiled = statement.compile(dialect=db.bind.dialect, compile_kwargs={'literal_binds': True})
        plan = db.connection().exec_driver_sql('EXPLAIN ' + str(compiled)).all()
        assert any('ix_billing_events_transaction' in str(row) for row in plan), plan
        assert len(list(db.scalars(statement))) == 1


def test_distinct_purchase_requests_reuse_one_pending_checkout(purchase, monkeypatch):
    from app import creem_client, stripe_client
    from app.billing_models import BillingCheckout, BillingCheckoutAlias, BillingOrder
    from app.db import session_factory
    state = purchase
    provider = creem_client if state['provider'] == 'creem' else stripe_client
    original = provider.call
    receipt_lock = Lock()

    def provider_call(*args, **kwargs):
        # Only the sequential IDs in the mock are serialized, not the requests
        # or their PostgreSQL transactions.
        with receipt_lock:
            return original(*args, **kwargs)

    monkeypatch.setattr(provider, 'call', provider_call)
    keys = [f'purchase-tab-{index}' for index in range(6)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda key: buy(state, key), keys))
    assert all(response.status_code == 200 or state['provider'] == 'creem' and response.status_code == 409
        and response.json()['error']['code'] == 'CREEM_CHECKOUT_UNCERTAIN' for response in responses), [r.text for r in responses]
    replays = [buy(state, key) for key in keys]
    assert all(response.status_code == 200 for response in replays), [r.text for r in replays]
    assert len({response.json()['checkout_id'] for response in replays}) == len(state['sessions']) == 1
    with session_factory()() as db:
        checkouts = list(db.scalars(select(BillingCheckout).where(BillingCheckout.owner_id == state['owner'])))
        orders = list(db.scalars(select(BillingOrder).where(BillingOrder.owner_id == state['owner'])))
        aliases = list(db.scalars(select(BillingCheckoutAlias).where(BillingCheckoutAlias.owner_id == state['owner'])))
        assert len(checkouts) == 1 and len(aliases) == 5
        assert {row.idempotency_key for row in checkouts + aliases} == set(keys)
        assert {alias.checkout_id for alias in aliases} == {checkouts[0].id}
        assert all(row.status == 'open' for row in checkouts)
        assert len(orders) == 1 and orders[0].status == 'pending'
    posts = len(state['posts'])
    for key, response in zip(keys, replays):
        assert buy(state, key).json() == response.json()
    assert len(state['posts']) == posts
    if state['provider'] == 'creem':
        assert posts == 1
