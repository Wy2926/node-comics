"""Purchased pages use a frozen service policy without becoming a subscription."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from admission_test_utils import window_count
from app.billing_models import BillingOrder, BillingPlan, BillingPlanRevision, BillingPrice, BillingPriceBinding
from app.db import session_factory
from app.entitlement_models import QuotaPeriod
from app.entitlements import admission_policy, entitlements_json, settle
from app.models import Job, Ledger, User, now, uid
from conftest import configure_system_limits, login, login_plus, request_record
from test_cluster_submissions import cluster, grant_redraw, manifest, submit  # noqa: F401
from test_translation_requests import high_control_budget
from test_translation_providers import admin_case, body, create  # noqa: F401
from test_hourly_image_limit import billing, lite  # noqa: F401


def seed_purchase(db, owner, *, pages=3, start=None, end=None, hourly=1200, service='lite'):
    """Isolated paid-order fixture; no provider call or production credential."""
    key = uid()
    if not db.get(BillingPlan, service):
        db.add(BillingPlan(id=service, name=service.title()))
    product = BillingPlan(id='pack-' + key, name='Page pack')
    db.add(product)
    db.flush()
    revision = BillingPlanRevision(plan_id=product.id, version=1, name='Page pack', monthly_redraw_pages=0,
        hourly_image_limit=hourly, service_plan_id=service, quota_pages=pages, trial_days=0, trial_redraw_pages=0)
    db.add(revision)
    db.flush()
    price = BillingPrice(plan_id=product.id, plan_revision_id=revision.id, environment='test', currency='usd',
        unit_amount=599, interval='once', status='active')
    db.add(price)
    db.flush()
    binding = BillingPriceBinding(price_id=price.id, provider='stripe', environment='test', product_id='prod_' + key,
        provider_price_id='price_' + key, status='active')
    db.add(binding)
    db.flush()
    order = BillingOrder(owner_id=owner, provider='stripe', environment='test', price_id=price.id,
        binding_id=binding.id, external_id='payment_' + key, kind='initial', status='paid', currency='usd',
        subtotal=599, total=599, paid_at=now())
    db.add(order)
    db.flush()
    period = QuotaPeriod(id=uid(), owner_id=owner, billing_order_id=order.id, mode='classic', kind='classic_purchase',
        source='purchase', source_key=f'purchase:{order.id}:classic', starts_at=start or now(), ends_at=end,
        granted=pages, used=0, reserved=0)
    db.add(period)
    db.flush()
    return period


@pytest.fixture
def account(cluster):
    client, _ = cluster
    auth = login(client)
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    high_control_budget()
    return client, auth, owner


def purchase(account, **values):
    with session_factory()() as db:
        period = seed_purchase(db, account[2], **values)
        db.commit()
        return period.id


def rights(account):
    result = account[0].get('/v1/me/entitlements', headers=account[1])
    assert result.status_code == 200, result.text
    return result.json()


def accept(account, key, **values):
    result = submit(account[0], account[1], manifest(1, key)[0], key=key, **values)
    assert result.status_code == 202, result.text
    row = request_record(account[0], account[1], key)
    with session_factory()() as db:
        return db.get(Job, row.job_id)


def test_purchase_preserves_free_identity_and_has_separate_permanent_balance(account):
    period_id = purchase(account, pages=5, hourly=12)
    value = rights(account)
    assert value['plan'] == 'free' and value['service_plan'] == 'lite'
    assert value['plus_started_at'] is value['plus_expires_at'] is None
    assert value['image_rate_limit'] == {'window_seconds': 60, 'limit': 100}
    assert value['hourly_image_rate_limit'] == {'window_seconds': 3600, 'limit': 12}
    assert value['purchase_quota'] == {'granted': 5, 'used': 0, 'reserved': 0, 'available': 5, 'next_expiry_at': None}
    classic = value['modes']['classic']
    assert not classic['unlimited'] and classic['quota_kind'] == 'classic_purchase'
    assert classic['quota']['available'] == 35 and all(p['source'] != 'purchase' for p in classic['quota']['buckets'])
    assert not value['modes']['redraw']['allowed']
    items = account[0].get('/v1/me/quota-purchases', headers=account[1]).json()
    assert items['next_cursor'] is None and items['items'][0]['id'] == period_id
    assert items['items'][0]['expires_at'] is None and items['items'][0]['state'] == 'active'


def test_purchases_are_spent_before_free_pages_and_earliest_expiry_wins(account):
    configure_system_limits(free_daily_pages=1)
    permanent = purchase(account, pages=1)
    late = purchase(account, pages=1, end=now() + timedelta(hours=2))
    early = purchase(account, pages=1, end=now() + timedelta(hours=1))
    at = now()
    purchase(account, pages=100, start=at - timedelta(days=2), end=at - timedelta(days=1))
    purchase(account, pages=100, start=at + timedelta(days=1), end=at + timedelta(days=2))
    jobs = [accept(account, str(index)) for index in range(4)]
    assert [job.quota_period_id for job in jobs[:3]] == [early, late, permanent]
    assert [job.entitlement['service_plan'] for job in jobs] == ['lite', 'lite', 'lite', 'free']
    assert jobs[-1].quota_kind == 'classic_daily'
    value = rights(account)
    assert value['plan'] == value['service_plan'] == 'free'
    assert value['image_rate_limit']['limit'] == 10
    assert value['purchase_quota']['reserved'] == 3 and value['purchase_quota']['available'] == 0


def test_purchase_expiry_hint_only_describes_remaining_available_pages(account):
    purchase(account, pages=1, end=now() + timedelta(hours=1))
    purchase(account, pages=2)
    assert rights(account)['purchase_quota']['next_expiry_at'] is not None
    accept(account, 'time-limited-first')
    remaining = rights(account)['purchase_quota']
    assert remaining['available'] == 2 and remaining['reserved'] == 1
    assert remaining['next_expiry_at'] is None


def test_concurrent_last_purchased_page_and_uuid_replay_are_exactly_once(account):
    configure_system_limits(free_daily_pages=0)
    period_id = purchase(account, pages=1)
    barrier = Barrier(4)
    def attempt(index):
        barrier.wait(timeout=10)
        response = submit(account[0], account[1], manifest(1, str(index))[0], key=str(index))
        return index, response.status_code, response.json()
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(attempt, range(4)))
    assert sorted(status for _, status, _ in results) == [202, 403, 403, 403]
    accepted = next(index for index, status, _ in results if status == 202)
    before = window_count('image')
    assert submit(account[0], account[1], manifest(1, str(accepted))[0], key=str(accepted)).status_code == 202
    assert window_count('image') == before
    with session_factory()() as db:
        period = db.get(QuotaPeriod, period_id)
        assert (period.used, period.reserved) == (0, 1)
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'reserve')) == 1


@pytest.mark.parametrize('invalidate', ['expire', 'revoke'])
@pytest.mark.parametrize('success', [False, True])
def test_settlement_always_uses_original_purchase_and_cannot_reactivate_revoked_balance(account, invalidate, success):
    at = now()
    first = purchase(account, pages=1, start=at - timedelta(days=2), end=at + timedelta(days=1))
    job = accept(account, 'old-purchase')
    later = purchase(account, pages=4)
    with session_factory()() as db:
        old = db.get(QuotaPeriod, first)
        if invalidate == 'expire':
            old.ends_at = now() - timedelta(seconds=1)
        else:
            old.revoked_at = now()
        db.commit()
    assert accept(account, 'new-purchase').quota_period_id == later
    with session_factory()() as db:
        entry = db.get(Job, job.id)
        entry.status = 'succeeded' if success else 'failed'
        settle(db, entry, success=success)
        settle(db, entry, success=success)
        db.commit()
        old, new = db.get(QuotaPeriod, first), db.get(QuotaPeriod, later)
        assert (old.used, old.reserved) == (int(success), 0)
        assert (new.used, new.reserved) == (0, 1)
        assert admission_policy(db, db.get(User, account[2])).period.id == later
    assert rights(account)['purchase_quota']['available'] == 3


def test_subscription_uses_no_purchase_and_original_expiry_keeps_running(account):
    period_id = purchase(account, pages=2, end=now() + timedelta(hours=1))
    login_plus(account[0])
    job = accept(account, 'subscribed')
    assert job.settlement == 'included' and job.quota_period_id is None
    value = rights(account)
    assert value['plan'] == value['service_plan'] == 'plus'
    assert value['modes']['classic']['quota'] is None and value['purchase_quota']['available'] == 2
    with session_factory()() as db:
        user, period = db.get(User, account[2]), db.get(QuotaPeriod, period_id)
        original_end = period.ends_at
        user.plus_expires_at = now() - timedelta(seconds=1)
        db.commit()
        assert period.ends_at == original_end and period.used == period.reserved == 0
    assert accept(account, 'after-subscription').quota_period_id == period_id


def test_independent_redraw_gift_does_not_inherit_purchase_service(account):
    period_id = purchase(account, pages=2, hourly=1)
    grant_redraw(account[0], account[1], 2)
    job = accept(account, 'redraw-gift', mode='redraw')
    assert job.quota_kind == 'redraw_grant' and job.entitlement['service_plan'] == 'free'
    assert job.entitlement['hourly_image_limit'] is None and job.entitlement['priority'] == 0
    assert window_count('image-hourly') == 0
    assert accept(account, 'classic-pack').quota_period_id == period_id
    assert window_count('image-hourly') == 1


def test_purchase_changes_share_account_rate_keys_and_do_not_reset_hour_window(account):
    purchase(account, pages=1, hourly=1)
    first = accept(account, 'first')
    purchase(account, pages=2, hourly=1)
    denied = submit(account[0], account[1], manifest(1, 'second')[0], key='second')
    assert denied.status_code == 429 and denied.json()['error']['window_seconds'] == 3600
    assert window_count('image-hourly') == 1 and window_count('image') == 1
    assert rights(account)['purchase_quota']['reserved'] == 1
    assert first.entitlement['hourly_image_limit'] == 1


def test_purchase_upgrade_does_not_reset_existing_free_minute_usage(account):
    configure_system_limits(free_images_per_minute=1, plus_images_per_minute=2)
    accept(account, 'free-counted')
    purchase(account, pages=2)
    accept(account, 'purchased-counted')
    denied = submit(account[0], account[1], manifest(1, 'third')[0], key='third')
    assert denied.status_code == 429
    assert window_count('image') == 2 and window_count('image-hourly') == 1
    assert rights(account)['purchase_quota']['available'] == 1


def test_last_reserved_page_retains_scheduler_priority_after_expiry(account):
    from app.queue_models import JobStage
    from app.scheduler import _candidate_rows
    free = accept(account, 'free-older')
    at = now()
    period_id = purchase(account, pages=1, start=at - timedelta(hours=1), end=at + timedelta(minutes=1))
    paid = accept(account, 'paid-last')
    assert rights(account)['service_plan'] == 'free'
    with session_factory()() as db:
        db.get(QuotaPeriod, period_id).ends_at = now() - timedelta(seconds=1)
        for index, job_id in enumerate((free.id, paid.id)):
            entry = db.get(Job, job_id)
            entry.status = 'validating_upload'
            db.add(JobStage(job_id=job_id, name='validate_upload', status='ready',
                available_at=at - timedelta(seconds=2 - index)))
        db.commit()
        node = SimpleNamespace(supported_languages=['zh-Hans'], runtime_report={})
        rows = _candidate_rows(db, node, {'validate_upload'}, now())
        assert [job.id for _, job in rows] == [paid.id, free.id]
        assert db.get(Job, paid.id).entitlement['priority'] == 1


def test_purchase_history_keyset_pagination_is_private_and_bounded(account):
    at = now() - timedelta(days=2)
    ids = [purchase(account, start=at) for _ in range(6)]
    with session_factory()() as db:
        db.get(QuotaPeriod, ids[0]).used = 3
        db.get(QuotaPeriod, ids[1]).revoked_at = now()
        db.get(QuotaPeriod, ids[2]).ends_at = now() - timedelta(days=1)
        db.commit()
    collected, cursor = [], None
    for _ in range(3):
        params = {'limit': 2, **({'cursor': cursor} if cursor else {})}
        response = account[0].get('/v1/me/quota-purchases', headers=account[1], params=params)
        assert response.status_code == 200, response.text
        result = response.json()
        collected.extend(result['items'])
        cursor = result['next_cursor']
    assert cursor is None and [row['id'] for row in collected] == sorted(ids, reverse=True)
    assert {row['state'] for row in collected} == {'active', 'exhausted', 'revoked', 'expired'}
    assert all(row['available'] == 0 for row in collected if row['state'] != 'active')
    other = login(account[0], 'other')
    assert account[0].get('/v1/me/quota-purchases', headers=other).json()['items'] == []
    assert account[0].get('/v1/me/quota-purchases', headers=other, params={'cursor': ids[0]}).status_code == 422
    assert account[0].get('/v1/me/quota-purchases', headers=account[1], params={'limit': 51}).status_code == 422


def test_model_selection_and_cache_identity_follow_actual_service_not_payment_product(admin_case):
    client, _ = admin_case
    auth = login(client)
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    with session_factory()() as db:
        first_bucket = seed_purchase(db, owner, pages=1)
        db.commit()
        first_bucket_id = first_bucket.id
    free = create(admin_case, {**body('Free', model='free-model'), 'text_plan_ids': ['free']})
    premium = create(admin_case, {**body('Lite', model='lite-model'), 'text_plan_ids': ['lite']})
    page = manifest(1)[0]
    assert client.get('/v1/capabilities', headers=auth).json()['modes'][0]['enabled']
    for key in ('paid', 'paid', 'free'):
        assert submit(client, auth, page, key=key).status_code == 202
    paid_id = request_record(client, auth, 'paid').job_id
    free_id = request_record(client, auth, 'free').job_id
    with session_factory()() as db:
        paid, ordinary = db.get(Job, paid_id), db.get(Job, free_id)
        assert paid.config['text']['provider_id'] == premium['id']
        assert ordinary.config['text']['provider_id'] == free['id']
        assert paid.cache_key != ordinary.cache_key
        assert paid.entitlement['plan'] == ordinary.entitlement['plan'] == 'free'
        assert paid.entitlement['service_plan'] == 'lite' and ordinary.entitlement['service_plan'] == 'free'
        next_bucket = seed_purchase(db, owner, pages=1)
        db.commit()
        next_bucket_id = next_bucket.id
    # Re-purchasing a different product with the same service does not change
    # the model cache identity or reserve another page for an existing job.
    assert submit(client, auth, page, key='replenished').status_code == 202
    assert request_record(client, auth, 'replenished').job_id == paid_id
    with session_factory()() as db:
        assert db.get(QuotaPeriod, first_bucket_id).reserved == 1
        assert db.get(QuotaPeriod, next_bucket_id).reserved == 0
        assert db.scalar(select(func.count()).select_from(Job)) == 2
    assert window_count('image') == 2


def test_same_model_reuse_survives_purchase_exhaustion_without_rebilling(account):
    purchase(account, pages=1)
    first = accept(account, 'shared-model')
    response = submit(account[0], account[1], manifest(1, 'shared-model')[0], key='free-same-model')
    assert response.status_code == 202
    assert request_record(account[0], account[1], 'free-same-model').job_id == first.id
    assert window_count('image') == 1
    value = rights(account)
    assert value['modes']['classic']['quota']['available'] == 30
    assert value['purchase_quota']['reserved'] == 1


def test_lite_paid_term_takes_precedence_over_purchase_hourly_terms(lite):
    from app.billing_models import BillingTerm
    account = lite['client'], lite['auth'], lite['owner']
    period_id = purchase(account, pages=2, hourly=1)
    job = accept(account, 'active-lite')
    assert job.settlement == 'included' and job.entitlement['service_plan'] == 'lite'
    assert job.entitlement['hourly_image_limit'] == 3
    with session_factory()() as db:
        assert db.get(QuotaPeriod, period_id).reserved == 0
        for term in db.scalars(select(BillingTerm).where(BillingTerm.owner_id == lite['owner'])):
            term.revoked_at = now()
        db.commit()
        policy = admission_policy(db, db.get(User, lite['owner']))
        assert policy.plan == 'free' and policy.period.id == period_id and policy.hourly_image_limit == 1
