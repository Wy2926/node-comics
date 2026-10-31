"""Focused profile sync contract: signed events, latest login, isolation and recovery."""
from datetime import timedelta
import hashlib
import hmac
import json

import httpx
import pytest
from sqlalchemy import select

from conftest import login


@pytest.fixture
def profiles(client, monkeypatch):
    from app import auth_profiles as sync, logto_profiles
    from app.config import settings
    from app.db import session_factory
    from app.models import User, now
    cfg = settings()
    monkeypatch.setattr(cfg, 'oidc_issuer', 'https://identity.example/oidc')
    monkeypatch.setattr(cfg, 'oidc_token_endpoint', 'https://identity.example/oidc/token')
    monkeypatch.setattr(cfg, 'logto_management_client_id', 'profile-app')
    from pydantic import SecretStr
    monkeypatch.setattr(cfg, 'logto_management_client_secret', SecretStr('test-only-client-secret'))
    monkeypatch.setattr(cfg, 'logto_webhook_secret', SecretStr('test-only-hook-secret'))
    with session_factory()() as db:
        user = User(subject=cfg.oidc_issuer + '|auth-user', name='本站昵称')
        db.add(user); db.commit()
        owner = user.id
    value = dict(email='reader@example.invalid', username='auth-reader', name='Auth 昵称', phone=None,
                 suspended=False, auth_created_at=now() - timedelta(days=10), last_sign_in_at=now() - timedelta(hours=2))
    monkeypatch.setattr(logto_profiles.client(), 'fetch', lambda _: value.copy())
    yield client, owner, value, sync
    logto_profiles.client.cache_clear()


def event(kind='User.Data.Updated', **extra):
    from app.models import now
    return {'event': kind, 'hookId': 'fixture', 'createdAt': now().isoformat() + 'Z',
            'data': {'id': 'auth-user'}, **extra}


def post_event(client, value, signature=None):
    body = json.dumps(value).encode()
    signature = signature or hmac.new(b'test-only-hook-secret', body, hashlib.sha256).hexdigest()
    return client.post('/webhooks/logto', content=body, headers={'logto-signature-sha-256': signature})


def test_manual_refresh_admin_only_and_search(profiles):
    client, owner, value, sync = profiles
    route = f'/v1/admin/users/{owner}/auth-profile/refresh'
    assert client.post(route).status_code == 401
    reader = login(client)
    assert client.post(route, headers=reader).status_code == 403
    admin = login(client, 'admin')
    result = client.post(route, headers=admin)
    assert result.status_code == 200
    assert result.json()['email'] == value['email']
    assert result.json()['last_sign_in_at'].startswith(value['last_sign_in_at'].isoformat())
    assert client.post(route, headers=admin).status_code == 409
    detail = client.get(f'/v1/admin/monitor/users/{owner}', headers=admin).json()
    assert detail['name'] == '本站昵称' and detail['role'] == 'user'
    for q in (value['email'], value['username'], value['name']):
        result = client.get('/v1/admin/monitor/users', params={'q': q}, headers=admin).json()
        assert [row['id'] for row in result['items']] == [owner]
    assert 'auth_profile' not in client.get('/v1/me', headers=reader).json()['user']
    audit = client.get('/v1/admin/audit?action=user.auth_profile.refresh', headers=admin).json()
    assert audit['total'] == 1 and value['email'] not in json.dumps(audit)


