"""Operator gifts accept exact days without resetting an existing quota cycle."""
from datetime import datetime, timedelta
import pytest
from sqlalchemy import func, select
from conftest import login, upload
from test_membership import entitlement, freeze, submit


def issue(client, auth, body, key='gift-days', operator=None):
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    return client.post(f'/v1/admin/users/{owner}/membership',
        headers={**(operator or login(client, 'admin')), 'Idempotency-Key': key},
        json={'note': 'isolated admin gift', **body})


def test_exact_days_replay_and_extension_preserve_short_period(client, png, monkeypatch):
    at = datetime(2026, 1, 31, 8)
    freeze(monkeypatch, at)
    auth = login(client)
    first = issue(client, auth, {'days': 7, 'monthly_pages': 30})
    assert first.status_code == 200, first.text
    assert first.json()['entitlements']['plus_expires_at'] == '2026-02-07T08:00:00Z'
    job = submit(client, auth, upload(client, auth, png), 'redraw').json()
    before = entitlement(client, auth)['modes']['redraw']['quota']
    assert before['reserved'] == 1 and before['granted'] == 30
    freeze(monkeypatch, at + timedelta(days=1))
    renewed = issue(client, auth, {'days': 30}, 'extend-days')
    assert renewed.status_code == 200, renewed.text
    assert renewed.json()['entitlements']['plus_expires_at'] == '2026-03-09T08:00:00Z'
    after = entitlement(client, auth)['modes']['redraw']['quota']
    assert after['id'] == before['id'] == job['quota_period_id']
    assert after['granted'] == 30 and after['reserved'] == 1
    assert after['resets_at'] == '2026-03-02T08:00:00Z'
    assert issue(client, auth, {'days': 30}, 'extend-days').json() == renewed.json()
    assert issue(client, auth, {'days': 31}, 'extend-days').status_code == 409
    # Replaying an earlier gift returns its original receipt and never shortens the account.
    assert issue(client, auth, {'days': 7, 'monthly_pages': 30}).json() == first.json()
    assert entitlement(client, auth)['plus_expires_at'] == '2026-03-09T08:00:00Z'


@pytest.mark.parametrize('body', [{'days': 0}, {'days': 3661}, {'days': 1.5}, {'days': True}, {'days': 7, 'months': 1}])
def test_invalid_duration_is_rejected_without_membership(client, body):
    auth = login(client)
    assert issue(client, auth, body).status_code == 422
    assert entitlement(client, auth)['plan'] == 'free'


def test_gift_requires_admin_and_can_exclude_redraw(client):
    auth = login(client)
    assert issue(client, auth, {'days': 7}, operator=auth).status_code == 403
    assert issue(client, auth, {'days': 7, 'monthly_pages': 0}).status_code == 200
    rights = entitlement(client, auth)
    assert rights['modes']['classic']['unlimited']
    assert rights['modes']['redraw']['quota']['available'] == 0


@pytest.mark.parametrize('mode', ['redraw', 'classic'])
def test_new_requests_use_server_membership_after_upgrade(client, png, mode):
    from app.config import settings
    settings().classic_enabled = True
    from conftest import submit_asset
    from app.db import session_factory
    from app.models import Job
    auth = login(client)
    asset = upload(client, auth, png)
    assert issue(client, auth, {'days':30}).status_code == 200
    result = submit_asset(client, auth, asset, mode=mode)
    assert result.status_code == 202 and result.json()['state'] == 'queued'
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1


