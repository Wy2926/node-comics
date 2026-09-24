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
    assert after['resets_at'] == '2026-02-28T08:00:00Z'
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
