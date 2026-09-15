from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import pytest
from sqlalchemy import func, select
from conftest import login, upload, png_variant, submit_asset


def entitlement(client, auth):
    response = client.get('/v1/me/entitlements', headers=auth)
    assert response.status_code == 200, response.text
    return response.json()


def grant(client, auth, *, months=1, pages=None, key='open-plus'):
    user_id = client.get('/v1/me', headers=auth).json()['user']['id']
    admin = login(client, 'admin')
    return client.post(f'/v1/admin/users/{user_id}/membership',
        headers={**admin, 'Idempotency-Key': key},
        json={'months': months, 'monthly_pages': pages, 'note': 'isolated membership test'})


def submit(client, auth, asset, mode='classic', key='new-page', **fields):
    import httpx
    response = submit_asset(client, auth, asset, key=f'{mode}:{key}', mode=mode, **fields)
    return httpx.Response(response.status_code, json=response.json()['items'][0]['job'] if response.status_code == 202 else response.json())


def submit_many(client, auth, assets, mode='classic', key='manifest', maximum=None):
    from app.db import session_factory
    from app.models import Asset
    with session_factory()() as db:
        items = [{'client_item_id': str(n), 'asset_id': asset.id, 'image_sha256': asset.sha256,
                  'byte_size': asset.byte_size, 'content_type': asset.mime}
                 for n, asset_id in enumerate(assets) for asset in [db.get(Asset, asset_id)]]
    return client.post('/v1/translation-submissions', headers={**auth, 'Idempotency-Key':key},
                       json={'items':items,'mode':mode,'target_language':'zh-Hans','max_quota_pages':len(items) if maximum is None else maximum})


def finish(job_id, success=True):
    from app.db import session_factory
    from app.jobs import owned_job, settle
    from app.models import Job
    with session_factory()() as db:
        job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
        job.status = 'succeeded' if success else 'failed'
        settle(db, job, success=success)
        db.commit()


@pytest.fixture(autouse=True)
def classic_settings(client):
    from app.config import settings
    settings().classic_enabled = True


def test_defaults_and_admin_role_do_not_grant_plus(client):
    for name in ('alice', 'admin'):
        rights = entitlement(client, login(client, name))
        assert rights['plan'] == 'free'
        assert rights['realtime_slots'] == 2 and rights['queue_capacity'] == 10
        assert rights['modes']['classic']['quota']['available'] == 100
        assert rights['modes']['redraw']['allowed'] is False
        assert rights['modes']['redraw']['quota'] is None


def test_free_cannot_create_redraw_submission_or_reserve_capacity(client, png):
    auth = login(client)
    asset = upload(client, auth, png)
    response = submit(client, auth, asset, 'redraw')
    assert response.status_code == 403 and response.json()['error']['code'] == 'PLUS_REQUIRED'
    from app.db import session_factory
    from app.models import Job
    from app.queue_models import Submission
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 0
        assert db.scalar(select(func.count()).select_from(Submission)) == 0
    assert all(q['in_flight'] == 0 for q in client.get('/v1/me/queues',headers=auth).json()['items'])


def test_plus_unlimited_and_monthly_300_and_idempotent_renewal(client, png):
    auth = login(client)
    first = grant(client, auth, months=12)
    assert first.status_code == 200, first.text
    rights = entitlement(client, auth)
    assert rights['plan'] == 'plus' and rights['modes']['classic']['unlimited']
    assert rights['queue_capacity'] == 500 and rights['realtime_slots'] == 10
    assert rights['modes']['classic']['quota'] is None
    assert rights['modes']['redraw']['quota']['granted'] == 300
    assert grant(client, auth, months=12).json() == first.json()
    asset = upload(client, auth, png)
    job = submit(client, auth, asset).json()
    assert job['quota_pages'] == 0 and job['settlement'] == 'included'
    assert entitlement(client, auth)['modes']['redraw']['quota']['available'] == 300
    redraw = submit(client, auth, asset, 'redraw').json()
    assert redraw['quota_pages'] == 1
    assert entitlement(client, auth)['modes']['redraw']['quota']['available'] == 299
    finish(redraw['id'])
    finish(redraw['id'])
    assert entitlement(client, auth)['modes']['redraw']['quota']['used'] == 1


@pytest.mark.parametrize('mode', ['classic', 'redraw'])
def test_period_quota_limit_reservations_and_release(client, png, mode):
    from app.config import settings
    settings().free_daily_pages = 1
    auth = login(client)
    if mode == 'redraw':
        assert grant(client, auth, pages=1).status_code == 200
    first_asset = upload(client, auth, png)
    second_asset = upload(client, auth, png_variant(png, 9))
    first = submit(client, auth, first_asset, mode).json()
    assert submit(client, auth, first_asset, mode, 'another-device').json()['id'] == first['id']
    rejection = submit(client, auth, second_asset, mode, 'second')
    assert rejection.status_code == 409 and 'resets_at' in rejection.json()['error']
    finish(first['id'], False)
    assert entitlement(client, auth)['modes'][mode]['quota']['available'] == 1
    assert submit(client, auth, second_asset, mode, 'second').status_code == 202