def test_signed_login_event_duplicate_old_and_foreign_user(profiles):
    client, owner, value, sync = profiles
    from app.db import session_factory
    login_event = event('PostSignIn', data=None, user={'id': 'auth-user'})
    assert post_event(client, login_event, '0' * 64).status_code == 401
    with session_factory()() as db:
        assert db.get(sync.AuthProfile, owner) is None
    assert post_event(client, login_event).status_code == 200
    sync.sync_due()
    with session_factory()() as db:
        row = db.get(sync.AuthProfile, owner)
        assert row.last_sign_in_at == value['last_sign_in_at'] and row.next_sync_at is None
        generation = row.generation
    assert post_event(client, login_event).status_code == 200
    assert post_event(client, {**login_event, 'createdAt': '2020-01-01T00:00:00Z'}).status_code == 200
    assert post_event(client, event(data={'id': 'another-product-user'})).status_code == 200
    with session_factory()() as db:
        assert db.get(sync.AuthProfile, owner).generation == generation
        assert len(list(db.scalars(select(sync.AuthProfile)))) == 1
    assert post_event(client, event('User.Deleted', data=None, params={'id': 'auth-user'})).status_code == 200
    with session_factory()() as db:
        assert db.get(sync.AuthProfile, owner).generation == generation + 1
    assert client.post('/webhooks/logto', content=b'x' * (256 * 1024 + 1)).status_code == 413


def test_failure_keeps_cache_retry_and_removed_email(profiles, monkeypatch):
    client, owner, value, sync = profiles
    from app import logto_profiles
    from app.db import session_factory
    from app.models import now
    sync.sync_due()
    previous = value['last_sign_in_at']
    def fail(_):
        raise logto_profiles.ProfileError('unavailable')
    monkeypatch.setattr(logto_profiles.client(), 'fetch', fail)
    post_event(client, event())
    sync.sync_due()
    with session_factory()() as db:
        row = db.get(sync.AuthProfile, owner)
        assert row.email == value['email'] and row.error_code == 'unavailable'
        assert row.next_sync_at > now() and row.last_sign_in_at == previous
        row.next_sync_at = now(); db.commit()
    monkeypatch.setattr(logto_profiles.client(), 'fetch', lambda _: {**value, 'email': None, 'last_sign_in_at': previous - timedelta(hours=1)})
    sync.sync_due()
    with session_factory()() as db:
        row = db.get(sync.AuthProfile, owner)
        assert row.email is None and row.error_code is None and row.next_sync_at is None
        assert row.last_sign_in_at == previous


def test_event_arriving_during_read_is_not_lost_and_deleted_only_marks_profile(profiles, monkeypatch):
    _, owner, value, sync = profiles
    from app import logto_profiles
    from app.db import session_factory
    from app.models import User
    def fetch(_):
        sync.receive_event(event('PostSignIn'))
        return value.copy()
    monkeypatch.setattr(logto_profiles.client(), 'fetch', fetch)
    sync.sync_due()
    with session_factory()() as db:
        assert db.get(sync.AuthProfile, owner).next_sync_at is not None
    def missing(_):
        raise logto_profiles.ProfileError('not_found')
    monkeypatch.setattr(logto_profiles.client(), 'fetch', missing)
    sync.sync_due()
    with session_factory()() as db:
        assert db.get(User, owner).name == '本站昵称'
        assert db.get(sync.AuthProfile, owner).deleted and db.get(sync.AuthProfile, owner).next_sync_at is None


def test_management_client_allowlist_and_token_reuse(profiles, monkeypatch):
    from app import logto_profiles
    calls = []
    def handle(request):
        calls.append(request)
        if request.url.path == '/oidc/token':
            assert b'grant_type=client_credentials' in request.content and b'scope=all' in request.content
            return httpx.Response(200, json={'access_token': 'fixture-token', 'expires_in': 3600, 'token_type': 'Bearer'})
        assert request.headers['Authorization'] == 'Bearer fixture-token'
        return httpx.Response(200, json={'id': 'auth-user', 'primaryEmail': 'a@example.invalid',
            'isSuspended': False, 'lastSignInAt': 1700000000000, 'password': 'DO_NOT_STORE',
            'customData': {'secret': 'DO_NOT_STORE'}, 'identities': {'private': 'DO_NOT_STORE'}})
    original = httpx.Client
    monkeypatch.setattr(logto_profiles.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs))
    reader = logto_profiles.LogtoProfiles()
    first = reader.fetch('auth-user')
    assert first == reader.fetch('auth-user')
    assert len(calls) == 3 and first['last_sign_in_at'].year == 2023
    assert 'DO_NOT_STORE' not in repr(first)
