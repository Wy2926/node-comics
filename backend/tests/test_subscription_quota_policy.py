"""Model access and the allowance being charged are independent decisions."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import pytest
from sqlalchemy import func, select
from app.db import session_factory
from app.entitlement_models import QuotaPeriod
from app.entitlements import settle
from app.models import Job, Ledger, User, now
from app.translation_models import TranslationProvider
from conftest import configure_system_limits, create, login, png_variant, upload
from test_membership import grant, entitlement
from test_stripe_billing import billing  # noqa: F401


def premium_only():
    with session_factory()() as db:
        provider = db.scalar(select(TranslationProvider))
        provider.text_plan_ids = ['plus']
        db.commit()


def test_free_models_spend_free_then_subscription_then_stop(client, png):
    configure_system_limits(free_daily_pages=1)
    auth = login(client)
    assert grant(client, auth, pages=2).status_code == 200
    assets = [upload(client, auth, png_variant(png, i)) for i in range(4)]
    jobs = [create(client, auth, asset, key=str(i)).json() for i, asset in enumerate(assets[:3])]
    assert [job['quota_kind'] for job in jobs] == ['classic_daily', 'classic_monthly', 'classic_monthly']
    assert create(client, auth, assets[3], key='empty').status_code == 403
    assert create(client, auth, assets[2], key='2').json()['id'] == jobs[2]['id']
    rights = entitlement(client, auth)
    assert rights['free_quota']['available'] == rights['subscription_quota']['available'] == 0
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'reserve')) == 3
        for response in jobs:
            job = db.get(Job, response['id'])
            assert job.entitlement['service_plan'] == 'free'
            job.status = 'failed'
            settle(db, job, success=False)
            settle(db, job, success=False)
        db.commit()
    rights = entitlement(client, auth)
    assert rights['free_quota']['available'] == 1
    assert rights['subscription_quota']['available'] == 2


def test_premium_model_never_spends_free_allowance(client, png):
    auth = login(client)
    grant(client, auth, pages=1)
    premium_only()
    job = create(client, auth, upload(client, auth, png)).json()
    assert job['quota_kind'] == 'classic_monthly'
    rights = entitlement(client, auth)
    assert rights['free_quota']['available'] == 30
    assert rights['subscription_quota']['available'] == 0
    with session_factory()() as db:
        assert db.get(Job, job['id']).config['text']['provider_id']
        assert db.get(Job, job['id']).entitlement['service_plan'] == 'plus'


def test_unlimited_subscription_still_uses_free_pages_for_free_model_first(client, png):
    configure_system_limits(free_daily_pages=1)
    auth = login(client)
    grant(client, auth, pages=None)
    first = create(client, auth, upload(client, auth, png)).json()
    second = create(client, auth, upload(client, auth, png_variant(png, 1)), key='paid').json()
    assert first['quota_kind'] == 'classic_daily' and first['quota_pages'] == 1
    assert second['quota_kind'] == 'classic_unlimited' and second['settlement'] == 'included'
    assert entitlement(client, auth)['subscription_quota']['unlimited']


def test_last_subscription_page_is_atomic_and_accounts_are_isolated(client, png):
    configure_system_limits(free_daily_pages=0)
    auth = login(client)
    grant(client, auth, pages=1)
    assets = [upload(client, auth, png_variant(png, i)) for i in range(2)]
    barrier = Barrier(2)
    def submit(i):
        barrier.wait(timeout=10)
        return create(client, auth, assets[i], key=str(i)).status_code
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(submit, range(2))) == [202, 403]
    other = login(client, 'other')
    assert entitlement(client, other)['subscription_quota']['available'] == 0
    assert create(client, other, upload(client, other, png), key='other').status_code == 403


@pytest.mark.parametrize('success', [True, False])
def test_settlement_after_subscription_expiry_uses_original_period(client, png, success):
    configure_system_limits(free_daily_pages=0)
    auth = login(client)
    grant(client, auth, pages=2)
    response = create(client, auth, upload(client, auth, png)).json()
    with session_factory()() as db:
        job = db.get(Job, response['id'])
        period = db.get(QuotaPeriod, job.quota_period_id)
        period.starts_at = now() - timedelta(days=1)
        period.ends_at = now() - timedelta(seconds=1)
        db.get(User, job.owner_id).plus_expires_at = period.ends_at
        job.status = 'succeeded' if success else 'failed'
        settle(db, job, success=success)
        settle(db, job, success=success)
        db.commit()
        assert (period.used, period.reserved) == (int(success), 0)
    assert entitlement(client, auth)['subscription_quota']['available'] == 0
    assert create(client, auth, upload(client, auth, png_variant(png, 3)), key='expired').status_code == 403


def test_removed_image_mode_and_admin_routes_are_not_available(client, png):
    auth = login(client, 'admin')
    assert create(client, auth, upload(client, auth, png), mode='redraw').status_code == 422
    assert client.get('/v1/admin/providers', headers=auth).status_code == 404
    assert [mode['id'] for mode in client.get('/v1/capabilities').json()['modes']] == ['classic']


def test_free_model_falls_through_all_three_balances_then_rejects(client, png):
    from test_quota_purchase_admission import seed_purchase
    configure_system_limits(free_daily_pages=1)
    auth = login(client)
    grant(client, auth, pages=1)
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    with session_factory()() as db:
        seed_purchase(db, owner, pages=1, service='plus')
        db.commit()
    responses = [create(client, auth, upload(client, auth, png_variant(png, i)), key=f'chain-{i}') for i in range(4)]
    assert [response.status_code for response in responses] == [202, 202, 202, 403]
    assert [response.json()['quota_kind'] for response in responses[:3]] == [
        'classic_daily', 'classic_monthly', 'classic_purchase']
    rights = entitlement(client, auth)
    assert not rights['modes']['classic']['allowed']
    assert all(rights[key]['available'] == 0 for key in ('free_quota', 'subscription_quota', 'purchase_quota'))


def test_subscription_selection_stays_indexed_with_ten_thousand_expired_buckets(billing):
    from statistics import median
    from time import perf_counter
    from sqlalchemy import insert
    from app.billing_access import first_subscription
    from test_stripe_billing import complete_trial, periods
    complete_trial(billing)
    current, = periods()
    at = now()
    with session_factory()() as db:
        def measure():
            samples = []
            for _ in range(30):
                start = perf_counter()
                assert first_subscription(db, billing['owner'], at)[0].id == current.id
                samples.append((perf_counter() - start) * 1000)
            return median(samples)
        before = measure()
        db.execute(insert(QuotaPeriod), [{'id': f'history-{i}', 'owner_id': billing['owner'],
            'billing_term_id': current.billing_term_id, 'kind': 'classic_monthly', 'mode': 'classic',
            'source': 'subscription', 'source_key': f'history-{i}', 'granted': 100,
            'starts_at': at - timedelta(days=i + 2), 'ends_at': at - timedelta(days=1)} for i in range(10000)])
        db.commit()
        after = measure()
        # Capture exactly the bounded selector, not a broad balance/history read.
        from sqlalchemy import event
        statements = []
        def capture(connection, cursor, statement, parameters, context, executemany):
            statements.append((statement, parameters))
        connection = db.connection()
        event.listen(connection, 'before_cursor_execute', capture)
        try:
            first_subscription(db, billing['owner'], at)
        finally:
            event.remove(connection, 'before_cursor_execute', capture)
        assert len(statements) == 1 and 'LIMIT' in statements[0][0]
        if connection.dialect.name == 'sqlite':
            plan = connection.exec_driver_sql('EXPLAIN QUERY PLAN ' + statements[0][0], statements[0][1]).all()
            assert any('SEARCH quota_periods USING INDEX' in row[3] for row in plan)
        print(f'subscription selector median: empty history {before:.3f} ms; 10,000 expired buckets {after:.3f} ms')
