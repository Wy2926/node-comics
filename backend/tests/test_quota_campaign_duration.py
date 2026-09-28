"""Audited duration corrections preserve campaign identity and quota settlement."""
from datetime import timedelta
import pytest
from sqlalchemy import func, select
from conftest import configure_system_limits, login, png_variant, upload
from test_membership import finish, submit
from test_quota_campaigns import campaign, grants
from app.db import session_factory
from app.entitlement_models import QuotaPeriod
from app.models import Ledger, User, now
from app.quota_campaign_models import QuotaCampaign, QuotaCampaignAward
from app.quota_campaigns import backfill_campaigns


def duration(client, operator, version, *, days=7, existing=True, **overrides):
    body = {'validity_days': days, 'ends_at': (now() + timedelta(days=30)).isoformat() + 'Z',
            'apply_to_existing': existing, 'expected_version': version, 'note': 'Adjust promotion duration', **overrides}
    response = client.patch('/v1/admin/quota-campaigns/welcome/duration', headers=operator, json=body)
    return response, body


def test_duration_preserves_used_reserved_receipts_and_late_settlement(client, png, monkeypatch):
    from app.config import settings
    from app.entitlements import available_periods, DAILY
    settings().classic_enabled = True
    configure_system_limits(free_daily_pages=0)
    operator, row = campaign(client, pages=3)
    auth = login(client)
    jobs = [submit(client, auth, upload(client, auth, png_variant(png, i)), key=str(i)).json() for i in range(2)]
    finish(jobs[0]['id'], True)
    before, = grants(client, auth)
    assert (before['used'], before['reserved']) == (1, 1)
    with session_factory()() as db:
        ledger_count = db.scalar(select(func.count()).select_from(Ledger))
    response, body = duration(client, operator, row['version'])
    assert response.status_code == 200, response.text
    after, = grants(client, auth)
    assert {k:v for k,v in before.items() if k != 'expires_at'} == {k:v for k,v in after.items() if k != 'expires_at'}
    with session_factory()() as db:
        period = db.get(QuotaPeriod, after['id'])
        assert period.ends_at == period.starts_at + timedelta(days=7)
        assert period.id not in [p.id for p in available_periods(db, db.get(User, period.owner_id), 'classic', DAILY, period.ends_at)]
        assert db.scalar(select(func.count()).select_from(Ledger)) == ledger_count
    # A later status change must not make recovery reapply/reverse a duration edit.
    paused = client.patch('/v1/admin/quota-campaigns/welcome', headers=operator,
        json={'enabled': False, 'expected_version': response.json()['version']})
    replay = client.patch('/v1/admin/quota-campaigns/welcome/duration', headers=operator, json=body)
    assert replay.status_code == 200 and replay.json()['version'] == paused.json()['version']
    assert not replay.json()['enabled']
    assert client.patch('/v1/admin/quota-campaigns/welcome/duration', headers=operator,
        json={**body, 'validity_days': 14}).status_code == 409
    with session_factory()() as db:
        period = db.get(QuotaPeriod, after['id'])
        after_expiry = period.ends_at + timedelta(seconds=1)
    monkeypatch.setattr('app.quota_grants.now', lambda: after_expiry)
    monkeypatch.setattr('app.entitlements.now', lambda: after_expiry)
    assert grants(client, auth) == []
    finish(jobs[1]['id'], True)
    finish(jobs[1]['id'], True)
    with session_factory()() as db:
        period = db.get(QuotaPeriod, after['id'])
        assert (period.used, period.reserved) == (2, 0)
        assert db.scalar(select(func.count()).select_from(QuotaCampaignAward)) == 1


def test_duration_future_only_and_explicit_existing_scope(client):
    operator, row = campaign(client)
    auth = login(client, 'already-awarded')
    campaign(client, 'unrelated', pages=19, validity_days=60)
    backfill_campaigns()
    existing = grants(client, auth)
    other = next(p for p in existing if p['granted'] == 19)
    response, _ = duration(client, operator, row['version'], existing=False)
    assert response.status_code == 200
    assert next(p for p in grants(client, auth) if p['granted'] == 300)['expires_at'] is None
    newcomer = login(client, 'future-recipient')
    assert next(p for p in grants(client, newcomer) if p['granted'] == 300)['expires_at'] is not None
    response, _ = duration(client, operator, response.json()['version'], days=3)
    assert response.status_code == 200
    assert next(p for p in grants(client, auth) if p['granted'] == 19) == other
    with session_factory()() as db:
        periods = db.scalars(select(QuotaPeriod).join(QuotaCampaignAward, QuotaCampaignAward.period_id == QuotaPeriod.id)
                            .where(QuotaCampaignAward.campaign_id == 'welcome'))
        assert all(p.ends_at == p.starts_at + timedelta(days=3) for p in periods)
    assert backfill_campaigns() == 0


