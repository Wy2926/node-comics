from conftest import configure_system_limits
"""Temporary grants use the same atomic admission and original-bucket settlement."""
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import pytest
from sqlalchemy import func, select
from conftest import login, upload, png_variant
from test_membership import entitlement, finish, freeze, grant, submit

AT = datetime(2026, 9, 15, 8)


def gift(client, auth, *, mode='redraw', pages=2, key='gift', start=None, end=None, operator=None):
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    admin = operator or login(client, 'admin')
    body = {'mode': mode, 'pages': pages, 'expires_at': (end or AT + timedelta(hours=1)).isoformat() + 'Z',
            'note': 'isolated time-bounded grant'}
    if start:
        body['starts_at'] = start.isoformat() + 'Z'
    return client.post(f'/v1/admin/users/{owner}/quota-grants',
        headers={**admin, 'Idempotency-Key': key}, json=body)


@pytest.fixture(autouse=True)
def configured(client, monkeypatch):
    from app.config import settings
    settings().classic_enabled = True
    freeze(monkeypatch, AT)


def test_ordinary_redraw_gift_is_temporary_and_exhaustion_creates_no_job(client, png, monkeypatch):
    auth = login(client)
    assert not entitlement(client, auth)['modes']['redraw']['allowed']
    result = gift(client, auth, pages=1)
    assert result.status_code == 201, result.text
    rights = entitlement(client, auth)
    assert rights['plan'] == 'free' and rights['image_rate_limit']['limit'] == 10
    assert rights['modes']['redraw']['allowed'] and rights['modes']['redraw']['quota']['available'] == 1
    job = submit(client, auth, upload(client, auth, png), 'redraw').json()
    assert job['quota_kind'] == 'redraw_grant' and job['quota_period_id'] == result.json()['grant']['id']
    denied = submit(client, auth, upload(client, auth, png_variant(png, 2)), 'redraw', 'extra')
    assert denied.status_code == 403 and denied.json()['error']['code'] == 'REDRAW_QUOTA_EXHAUSTED'
    freeze(monkeypatch, AT + timedelta(hours=1))
    assert not entitlement(client, auth)['modes']['redraw']['allowed']
    assert submit(client, auth, job['input_asset_id'], 'redraw').json()['id'] == job['id']
    finish(job['id'])
    assert client.get('/v1/translations', headers=auth).json()['total'] == 1


@pytest.mark.parametrize('mode', ['classic', 'redraw'])
def test_scheduled_grant_starts_at_inclusive_boundary(client, monkeypatch, mode):
    auth = login(client)
    start = AT + timedelta(minutes=10)
    response = gift(client, auth, mode=mode, start=start)
    assert response.status_code == 201, response.text
    benefit = entitlement(client, auth)['modes'][mode]
    assert (benefit['quota']['available'] if benefit['quota'] else 0) == (30 if mode == 'classic' else 0)
    assert len(client.get('/v1/me/quota-grants', headers=auth).json()['items']) == 1
    freeze(monkeypatch, start)
    assert entitlement(client, auth)['modes'][mode]['quota']['available'] == (32 if mode == 'classic' else 2)


@pytest.mark.parametrize('success', [True, False])
def test_expired_gift_settles_only_original_bucket(client, png, monkeypatch, success):
    auth = login(client)
    first = gift(client, auth, pages=1).json()['grant']
    job = submit(client, auth, upload(client, auth, png), 'redraw').json()
    freeze(monkeypatch, AT + timedelta(hours=1))
    second = gift(client, auth, pages=4, key='later', end=AT + timedelta(hours=2)).json()['grant']
    assert entitlement(client, auth)['pending_previous_period_pages'] == 1
    finish(job['id'], success)
    finish(job['id'], success)
    assert entitlement(client, auth)['modes']['redraw']['quota']['available'] == 4
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    with session_factory()() as db:
        old = db.get(QuotaPeriod, first['id'])
        assert (old.used, old.reserved) == (int(success), 0)
        assert db.get(QuotaPeriod, second['id']).used == 0


def test_finite_allowances_use_earliest_expiry_and_plus_classic_uses_no_gift(client, png):
    from app.config import settings
    configure_system_limits(free_daily_pages=1)
    auth = login(client)
    late = gift(client, auth, mode='classic', pages=1, key='late', end=AT + timedelta(days=2)).json()['grant']
    early = gift(client, auth, mode='classic', pages=1, key='early').json()['grant']
    assert entitlement(client, auth)['modes']['classic']['quota']['available'] == 3
    jobs = [submit(client, auth, upload(client, auth, png_variant(png, n)), key=str(n)).json() for n in range(3)]
    assert [job['quota_kind'] for job in jobs] == ['classic_grant', 'classic_daily', 'classic_grant']
    assert [jobs[0]['quota_period_id'], jobs[2]['quota_period_id']] == [early['id'], late['id']]
    assert grant(client, auth).status_code == 200
    included = submit(client, auth, upload(client, auth, png_variant(png, 7)), key='plus').json()
    assert included['settlement'] == 'included' and included['quota_period_id'] is None
    buckets = client.get('/v1/me/quota-grants', headers=auth).json()['items']
    assert sum(item['reserved'] for item in buckets) == 2


def test_grants_are_private_idempotent_and_audited_even_after_expiry(client, monkeypatch):
    auth, other = login(client), login(client, 'bob')
    assert gift(client, auth, operator=auth).status_code == 403
    first = gift(client, auth)
    assert gift(client, auth).json() == first.json()
    assert gift(client, auth, pages=3).status_code == 409
    assert gift(client, other).status_code == 409
    assert client.get('/v1/me/quota-grants', headers=other).json()['items'] == []
    second = gift(client, auth, key='another')
    assert second.status_code == 201 and second.json()['grant']['id'] != first.json()['grant']['id']
    freeze(monkeypatch, AT + timedelta(days=1))
    assert gift(client, auth).json() == first.json()
    assert gift(client, auth, key='expired-new').status_code == 422
    from app.db import session_factory
    from app.models import Ledger
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'grant')) == 2


def test_simultaneous_last_gift_and_daily_page_admissions(client, png):
    from app.config import settings
    configure_system_limits(free_daily_pages=1)
    auth = login(client)
    gift(client, auth, mode='classic', pages=1)
    assets = [upload(client, auth, png_variant(png, n)) for n in range(4)]
    barrier = Barrier(4)
    def attempt(n):
        barrier.wait(timeout=10)
        return submit(client, auth, assets[n], key=str(n)).status_code
    with ThreadPoolExecutor(4) as pool:
        assert sorted(pool.map(attempt, range(4))) == [202, 202, 403, 403]
    assert entitlement(client, auth)['modes']['classic']['quota']['reserved'] == 2
