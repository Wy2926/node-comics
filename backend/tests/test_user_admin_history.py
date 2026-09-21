"""Admin history remains scoped, paginated, append-only and replay safe."""
from datetime import timedelta
from sqlalchemy import func, select
from conftest import login, upload, create


def test_user_histories_require_admin_and_scope_to_user(client):
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.models import Ledger, now
    reader, admin = login(client), login(client, 'admin')
    owner = client.get('/v1/me', headers=reader).json()['user']['id']
    with session_factory()() as db:
        at = now()
        for index in range(3):
            period = QuotaPeriod(id=f'history-{index}', owner_id=owner, kind='classic_daily', mode='classic', source='daily',
                source_key=f'history-{index}', starts_at=at - timedelta(days=index + 1), ends_at=at - timedelta(days=index), granted=30)
            db.add(period)
            db.flush()
            db.add(Ledger(owner_id=owner, period_id=period.id, kind='compensation', quota_kind='classic_daily', amount=2,
                transaction_key=f'history-{index}', note='isolated test'))
        db.commit()
    for route in ('quota-periods', 'usage-ledger', 'membership-operations', 'reserved-jobs'):
        path = f'/v1/admin/users/{owner}/{route}'
        assert client.get(path, headers=reader).status_code == 403
        assert client.get(path, headers=admin).status_code == 200
        assert client.get(f'/v1/admin/users/missing/{route}', headers=admin).status_code == 404
    page = client.get(f'/v1/admin/users/{owner}/quota-periods?limit=2', headers=admin).json()
    assert page['total'] == 3 and page['next_offset'] == 2
    more = client.get(f'/v1/admin/users/{owner}/quota-periods?limit=2&offset=2', headers=admin).json()
    assert more['next_offset'] is None and len(more['items']) == 1
    assert {row['id'] for row in page['items']}.isdisjoint(row['id'] for row in more['items'])
    ledger = client.get(f'/v1/admin/users/{owner}/usage-ledger?period_id=history-1', headers=admin).json()
    assert ledger['total'] == 1
    assert 'transaction_key' not in ledger['items'][0]
    other = client.get('/v1/me', headers=login(client, 'other')).json()['user']['id']
    assert client.get(f'/v1/admin/users/{other}/usage-ledger?period_id=history-1', headers=admin).json()['total'] == 0


def test_expire_and_compensation_have_one_receipt_and_keep_reserved_bucket(client, png):
    from app.admin_audit import AdminAudit
    from app.db import session_factory
    from app.entitlement_models import MembershipOperation, QuotaPeriod
    from app.entitlements import settle
    from app.models import Job, Ledger
    reader, admin = login(client), login(client, 'admin')
    owner = client.get('/v1/me', headers=reader).json()['user']['id']
    base = f'/v1/admin/users/{owner}'
    assert client.post(base + '/membership', headers={**admin, 'Idempotency-Key': 'open'},
        json={'days': 30, 'monthly_pages': 3, 'note': 'test'}).status_code == 200
    job = create(client, reader, upload(client, reader, png)).json()
    assert job['settlement'] == 'reserved'
    compensation = {'kind': 'redraw_monthly', 'pages': 2, 'note': 'delivery compensation'}
    first = client.post(base + '/quota-compensations', headers={**admin, 'Idempotency-Key': 'compensate'}, json=compensation)
    assert first.status_code == 200, first.text
    assert client.post(base + '/quota-compensations', headers={**admin, 'Idempotency-Key': 'compensate'}, json=compensation).json() == first.json()
    pending = client.get(base + '/reserved-jobs', headers=admin).json()
    assert pending['total'] == 1 and pending['items'][0]['id'] == job['id']
    expired = client.post(base + '/membership', headers={**admin, 'Idempotency-Key': 'expire'}, json={'action': 'expire', 'note': 'test end'})
    assert expired.status_code == 200 and expired.json()['entitlements']['plan'] == 'free'
    assert client.post(base + '/membership', headers={**admin, 'Idempotency-Key': 'expire'}, json={'action': 'expire', 'note': 'test end'}).json() == expired.json()
    with session_factory()() as db:
        task = db.get(Job, job['id'])
        period = db.get(QuotaPeriod, task.quota_period_id)
        assert period.granted == 5 and period.reserved == 1
        task.status = 'failed'
        settle(db, task, success=False)
        db.commit()
        db.refresh(period)
        assert period.reserved == 0 and period.used == 0
        assert db.scalar(select(func.count()).select_from(MembershipOperation)) == 3
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.action.in_(['membership.extend', 'membership.expire', 'quota.compensate']))) == 3
        assert db.scalar(select(func.count()).select_from(Ledger).where(Ledger.kind == 'compensation')) == 1
    history = client.get(base + '/membership-operations?limit=2', headers=admin).json()
    assert history['total'] == 3 and history['next_offset'] == 2
    assert all(row['operator_name'] and 'request_hash' not in row and 'result' not in row for row in history['items'])
    assert client.get(base + '/reserved-jobs', headers=admin).json()['total'] == 0


def test_quota_grant_audit_is_atomic_and_idempotent(client):
    from app.admin_audit import AdminAudit
    from app.db import session_factory
    from app.models import now
    reader, admin = login(client), login(client, 'admin')
    owner = client.get('/v1/me', headers=reader).json()['user']['id']
    body = {'mode': 'classic', 'pages': 2, 'expires_at': (now() + timedelta(days=3)).isoformat() + 'Z', 'note': 'test'}
    url = f'/v1/admin/users/{owner}/quota-grants'
    headers = {**admin, 'Idempotency-Key': 'grant'}
    assert client.post(url, headers=headers, json=body).status_code == 201
    assert client.post(url, headers=headers, json=body).status_code == 201
    assert client.post(url, headers=headers, json={**body, 'pages': 3}).status_code == 409
    assert client.post(url, headers={**admin, 'Idempotency-Key': 'blank'}, json={**body, 'note': '  '}).status_code == 422
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.action == 'quota.grant')) == 1


def test_membership_form_default_uses_database_and_renewal_keeps_original_terms(client):
    from conftest import configure_system_limits
    admin, reader = login(client, 'admin'), login(client)
    owner = client.get('/v1/me', headers=reader).json()['user']['id']
    configure_system_limits(plus_monthly_redraw_pages=600)
    # The form omits monthly_pages when the optional override is left empty.
    payload = {'action': 'extend', 'days': 30, 'note': 'use configured default'}
    initial = client.post(f'/v1/admin/users/{owner}/membership',
        headers={**admin, 'Idempotency-Key': 'default-open'}, json=payload)
    assert initial.status_code == 200
    assert initial.json()['entitlements']['modes']['redraw']['quota']['granted'] == 600
    configure_system_limits(plus_monthly_redraw_pages=900)
    renewed = client.post(f'/v1/admin/users/{owner}/membership',
        headers={**admin, 'Idempotency-Key': 'default-renew'}, json=payload)
    assert renewed.status_code == 200
    assert renewed.json()['entitlements']['modes']['redraw']['quota']['granted'] == 600
    assert client.post(f'/v1/admin/users/{owner}/membership',
        headers={**admin, 'Idempotency-Key': 'default-open'}, json=payload).json() == initial.json()
    newcomer = client.get('/v1/me', headers=login(client, 'newcomer')).json()['user']['id']
    fresh = client.post(f'/v1/admin/users/{newcomer}/membership',
        headers={**admin, 'Idempotency-Key': 'new-default-open'}, json=payload)
    assert fresh.status_code == 200
    assert fresh.json()['entitlements']['modes']['redraw']['quota']['granted'] == 900
