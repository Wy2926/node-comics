"""Admin workflow regressions; all upstream/model/geo data are synthetic."""
import asyncio
from dataclasses import replace
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from starlette.requests import Request

from conftest import login, login_plus, request_record
from test_cluster_submissions import descriptor, submit
from test_document_quota_api import document_case, body, purchase
from test_billing_admin import administrator, order_data


def test_image_address_uses_peer_and_replay_does_not_rewrite_origin(client):
    from app.main import app
    from app.db import session_factory
    from app.models import Job
    auth = login_plus(client)
    first_client = TestClient(app, client=('2001:4860:4860::8888', 54321))
    first = submit(first_client, {**auth, 'X-Forwarded-For': '1.1.1.1', 'CF-Connecting-IP': '8.8.8.8'}, descriptor(b'fixture'))
    assert first.status_code == 202, first.text
    row = request_record(client, auth, first.json()['id'])
    second_client = TestClient(app, client=('8.8.8.8', 54321))
    assert submit(second_client, auth, descriptor(b'fixture')).status_code == 202
    # Same user/content under a different request also reuses the original task.
    assert submit(second_client, auth, descriptor(b'fixture'), key='new-request').status_code == 202
    with session_factory()() as db:
        assert db.get(Job, row.job_id).submitted_ip == '2001:4860:4860::8888'
        assert db.scalar(select(func.count()).select_from(Job)) == 1
    public = client.get('/v1/translations/' + first.json()['id'], headers=auth)
    assert 'submitted_ip' not in public.text and 'country' not in public.text
    assert client.get('/v1/admin/monitor/tasks/' + row.job_id, headers=auth).status_code == 403
    detail = client.get('/v1/admin/monitor/tasks/' + row.job_id, headers=login(client, 'admin')).json()
    assert detail['submitted_ip'] == '2001:4860:4860::8888'


def test_document_address_is_recorded_only_on_first_acceptance(document_case):
    from app.main import app
    from app.db import session_factory
    from app.models import Job
    purchase(document_case, 10)
    key = str(uuid4())
    peer = TestClient(app, client=('8.8.8.8', 12345))
    result = peer.put('/v1/documents/' + key, json=body(document_case), headers=document_case.auth)
    assert result.status_code == 202, result.text
    assert document_case.client.put('/v1/documents/' + key, json=body(document_case), headers=document_case.auth).status_code == 202
    with session_factory()() as db:
        assert db.scalar(select(Job).where(Job.idempotency_key == key)).submitted_ip == '8.8.8.8'
    assert 'submitted_ip' not in result.text


def test_country_lookup_is_local_bounded_and_handles_missing_database(client, monkeypatch):
    from app import geoip
    calls = []
    class Reader:
        def __enter__(self): return self
        def __exit__(self, *args): calls.append('closed')
        def get(self, ip): calls.append(ip); return {'country': {'iso_code': 'JP'}}
    monkeypatch.setattr(geoip.maxminddb, 'open_database', lambda *args, **kwargs: Reader())
    data = geoip.countries(['8.8.8.8', '8.8.8.8', '2001:4860:4860::8888', '127.0.0.1', None, 'invalid'])
    assert data['8.8.8.8'] == {'code': 'JP', 'status': 'located'}
    assert data['2001:4860:4860::8888']['code'] == 'JP'
    assert data['127.0.0.1']['status'] == 'private'
    assert data['invalid']['status'] == 'unknown'
    assert calls.count('8.8.8.8') == 1 and calls[-1] == 'closed'
    def missing(*args, **kwargs): raise FileNotFoundError()
    monkeypatch.setattr(geoip.maxminddb, 'open_database', missing)
    assert geoip.countries(['8.8.8.8'])['8.8.8.8']['status'] == 'unavailable'


def support(client):
    response = client.post('/v1/support-requests', headers={'Idempotency-Key': str(uuid4())},
        json={'kind': 'plugin', 'comment': 'Synthetic feedback'})
    assert response.status_code == 201
    return response.json()['id']


def test_support_review_inbox_authorization_replay_and_conflict(client):
    from app.db import session_factory
    from app.admin_audit import AdminAudit
    id = support(client)
    auth = login(client, 'admin')
    url = '/v1/admin/support-requests/' + id
    for path in (url, '/v1/admin/workspace/inbox', '/v1/admin/workspace/events'):
        assert client.get(path).status_code == 401
        assert client.get(path, headers=login(client, 'reader')).status_code == 403
    assert client.get('/v1/admin/workspace/inbox', headers=auth).json()['counts']['plugin'] == 1
    payload = {'status': 'resolved', 'note': 'fixed', 'expected_reviewed_at': None}
    assert client.patch(url, headers=login(client, 'reader'), json=payload).status_code == 403
    first = client.patch(url, headers=auth, json=payload)
    assert first.status_code == 200
    assert client.patch(url, headers=auth, json=payload).json() == first.json()
    assert client.patch(url, headers=auth, json={**payload, 'note': 'stale change'}).status_code == 409
    assert client.patch(url, headers=auth, json={**payload, 'note': ' '}).status_code == 422
    assert client.get('/v1/admin/workspace/inbox', headers=auth).json()['total'] == 0
    assert client.get('/v1/admin/support-requests?kind=plugin&status=received', headers=auth).json()['items'] == []
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(AdminAudit).where(AdminAudit.action == 'support.review')) == 1