def test_admin_detail_shows_scheduled_grants_without_affecting_current_entitlement(client):
    from app.db import session_factory
    from app.entitlement_models import MembershipOperation, QuotaPeriod
    from app.models import now
    auth, admin = login(client), login(client, 'admin')
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    route = f'/v1/admin/users/{owner}/quota-grants'
    payload = {'mode': 'redraw', 'pages': 25, 'starts_at': (now()+timedelta(days=1)).isoformat()+'Z',
        'expires_at': (now()+timedelta(days=3)).isoformat()+'Z', 'note': 'future gift'}
    headers = {**admin, 'Idempotency-Key': 'scheduled-admin-gift'}
    first = client.post(route, headers=headers, json=payload)
    assert first.status_code == 201
    assert client.post(route, headers=headers, json=payload).json() == first.json()
    detail_route = f'/v1/admin/monitor/users/{owner}'
    assert client.get(detail_route, headers=auth).status_code == 403
    data = client.get(detail_route, headers=admin).json()
    assert data['grants'][0]['note'] == 'future gift'
    assert data['grants'][0]['granted'] == 25
    assert not data['entitlements']['modes']['redraw']['allowed']
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(MembershipOperation)) == 1
        assert db.scalar(select(func.count()).select_from(QuotaPeriod)) == 1


@pytest.mark.parametrize('days', [30, 60])
def test_gift_duration_has_exactly_thirty_day_allowance_periods(client, monkeypatch, days):
    at = datetime(2026, 2, 1, 8)
    freeze(monkeypatch, at)
    auth = login(client)
    assert issue(client, auth, {'days': days}).status_code == 200
    first = entitlement(client, auth)
    assert first['gift'] == {'starts_at': '2026-02-01T08:00:00Z',
        'ends_at': (at + timedelta(days=days)).isoformat() + 'Z', 'days': days, 'state': 'active'}
    assert first['modes']['redraw']['quota']['resets_at'] == '2026-03-03T08:00:00Z'
    freeze(monkeypatch, at + timedelta(days=30))
    second = entitlement(client, auth)
    assert second['plan'] == ('plus' if days == 60 else 'free')
    if days == 60:
        assert second['modes']['redraw']['quota']['granted'] == 300
        assert second['modes']['redraw']['quota']['resets_at'] == '2026-04-02T08:00:00Z'
    freeze(monkeypatch, at + timedelta(days=days))
    assert entitlement(client, auth)['gift']['state'] == 'expired'


def test_pending_gift_is_not_access_and_activation_preserves_bucket_identity(client, monkeypatch):
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.entitlements import activate_gift
    from app.models import User
    at = datetime(2026, 2, 1, 8)
    freeze(monkeypatch, at)
    auth, admin = login(client), login(client, 'admin')
    assert issue(client, auth, {'days': 30}).status_code == 200
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    with session_factory()() as db:
        user = db.get(User, owner)
        user.plus_pending = True
        period = db.scalar(select(QuotaPeriod).where(QuotaPeriod.owner_id == owner))
        period_id = period.id
        db.commit()
    rights = entitlement(client, auth)
    assert rights['gift']['state'] == 'pending' and rights['plan'] == 'free'
    assert rights['plus_expires_at'] is None and not rights['modes']['redraw']['allowed']
    assert client.get('/v1/admin/monitor/overview', headers=admin).json()['users']['plus'] == 0
    assert client.get('/v1/admin/monitor/users?plan=plus', headers=admin).json()['total'] == 0
    with session_factory()() as db:
        user = db.get(User, owner)
        activate_gift(db, user, at + timedelta(days=5))
        db.commit()
        period = db.get(QuotaPeriod, period_id)
        assert period.starts_at == at + timedelta(days=5)
        assert period.ends_at == at + timedelta(days=35)
        assert (period.used, period.reserved) == (0, 0)
    scheduled = entitlement(client, auth)
    assert scheduled['gift']['state'] == 'scheduled' and scheduled['plan'] == 'free'
    freeze(monkeypatch, at + timedelta(days=5))
    assert entitlement(client, auth)['modes']['redraw']['quota']['id'] == period_id