def freeze(monkeypatch, at):
    from app import entitlements, jobs, quota_grants
    monkeypatch.setattr(entitlements, 'now', lambda: at)
    monkeypatch.setattr(jobs, 'now', lambda: at)
    monkeypatch.setattr(quota_grants, 'now', lambda: at)


@pytest.mark.parametrize('success', [True, False])
def test_old_day_settlement_never_changes_new_day(client, png, monkeypatch, success):
    freeze(monkeypatch, datetime(2026, 9, 15, 15, 59, 59))
    auth = login(client)
    first = submit(client, auth, upload(client, auth, png)).json()
    old_period = first['quota_period_id']
    freeze(monkeypatch, datetime(2026, 9, 15, 16, 0, 0))
    rights = entitlement(client, auth)
    assert rights['modes']['classic']['quota']['id'] != old_period
    assert rights['pending_previous_period_pages'] == 1
    finish(first['id'], success)
    assert entitlement(client, auth)['modes']['classic']['quota']['available'] == 100
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    with session_factory()() as db:
        period = db.get(QuotaPeriod, old_period)
        assert period.used == int(success) and period.reserved == 0


def test_month_end_anchor_and_yearly_monthly_allowance(client, png, monkeypatch):
    freeze(monkeypatch, datetime(2026, 1, 31, 2, 0, 0))
    auth = login(client)
    assert grant(client, auth, months=12).status_code == 200
    job = submit(client, auth, upload(client, auth, png), 'redraw').json()
    first = entitlement(client, auth)['modes']['redraw']['quota']
    assert first['resets_at'] == '2026-02-28T02:00:00Z'
    freeze(monkeypatch, datetime(2026, 2, 28, 2, 0, 0))
    second = entitlement(client, auth)['modes']['redraw']['quota']
    assert second['resets_at'] == '2026-03-31T02:00:00Z' and second['available'] == 300
    finish(job['id'])
    assert entitlement(client, auth)['modes']['redraw']['quota']['available'] == 300


def test_expiry_honors_accepted_job_and_rejects_new_work(client, png, monkeypatch):
    start = datetime(2026, 1, 10, 3)
    freeze(monkeypatch, start)
    auth = login(client)
    grant(client, auth)
    asset = upload(client, auth, png)
    job = submit(client, auth, asset, 'redraw').json()
    freeze(monkeypatch, datetime(2026, 2, 10, 3))
    assert entitlement(client, auth)['plan'] == 'free'
    assert submit(client, auth, upload(client, auth, png_variant(png, 7)), 'redraw', 'after-expiry').status_code == 403
    # Replaying an accepted operation remains legal after expiration.
    assert submit(client, auth, asset, 'redraw').json()['id'] == job['id']
    finish(job['id'])
    assert entitlement(client, auth)['modes']['classic']['quota']['available'] == 100


def test_submission_rolls_back_all_pages_when_period_allowance_is_insufficient(client, png):
    from app.config import settings
    settings().free_daily_pages = 1
    auth = login(client)
    assets = [upload(client, auth, png_variant(png, i)) for i in (1, 2)]
    response = submit_many(client, auth, assets, maximum=2)
    assert response.status_code == 409
    assert entitlement(client, auth)['modes']['classic']['quota']['reserved'] == 0
    assert client.get('/v1/jobs', headers=auth).json()['total'] == 0


def test_membership_and_compensation_are_private_and_idempotent(client):
    auth = login(client)
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    path = f'/v1/admin/users/{owner}/membership'
    assert client.post(path, headers={**auth, 'Idempotency-Key': 'attack'}, json={'note': 'attack'}).status_code == 403
    assert grant(client, auth).status_code == 200
    assert grant(client, auth, months=2).status_code == 409
    admin = login(client, 'admin')
    path = f'/v1/admin/users/{owner}/quota-compensations'
    data = {'kind': 'redraw_monthly', 'pages': 7, 'note': 'service compensation'}
    headers = {**admin, 'Idempotency-Key': 'compensate-once'}
    assert client.post(path, headers=headers, json=data).status_code == 200
    assert client.post(path, headers=headers, json=data).status_code == 200
    assert entitlement(client, auth)['modes']['redraw']['quota']['available'] == 307
    queues = client.get('/v1/me/queues', headers=auth).json()['items']
    assert len(queues) == 2 and all(queue['capacity'] == 500 and queue['realtime_limit'] == 10 for queue in queues)


def test_simultaneous_last_page_admission(client, png):
    from app.config import settings
    settings().free_daily_pages = 1
    auth = login(client)
    assets = [upload(client, auth, png_variant(png, n)) for n in (3, 4)]
    barrier = Barrier(2)
    def attempt(n):
        barrier.wait(timeout=10)
        return submit(client, auth, assets[n], key=f'concurrent-{n}').status_code
    with ThreadPoolExecutor(2) as pool:
        codes = list(pool.map(attempt, range(2)))
    assert sorted(codes) == [202, 409]
    assert entitlement(client, auth)['modes']['classic']['quota']['reserved'] == 1
