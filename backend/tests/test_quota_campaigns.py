"""Campaign delivery, account isolation, recovery and real quota settlement."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace
import pytest
from sqlalchemy import func, select
from conftest import configure_system_limits, login, png_variant, upload
from test_membership import entitlement, finish, grant, submit
from app.db import session_factory
from app.entitlement_models import QuotaPeriod
from app.models import Ledger, User, now
from app.quota_campaign_models import QuotaCampaign, QuotaCampaignAward
from app.quota_campaigns import award_campaigns, backfill_campaigns


def campaign(client, key='welcome', *, enable=True, **terms):
    operator = login(client, 'admin')
    body = {'name': 'Account allowance', 'mode': 'classic', 'pages': 300, **terms}
    response = client.put('/v1/admin/quota-campaigns/' + key, headers=operator, json=body)
    assert response.status_code == 200, response.text
    if enable:
        response = client.patch('/v1/admin/quota-campaigns/' + key, headers=operator,
            json={'enabled': True, 'expected_version': response.json()['version']})
        assert response.status_code == 200, response.text
    return operator, response.json()


def grants(client, auth):
    response = client.get('/v1/me/quota-grants', headers=auth)
    assert response.status_code == 200, response.text
    return response.json()['items']


def test_backfill_existing_and_registration_share_once_only_receipts(client):
    old = login(client, 'existing')
    operator, _ = campaign(client)
    assert grants(client, old) == []
    assert backfill_campaigns(limit=1) == 1
    backfill_campaigns()
    new = login(client, 'new')
    for auth in (old, new, operator):
        bucket, = grants(client, auth)
        assert (bucket['granted'], bucket['available'], bucket['expires_at']) == (300, 300, None)
        rights = entitlement(client, auth)
        assert rights['plan'] == 'free'
        assert rights['modes']['classic']['quota']['available'] == 330
        assert not rights['modes']['redraw']['allowed']
    login(client, 'new')
    assert backfill_campaigns() == 0
    listing = client.get('/v1/admin/quota-campaigns', headers=operator).json()
    assert listing['items'][0]['awarded_users'] == 3
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(QuotaCampaignAward)) == 3
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'grant')) == 3


def test_configuration_is_private_immutable_and_explicitly_enabled(client):
    auth = login(client)
    assert client.put('/v1/admin/quota-campaigns/x', headers=auth, json={
        'name': 'x', 'mode': 'classic', 'pages': 1}).status_code == 403
    assert client.get('/v1/admin/quota-campaigns').status_code == 401
    operator, created = campaign(client, enable=False)
    assert not created['enabled'] and backfill_campaigns() == 0
    operator, replay = campaign(client, enable=False)
    assert replay == created
    assert client.put('/v1/admin/quota-campaigns/welcome', headers=operator, json={
        'name': 'Account allowance', 'mode': 'classic', 'pages': 301}).status_code == 409
    for patch in ({'pages': 500}, {'enabled': True, 'expected_version': 9}):
        assert client.patch('/v1/admin/quota-campaigns/welcome', headers=operator, json=patch).status_code in (409, 422)
    patch = {'enabled': True, 'expected_version': 1}
    first = client.patch('/v1/admin/quota-campaigns/welcome', headers=operator, json=patch)
    assert client.patch('/v1/admin/quota-campaigns/welcome', headers=operator, json=patch).json() == first.json()
    assert client.get('/v1/admin/quota-campaigns/welcome/awards', headers=auth).status_code == 403
    backfill_campaigns()
    items = client.get('/v1/admin/quota-campaigns/welcome/awards', headers=operator).json()
    assert items['total'] == 2 and len(items['items']) == 2
    from app.admin_audit import AdminAudit
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(AdminAudit)
                         .where(AdminAudit.action.startswith('quota_campaign.'))) == 2


@pytest.mark.parametrize('audience', ['existing', 'new'])
def test_audience_boundary_pause_resume_and_no_regrant(client, audience):
    old = login(client, 'old')
    operator, row = campaign(client, audience=audience)
    new = login(client, 'new')
    backfill_campaigns()
    assert bool(grants(client, old)) == (audience == 'existing')
    assert bool(grants(client, new)) == (audience == 'new')
    patch = client.patch('/v1/admin/quota-campaigns/welcome', headers=operator,
        json={'enabled': False, 'expected_version': row['version']})
    assert patch.status_code == 200
    late = login(client, 'paused')
    assert backfill_campaigns() == 0 and grants(client, late) == []
    assert client.patch('/v1/admin/quota-campaigns/welcome', headers=operator,
        json={'enabled': True, 'expected_version': patch.json()['version']}).status_code == 200
    backfill_campaigns()
    assert bool(grants(client, late)) == (audience == 'new')
    assert backfill_campaigns() == 0


def test_delivery_windows_expiry_and_registration_recovery(client, monkeypatch):
    import app.quota_campaigns as service
    at = now()
    _, _ = campaign(client, starts_at=(at + timedelta(days=1)).isoformat() + 'Z',
        ends_at=(at + timedelta(days=3)).isoformat() + 'Z', validity_days=1)
    auth = login(client)
    assert not grants(client, auth) and backfill_campaigns() == 0
    monkeypatch.setattr(service, 'now', lambda: at + timedelta(days=1))
    assert backfill_campaigns() == 2
    with session_factory()() as db:
        bucket = db.scalar(select(QuotaPeriod).where(QuotaPeriod.source == 'grant'))
        assert bucket.ends_at == at + timedelta(days=2)
    monkeypatch.setattr(service, 'now', lambda: at + timedelta(days=2))
    assert backfill_campaigns() == 0  # Expiry never resets delivery eligibility.
    monkeypatch.setattr(service, 'now', lambda: at + timedelta(days=3))
    login(client, 'after-close')
    assert backfill_campaigns() == 0


def test_rollback_does_not_leave_receipt_or_partial_registration(client):
    campaign(client)
    with session_factory()() as db:
        user = User(subject='rolled-back', name='rolled-back')
        db.add(user)
        db.flush()
        assert award_campaigns(db, user) == 1
        db.rollback()
    with session_factory()() as db:
        assert not db.scalar(select(User).where(User.subject == 'rolled-back'))
        assert db.scalar(select(func.count()).select_from(QuotaCampaignAward)) == 0
        assert db.scalar(select(func.count()).select_from(Ledger)) == 0
    assert backfill_campaigns() == 1


def test_independent_campaigns_and_users_preserve_quota_settlement(client, png):
    from app.config import settings
    settings().classic_enabled = True
    configure_system_limits(free_daily_pages=1)
    operator, _ = campaign(client, pages=2)
    auth, other = login(client), login(client, 'other')
    ids = []
    for n in range(3):
        response = submit(client, auth, upload(client, auth, png_variant(png, n)), key=str(n))
        assert response.status_code == 202, response.text
        ids.append(response.json())
    assert [item['quota_kind'] for item in ids] == ['classic_daily', 'classic_grant', 'classic_grant']
    assert submit(client, auth, upload(client, auth, png_variant(png, 9)), key='empty').status_code == 403
    for job, success in zip(ids, [True, True, False]):
        finish(job['id'], success)
        finish(job['id'], success)
    bucket, = grants(client, auth)
    assert (bucket['used'], bucket['reserved'], bucket['available']) == (1, 0, 1)
    assert grants(client, other)[0]['available'] == 2
    assert client.get('/v1/admin/users/' + client.get('/v1/me', headers=auth).json()['user']['id']
        + '/quota-periods', headers=operator).status_code == 200
    grant(client, auth)
    result = submit(client, auth, upload(client, auth, png_variant(png, 10)), key='plus').json()
    assert result['settlement'] == 'included' and grants(client, auth)[0]['available'] == 1
    campaign(client, 'separate', pages=7)
    backfill_campaigns()
    assert sorted(item['granted'] for item in grants(client, other)) == [2, 7]


def test_permanent_redraw_grant_has_nullable_expiry_contract(client):
    campaign(client, mode='redraw', pages=1)
    auth = login(client)
    quota = entitlement(client, auth)['modes']['redraw']['quota']
    assert quota['available'] == 1 and quota['next_expiry_at'] is None


def test_concurrent_delivery_is_exactly_once(client):
    campaign(client, enable=False)
    auth = login(client)
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    campaign(client)
    ready = Barrier(4)
    def deliver(_):
        with session_factory()() as db:
            user = db.get(User, owner)
            ready.wait(timeout=10)
            result = award_campaigns(db, user)
            db.commit()
            return result
    with ThreadPoolExecutor(4) as pool:
        assert sorted(pool.map(deliver, range(4))) == [0, 0, 0, 1]
    assert len(grants(client, auth)) == 1


def test_oidc_concurrent_first_requests_get_one_user_and_award(client, monkeypatch):
    campaign(client)
    from app import auth
    from app.config import settings
    cfg = settings()
    cfg.dev_auth = False
    cfg.oidc_issuer = 'https://isolated.example/oidc'
    cfg.oidc_audience = 'isolated'
    cfg.oidc_jwks_url = cfg.oidc_issuer + '/jwks'
    monkeypatch.setattr(auth, 'jwks_client', lambda: SimpleNamespace(
        get_signing_key_from_jwt=lambda _: SimpleNamespace(key='isolated')))
    monkeypatch.setattr(auth.jwt, 'decode', lambda *args, **kwargs: {'sub': 'new-oidc-account'})
    ready = Barrier(3)
    def first_request(_):
        ready.wait(timeout=10)
        response = client.get('/v1/me', headers={'Authorization': 'Bearer isolated'})
        assert response.status_code == 200, response.text
        return response.json()
    with ThreadPoolExecutor(3) as pool:
        rows = list(pool.map(first_request, range(3)))
    assert len({row['user']['id'] for row in rows}) == 1
    assert all(row['entitlements']['modes']['classic']['quota']['available'] == 330 for row in rows)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(QuotaCampaignAward)) == 1


def test_upgrade_keeps_referenced_quota_and_ledger(client):
    from pathlib import Path
    from datetime import timedelta
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import func, inspect, select
    from app.db import engine, initialize, session_factory
    from app.models import Ledger, User, now
    from app.entitlement_models import QuotaPeriod
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with engine().begin() as connection:
        config.attributes['connection'] = connection
        command.downgrade(config, 'gift_renewal_0005')
    with session_factory()() as db:
        db.add(User(id='preserve', subject='preserve', name='Preserved'))
        db.flush()
        db.add(QuotaPeriod(id='preserved-quota', owner_id='preserve', kind='classic_grant',
            mode='classic', source='grant', source_key='original', starts_at=now(),
            ends_at=now() + timedelta(days=30), granted=500, used=17, reserved=2))
        db.flush()
        db.add(Ledger(owner_id='preserve', period_id='preserved-quota', quota_kind='classic_grant',
                      transaction_key='preserved-ledger', kind='grant', amount=500))
        db.commit()
    initialize()
    initialize()
    with session_factory()() as db:
        period = db.get(QuotaPeriod, 'preserved-quota')
        assert (period.granted, period.used, period.reserved) == (500, 17, 2)
        assert db.scalar(select(func.count()).select_from(Ledger)
                         .where(Ledger.transaction_key == 'preserved-ledger')) == 1
        checks = inspect(db.connection()).get_check_constraints('quota_periods')
        assert len(checks) == 8