def test_future_gift_extension_and_expiry_preserve_a_single_segment(client, monkeypatch):
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.entitlements import activate_gift
    from app.models import User
    at = datetime(2026, 2, 1, 8)
    freeze(monkeypatch, at)
    auth = login(client)
    assert issue(client, auth, {'days': 30}).status_code == 200
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    with session_factory()() as db:
        user = db.get(User, owner)
        membership_id = user.membership_id
        activate_gift(db, user, at + timedelta(days=10))
        db.commit()
    extended = issue(client, auth, {'months': 1}, 'extend-future')
    assert extended.status_code == 200, extended.text
    assert extended.json()['entitlements']['gift']['days'] == 60
    assert extended.json()['entitlements']['gift']['state'] == 'scheduled'
    with session_factory()() as db:
        assert db.get(User, owner).membership_id == membership_id
        assert db.scalar(select(func.count()).select_from(QuotaPeriod).where(QuotaPeriod.owner_id == owner)) == 1
    expired = issue(client, auth, {'action': 'expire'}, 'expire-future')
    assert expired.status_code == 200, expired.text
    rights = entitlement(client, auth)
    assert rights['gift']['state'] == 'expired' and rights['plan'] == 'free'
    with session_factory()() as db:
        assert all(row.starts_at < row.ends_at for row in db.scalars(select(QuotaPeriod)))


@pytest.mark.parametrize('field', ['used', 'reserved'])
def test_gift_activation_cannot_move_consumed_or_reserved_bucket(client, monkeypatch, field):
    from fastapi import HTTPException
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.entitlements import activate_gift
    from app.models import User
    at = datetime(2026, 2, 1, 8)
    freeze(monkeypatch, at)
    auth = login(client)
    assert issue(client, auth, {'days': 30}).status_code == 200
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    with session_factory()() as db:
        user = db.get(User, owner)
        user.plus_pending = True
        period = db.scalar(select(QuotaPeriod).where(QuotaPeriod.owner_id == owner))
        setattr(period, field, 1)
        db.flush()
        with pytest.raises(HTTPException) as error:
            activate_gift(db, user, at + timedelta(days=1))
        assert error.value.detail['code'] == 'MEMBERSHIP_ALREADY_ACTIVE'
        assert period.starts_at == at and getattr(period, field) == 1


def test_plus_dates_merge_only_continuous_confirmed_gift(monkeypatch):
    from types import SimpleNamespace
    from app import entitlements
    at = datetime(2026, 2, 1, 8)
    paid_end = at + timedelta(days=15)
    user = SimpleNamespace(id='reader', plus_pending=False, plus_started_at=paid_end,
                           plus_expires_at=paid_end + timedelta(days=30))
    monkeypatch.setattr(entitlements, 'active_terms', lambda *args: [SimpleNamespace(starts_at=at, ends_at=paid_end)])
    assert entitlements.plus_dates(None, user, at) == (at, user.plus_expires_at)
    user.plus_pending = True
    assert entitlements.plus_dates(None, user, at) == (at, paid_end)
    user.plus_pending = False
    user.plus_started_at += timedelta(days=1)
    assert entitlements.plus_dates(None, user, at) == (at, paid_end)


def test_existing_calendar_gift_keeps_bucket_and_settlement_on_extension(client, png, monkeypatch):
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.entitlements import MONTHLY, iso
    from app.models import User
    from app.providers import digest
    from test_membership import finish
    at = datetime(2026, 1, 31, 8)
    freeze(monkeypatch, at)
    auth = login(client)
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    period_id = digest([owner, MONTHLY, iso(at)])
    with session_factory()() as db:
        user = db.get(User, owner)
        user.membership_id, user.plus_timezone = 'existing-calendar-gift', 'Asia/Shanghai'
        user.plus_started_at, user.plus_expires_at = at, at + timedelta(days=7)
        user.plus_monthly_pages = 300
        db.add(QuotaPeriod(id=period_id, owner_id=owner, kind=MONTHLY, mode='redraw',
            source='membership', source_key=f'{MONTHLY}:{iso(at)}', starts_at=at,
            ends_at=user.plus_expires_at, granted=300, used=125, reserved=0))
        db.commit()
    assert entitlement(client, auth)['modes']['redraw']['quota']['available'] == 175
    job = submit(client, auth, upload(client, auth, png), 'redraw').json()
    assert job['quota_period_id'] == period_id
    response = issue(client, auth, {'days': 30}, 'extend-calendar')
    assert response.status_code == 200, response.text
    quota = response.json()['entitlements']['modes']['redraw']['quota']
    assert quota['id'] == period_id and (quota['used'], quota['reserved']) == (125, 1)
    assert quota['resets_at'] == '2026-02-28T08:00:00Z'
    freeze(monkeypatch, datetime(2026, 2, 28, 8))
    next_quota = entitlement(client, auth)['modes']['redraw']['quota']
    assert next_quota['resets_at'] == '2026-03-09T08:00:00Z'
    finish(job['id'])
    with session_factory()() as db:
        period = db.get(QuotaPeriod, period_id)
        assert (period.used, period.reserved) == (126, 0)
    assert entitlement(client, auth)['modes']['redraw']['quota']['available'] == 300
    freeze(monkeypatch, datetime(2026, 3, 10, 8))
    assert issue(client, auth, {'days': 30}, 'new-thirty-day-segment').status_code == 200
    with session_factory()() as db:
        assert db.get(User, owner).plus_timezone is None
    assert entitlement(client, auth)['modes']['redraw']['quota']['resets_at'] == '2026-04-09T08:00:00Z'