def test_duration_permissions_validation_and_not_found(client):
    operator, row = campaign(client)
    auth = login(client)
    response, body = duration(client, auth, row['version'])
    assert response.status_code == 403
    assert client.patch('/v1/admin/quota-campaigns/welcome/duration', json=body).status_code == 401
    for invalid in ({'validity_days': 0}, {'validity_days': 1.5}, {'validity_days': 36501},
                    {'note': ' '}, {'pages': 301}, {'apply_to_existing': 'true'}, {'ends_at': row['starts_at']}):
        assert client.patch('/v1/admin/quota-campaigns/welcome/duration', headers=operator, json={**body, **invalid}).status_code == 422
    for missing in ('apply_to_existing', 'ends_at', 'validity_days'):
        assert client.patch('/v1/admin/quota-campaigns/welcome/duration', headers=operator,
                            json={k:v for k,v in body.items() if k != missing}).status_code == 422
    assert client.patch('/v1/admin/quota-campaigns/missing/duration', headers=operator, json=body).status_code == 404
    assert client.get('/v1/admin/quota-campaigns/missing/awards', headers=operator).status_code == 404
    assert client.get('/v1/admin/quota-campaigns', headers=operator).json()['items'][0]['version'] == row['version']


def test_duration_end_stops_registration_without_expiring_existing_gifts(client):
    from app.quota_campaigns import award_campaigns, utc
    from datetime import datetime
    operator, row = campaign(client)
    response, body = duration(client, operator, row['version'])
    assert response.status_code == 200
    end = utc(datetime.fromisoformat(body['ends_at']))
    with session_factory()() as db:
        last = User(subject='before-end', name='last recipient')
        late = User(subject='at-end', name='too late')
        db.add_all([last, late]); db.flush()
        assert award_campaigns(db, last, end - timedelta(seconds=1)) == 1
        assert award_campaigns(db, late, end) == 0
        period = db.scalar(select(QuotaPeriod).where(QuotaPeriod.owner_id == last.id))
        assert period.ends_at == end - timedelta(seconds=1) + timedelta(days=7)


def test_duration_audit_failure_rolls_back_every_changed_grant(client, monkeypatch):
    from app import quota_campaigns as service
    operator, row = campaign(client)
    first, second = login(client, 'first'), login(client, 'second')
    original = (grants(client, first), grants(client, second))
    record = service.record_audit
    def failing_audit(*args, **kwargs):
        if args[2] == 'quota_campaign.duration':
            raise RuntimeError('Synthetic audit failure')
        return record(*args, **kwargs)
    monkeypatch.setattr(service, 'record_audit', failing_audit)
    with pytest.raises(RuntimeError, match='Synthetic audit failure'):
        duration(client, operator, row['version'])
    assert (grants(client, first), grants(client, second)) == original
    with session_factory()() as db:
        assert db.get(QuotaCampaign, 'welcome').version == row['version']


def test_status_recovery_requires_the_same_actor_and_original_receipt(client):
    first, row = campaign(client, enable=False)
    second = login(client, 'second-admin')
    with session_factory()() as db:
        db.scalar(select(User).where(User.subject == 'dev:second-admin')).role = 'admin'; db.commit()
    patch = {'enabled': True, 'expected_version': row['version']}
    enabled = client.patch('/v1/admin/quota-campaigns/welcome', headers=first, json=patch)
    assert enabled.status_code == 200
    assert client.patch('/v1/admin/quota-campaigns/welcome', headers=second, json=patch).status_code == 409
    paused = client.patch('/v1/admin/quota-campaigns/welcome', headers=second,
        json={'enabled': False, 'expected_version': enabled.json()['version']})
    assert paused.status_code == 200
    recovered = client.patch('/v1/admin/quota-campaigns/welcome', headers=first, json=patch)
    assert recovered.status_code == 200 and recovered.json() == paused.json()
