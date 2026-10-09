"""Hourly membership admission, replay, rollback and expiry without upstream calls."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
import pytest
from sqlalchemy import func, select, text
from admission_test_utils import freeze_clock, window_count
from conftest import configure_system_limits, login, request_record
from test_billing_catalog import at_rights, select_quote
from test_stripe_billing import billing, complete_trial, invoice, periods, rights
from test_cluster_submissions import grant_free, manifest, submit
from test_translation_requests import high_control_budget


@pytest.fixture
def lite(billing):
    from app.config import settings
    settings().classic_enabled = True
    select_quote(billing, key='lite-month', plan='lite', pages=None, amount=599, interval='month',
        trial_days=7, trial_pages=None, hourly_image_limit=3)
    complete_trial(billing)
    high_control_budget()
    return billing


def test_lite_seven_day_unlimited_trial_and_paid_version(lite):
    from app.billing_sync import sync_subscription
    from app.billing_grants import timestamp
    value = rights(lite)
    assert value['plan'] == 'lite'
    assert value['image_rate_limit'] == {'window_seconds': 60, 'limit': 100}
    assert value['hourly_image_rate_limit'] == {'window_seconds': 3600, 'limit': 3}
    assert value['modes']['classic']['unlimited']
    assert value['modes']['classic']['allowed']
    assert not periods()
    response = submit(lite['client'], lite['auth'], manifest(1)[0], mode='removed-mode')
    assert response.status_code == 422
    assert window_count('image-hourly') == window_count('image') == 0
    offer = next(p for p in lite['client'].get('/v1/billing/catalog').json()['offers'] if p['plan_id'] == 'lite')
    assert (offer['unit_amount'], offer['trial_days'], offer['trial_classic_pages'], offer['hourly_image_limit']) == (599, 7, None, 3)
    invoice(lite, total=599)
    sync_subscription('sub_fixture')
    assert rights(lite)['plan'] == 'lite' and not periods()
    assert lite['client'].get('/v1/billing/status', headers=lite['auth']).json()['subscription']['price']['plan_id'] == 'lite'
    # A new catalog version does not change an already granted term.
    select_quote(lite, key='lite-next', plan='lite', pages=None, amount=599, interval='month',
        trial_days=7, trial_pages=None, hourly_image_limit=12)
    assert rights(lite)['hourly_image_rate_limit']['limit'] == 3
    assert at_rights(lite, timestamp(lite['at']) + timedelta(days=30))['plan'] == 'free'


def test_annual_lite_grants_full_year_without_finite_buckets(billing):
    from app.billing_sync import sync_subscription
    from app.billing_grants import timestamp
    select_quote(billing, key='lite-year', plan='lite', pages=None, amount=5999, interval='year',
        trial_days=7, trial_pages=None, hourly_image_limit=1200)
    complete_trial(billing)
    invoice(billing, end=billing['at'] + 365 * 86400, total=5999)
    sync_subscription('sub_fixture')
    sync_subscription('sub_fixture')
    assert rights(billing)['hourly_image_rate_limit'] == {'window_seconds': 3600, 'limit': 1200}
    assert at_rights(billing, timestamp(billing['at']) + timedelta(days=364))['plan'] == 'lite'
    assert at_rights(billing, timestamp(billing['at']) + timedelta(days=365))['plan'] == 'free'
    assert not periods()


@pytest.mark.parametrize('gift_pages,expected', [(1, 'lite'), (None, 'plus')])
def test_monitor_and_account_choose_same_overlapping_unlimited_benefit(lite, gift_pages, expected):
    from app.billing_access import plan_expression
    from app.db import session_factory
    from app.entitlements import membership_benefits
    from app.models import User, now, uid
    with session_factory()() as db:
        user = db.get(User, lite['owner'])
        user.membership_id = uid()
        user.plus_started_at, user.plus_expires_at = now() - timedelta(days=1), now() + timedelta(days=1)
        user.plus_monthly_pages = gift_pages
        db.commit()
        assert membership_benefits(db, user)['plan'] == expected
        assert db.scalar(select(plan_expression(now())).select_from(User).where(User.id == user.id)) == expected


def test_admin_monitor_identifies_and_filters_effective_lite_plan(lite):
    from conftest import login_plus
    client, auth = lite['client'], lite['auth']
    response = client.get('/v1/admin/monitor/users', headers=auth, params={'plan': 'lite'})
    assert response.status_code == 200
    assert [(u['id'], u['plan']) for u in response.json()['items']] == [(lite['owner'], 'lite')]
    overview = client.get('/v1/admin/monitor/overview', headers=auth)
    assert overview.status_code == 200 and overview.json()['users']['plus'] == 0
    login_plus(client, 'buyer')
    assert rights(lite)['plan'] == 'plus' and rights(lite)['hourly_image_rate_limit'] is None
    assert client.get('/v1/admin/monitor/users', headers=auth, params={'plan': 'lite'}).json()['total'] == 0
    assert client.get('/v1/admin/monitor/users', headers=auth, params={'plan': 'plus'}).json()['total'] == 1
    assert client.get('/v1/admin/monitor/overview', headers=auth).json()['users']['plus'] == 1


def test_rolling_hour_counts_new_jobs_across_modes_languages_and_devices(lite, monkeypatch):
    from app.models import now
    client, auth = lite['client'], lite['auth']
    assert rights(lite)['modes']['classic']['allowed']  # Independent gifts retain their access.
    clock = [now()]
    freeze_clock(monkeypatch, clock)
    first = submit(client, auth, manifest(1, 'first')[0], key='first')
    assert first.status_code == 202
    assert submit(client, auth, manifest(1, 'first')[0], key='first').status_code == 202
    assert submit(client, auth, manifest(1, 'first')[0], key='another-device').status_code == 202
    assert window_count('image-hourly') == 1
    clock[0] += timedelta(seconds=61)
    assert submit(client, auth, manifest(1, 'second')[0], key='second', mode='classic').status_code == 202
    assert submit(client, auth, manifest(1, 'third')[0], key='third', target_language='en').status_code == 202
    denied = submit(client, auth, manifest(1, 'fourth')[0], key='fourth')
    assert denied.status_code == 429 and denied.json()['error']['window_seconds'] == 3600
    assert denied.headers['Retry-After'] == '3539'
    assert window_count('image-hourly') == 3 and window_count('image') == 2
    # Cancellation is execution failure after committed admission, not a refund.
    assert client.post('/v1/translations/' + first.json()['id'] + '/cancel', headers=auth).status_code == 200
    assert window_count('image-hourly') == 3
    clock[0] += timedelta(seconds=3538, milliseconds=999)
    assert submit(client, auth, manifest(1, 'fourth')[0], key='fourth').headers['Retry-After'] == '1'
    clock[0] += timedelta(milliseconds=1)
    assert submit(client, auth, manifest(1, 'fourth')[0], key='fourth').status_code == 202
    assert window_count('image-hourly') == 3


def test_hourly_concurrent_last_slot_and_owner_isolation(lite):
    client, auth = lite['client'], lite['auth']
    for index in range(2):
        assert submit(client, auth, manifest(1, str(index))[0], key=str(index)).status_code == 202
    barrier = Barrier(12)
    def attempt(index):
        barrier.wait(timeout=10)
        return submit(client, auth, manifest(1, f'parallel-{index}')[0], key=f'parallel-{index}').status_code
    with ThreadPoolExecutor(12) as pool:
        statuses = list(pool.map(attempt, range(12)))
    assert statuses.count(202) == 1 and statuses.count(429) == 11
    assert window_count('image-hourly', lite['owner']) == 3
    configure_system_limits(free_daily_pages=1)
    other = login(client, 'other-owner')
    assert submit(client, other, manifest(1, 'other')[0], key='parallel-0').status_code == 202
    assert window_count('image-hourly', lite['owner']) == 3


def test_database_rollback_and_minute_rejection_release_hourly_reservation(lite, monkeypatch):
    from app import translation_api
    client, auth = lite['client'], lite['auth']
    actual = translation_api.create_job
    def fail_after_reservation(*args, **kwargs):
        actual(*args, **kwargs)
        raise RuntimeError('isolated hourly rollback')
    monkeypatch.setattr(translation_api, 'create_job', fail_after_reservation)
    with pytest.raises(RuntimeError, match='isolated hourly rollback'):
        submit(client, auth, manifest(1)[0])
    assert window_count('image-hourly') == 0
    assert window_count('image') == 1  # Existing conservative minute semantics.
    assert request_record(client, auth, 'operation-1') is None
    monkeypatch.setattr(translation_api, 'create_job', actual)
    configure_system_limits(plus_images_per_minute=1)
    assert submit(client, auth, manifest(1)[0]).status_code == 429
    assert window_count('image-hourly') == 0


def test_quota_rejection_releases_only_its_hourly_reservation(lite):
    client, auth = lite['client'], lite['auth']
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.models import uid, now
    from app.billing_models import BillingPlanRevision, BillingTerm, BillingPrice
    with session_factory()() as db:
        term = db.scalar(select(BillingTerm).where(BillingTerm.owner_id == lite['owner']))
        revision = db.get(BillingPlanRevision, db.get(BillingPrice, term.price_id).plan_revision_id)
        revision.trial_classic_pages = 1
        db.add(QuotaPeriod(id=uid(), owner_id=lite['owner'], kind='classic_monthly', mode='classic',
            source='subscription', source_key='isolated-one-page', billing_term_id=term.id,
            starts_at=term.starts_at, ends_at=term.ends_at, granted=1))
        db.commit()
    assert submit(client, auth, manifest(1, 'granted')[0], mode='classic').status_code == 202
    rejected = submit(client, auth, manifest(1, 'no-quota')[0], key='no-quota', mode='classic')
    assert rejected.status_code == 403 and rejected.json()['error']['code'] == 'DAILY_QUOTA_EXHAUSTED'
    assert window_count('image-hourly') == 1
    assert request_record(client, auth, 'no-quota') is None


def test_result_reuse_and_sql_session_savepoints_keep_only_committed_admissions(lite):
    from app.db import session_factory
    from app.models import Job, User, now
    from app.jobs import create_job
    client, auth = lite['client'], lite['auth']
    first = submit(client, auth, manifest(1)[0]).json()
    record = request_record(client, auth, first['id'])
    with session_factory()() as db:
        job = db.get(Job, record.job_id)
        job.status, job.phase, job.completed_at = 'no_text', 'completed', now()
        db.commit()
    assert submit(client, auth, manifest(1)[0], key='result-replay').status_code == 200
    assert window_count('image-hourly') == 1
    with session_factory()() as db:
        user = db.get(User, lite['owner'])
        db.execute(text('UPDATE users SET name = name WHERE id = :id'), {'id': user.id})
        with db.begin_nested():
            create_job(db, user, None, 'classic', 'en', 'savepoint-accepted', source_sha256='a' * 64)
        try:
            with db.begin_nested():
                create_job(db, user, None, 'classic', 'en', 'savepoint-rejected', source_sha256='b' * 64)
                raise ValueError('reject one page')
        except ValueError:
            pass
        assert window_count('image-hourly') == 2
        db.rollback()
    assert window_count('image-hourly') == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
    with session_factory()() as db:
        create_job(db, db.get(User, lite['owner']), None, 'classic', 'en', 'session-close', source_sha256='c' * 64)
        assert window_count('image-hourly') == 2
    assert window_count('image-hourly') == 1


@pytest.mark.parametrize('value', [0, -1, True, 1_000_001])
def test_hourly_revision_limits_reject_invalid_values(lite, value):
    response = lite['client'].post('/v1/admin/billing/products/lite/revisions', headers=lite['auth'], json={
        'id': 'invalid-hourly', 'name': 'Lite', 'monthly_classic_pages': 0,
        'trial_days': 7, 'trial_classic_pages': 0, 'hourly_image_limit': value})
    assert response.status_code == 422