@pytest.mark.parametrize('pending', [False, True])
def test_revoked_unstarted_gift_allows_replacement_now_and_after_old_start(client, monkeypatch, pending):
    from app.db import session_factory
    from app.entitlement_models import MembershipOperation, QuotaPeriod
    from app.entitlements import activate_gift
    from app.models import User
    at = datetime(2026, 2, 1, 8)
    freeze(monkeypatch, at)
    auth = login(client)
    assert issue(client, auth, {'days': 30}).status_code == 200
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    with session_factory()() as db:
        user = db.get(User, owner)
        activate_gift(db, user, at + timedelta(days=365))
        user.plus_pending = pending
        old_period_id = db.scalar(select(QuotaPeriod.id).where(QuotaPeriod.owner_id == owner))
        db.commit()
    assert issue(client, auth, {'action': 'expire'}, 'revoke-future').status_code == 200
    with session_factory()() as db:
        assert db.get(QuotaPeriod, old_period_id) is None
        assert db.scalar(select(func.count()).select_from(MembershipOperation)) == 2
    assert issue(client, auth, {'days': 30}, 'replacement-now').status_code == 200
    freeze(monkeypatch, at + timedelta(days=365))
    assert issue(client, auth, {'days': 30}, 'replacement-after-old-start').status_code == 200


@pytest.mark.parametrize('retained', ['used', 'reserved', 'ledger', 'job'])
def test_revoke_never_deletes_used_or_referenced_future_period(client, png, monkeypatch, retained):
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.entitlements import activate_gift
    from app.models import Job, Ledger, User
    from test_membership import finish
    at = datetime(2026, 2, 1, 8)
    freeze(monkeypatch, at)
    auth = login(client)
    assert issue(client, auth, {'days': 30}).status_code == 200
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    job_id = None
    if retained == 'job':
        job_id = submit(client, auth, upload(client, auth, png), 'redraw').json()['id']
        finish(job_id, success=False)
    with session_factory()() as db:
        user = db.get(User, owner)
        activate_gift(db, user, at + timedelta(days=10))
        period = db.scalar(select(QuotaPeriod).where(QuotaPeriod.owner_id == owner))
        period_id = period.id
        if retained in ('used', 'reserved'):
            setattr(period, retained, 1)
        elif retained == 'ledger':
            db.add(Ledger(owner_id=owner, period_id=period_id, transaction_key='review-reference', kind='compensation', amount=0))
        else:
            # Isolate the Job FK check from the normal accompanying ledger rows.
            for row in db.scalars(select(Ledger).where(Ledger.period_id == period_id)):
                db.delete(row)
            assert db.get(Job, job_id).quota_period_id == period_id
        db.commit()
    assert issue(client, auth, {'action': 'expire'}, 'revoke-referenced').status_code == 200
    with session_factory()() as db:
        assert db.get(QuotaPeriod, period_id) is not None