def test_inbox_stream_wakes_on_commit_and_releases_subscription(client):
    from app.admin_workspace import inbox_events
    from app.db import session_factory
    from app.models import User, uid
    from app.notifications import hub
    from app.support_requests import SupportRequest
    auth = login(client, 'admin')
    request = Request({'type': 'http', 'headers': [(b'authorization', auth['Authorization'].encode())]})
    async def exercise():
        current = hub()
        before = len(current.waiters)
        with session_factory()() as db:
            user = db.scalar(select(User).where(User.role == 'admin'))
            response = await inbox_events(request, user, db)
            assert not db.in_transaction()
            assert '"total":0' in await anext(response.body_iterator)
            with session_factory()() as writer:
                writer.add(SupportRequest(kind='plugin', site_name='', url='', comment='new', contact='',
                    idempotency_key=uid(), request_hash='0' * 64))
                writer.commit()
            frame = await asyncio.wait_for(anext(response.body_iterator), timeout=2)
            assert '"total":1' in frame
            assert len(current.waiters) == before + 1
            await response.body_iterator.aclose()
            await response.cleanup()
            assert len(current.waiters) == before
    asyncio.run(exercise())


def test_provider_probe_runs_once_uses_saved_config_and_does_not_charge_user(client, monkeypatch):
    from app.translation_channels import CHANNELS
    from app.adapters.llm import TextResponse
    from app.db import session_factory
    from app.models import Job, Ledger
    from app.admin_audit import AdminAudit
    auth = login(client, 'admin')
    provider = client.get('/v1/admin/translation-providers', headers=auth).json()['items'][0]
    url = '/v1/admin/translation-providers/' + provider['id']
    assert client.patch(url, headers=auth, json={'enabled': False}).status_code == 200
    calls = []
    def probe(messages, config, credential, *, limits):
        calls.append((messages, config, limits))
        assert credential == 'isolated-test-text-key'
        assert limits.timeout_seconds <= 30 and limits.max_output_tokens <= 1024
        return TextResponse('你好 isolated-test-text-key', {'input_tokens': 4, 'output_tokens': 2}, None)
    monkeypatch.setitem(CHANNELS, 'openai', replace(CHANNELS['openai'], call=probe))
    payload = {'revision_id': provider['revision_id']}
    assert client.post(url + '/test', headers=login(client, 'reader'), json=payload).status_code == 403
    assert client.post(url + '/test', headers=auth, json={'revision_id': 'stale'}).status_code == 409
    response = client.post(url + '/test', headers=auth, json=payload)
    assert response.status_code == 200, response.text
    assert response.json()['ok'] and response.json()['usage']['input_tokens'] == 4
    assert 'isolated-test-text-key' not in response.text
    assert client.post(url + '/test', headers=auth, json=payload).status_code == 429
    assert len(calls) == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 0
        assert db.scalar(select(func.count()).select_from(Ledger)) == 0
        event = db.scalar(select(AdminAudit).where(AdminAudit.action == 'text_provider.test'))
        assert event.details['ok'] and 'response' not in event.details


def test_provider_probe_timeout_does_not_retry(client, monkeypatch):
    from app.translation_channels import CHANNELS
    from app.adapters.llm import TextError
    auth = login(client, 'admin')
    provider = client.get('/v1/admin/translation-providers', headers=auth).json()['items'][0]
    calls = []
    def timeout(*args, **kwargs):
        calls.append(True)
        raise TextError('TEXT_TRANSPORT_FAILED', '文本请求超时或连接中断', retryable=True)
    monkeypatch.setitem(CHANNELS, 'openai', replace(CHANNELS['openai'], call=timeout))
    result = client.post('/v1/admin/translation-providers/' + provider['id'] + '/test', headers=auth,
        json={'revision_id': provider['revision_id']})
    assert result.status_code == 200 and result.json()['ok'] is False
    assert result.json()['usage'] is None and len(calls) == 1


def test_overview_separates_live_currencies_and_caps_recent_lists(order_data, client, administrator):
    from app.db import session_factory
    from app.models import now
    from app.billing_models import BillingOrder
    with session_factory()() as db:
        orders = list(db.scalars(select(BillingOrder).order_by(BillingOrder.id)))
        for index, order in enumerate(orders):
            order.created_at = now()
            order.paid_at = now()
            order.status = 'paid'
            order.environment = 'live' if index < 2 else 'test'
            order.currency = ['usd', 'jpy', 'usd'][index]
            order.total = [123, 456, 99999][index]
        db.commit()
    value = client.get('/v1/admin/monitor/overview', headers=administrator).json()
    assert {row['currency']: row['amount'] for row in value['commerce']['revenue_24h']} == {'usd': 123, 'jpy': 456}
    assert value['commerce']['orders_24h'] == 3
    assert len(value['commerce']['recent_orders']) <= 6 and len(value['recent_feedback']) <= 6
