"""Anonymous submission, durable retries and administrator-only visibility."""
from uuid import uuid4
from datetime import timedelta
import pytest
from sqlalchemy import func, select
from conftest import login


def submit(client, key=None, **values):
    return client.post('/v1/support-requests', headers={'Idempotency-Key': key or str(uuid4())},
        json={'kind': 'website', 'site_name': 'Example Comics', 'url': 'https://comics.example/read/1?token=private#page', 'comment': 'Canvas reader', **values})


def test_anonymous_submit_replay_and_admin_visibility(client):
    from app.db import session_factory
    from app.support_requests import SupportRequest, SupportRequestAdmission
    key = str(uuid4())
    first = submit(client, key)
    assert first.status_code == 201
    assert set(first.json()) == {'id', 'created_at'}
    assert submit(client, key).json() == first.json()
    assert submit(client, key, comment='Changed payload').status_code == 409
    assert client.get('/v1/admin/support-requests?kind=website').status_code == 401
    assert client.get('/v1/admin/support-requests?kind=website', headers=login(client, 'reader')).status_code == 403
    page = client.get('/v1/admin/support-requests?kind=website', headers=login(client, 'admin')).json()
    assert page['total'] == 1
    assert page['items'][0]['url'] == 'https://comics.example/read/1'
    assert page['items'][0]['comment'] == 'Canvas reader'
    assert 'idempotency_key' not in page['items'][0]
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(SupportRequest)) == 1
        assert db.scalar(select(SupportRequestAdmission)).day_count == 1


@pytest.mark.parametrize('url', ['javascript:alert(1)', 'file:///a', 'https://user:pass@comics.example/',
    'http://127.0.0.1/', 'http://localhost/', 'http://192.168.1.1/', 'https://comics.example:wrong/',
    'https://comics.example/\npath', 'https://comics.example\\@localhost/'])
def test_rejects_unsafe_or_invalid_urls(client, url):
    assert submit(client, url=url).status_code == 422


def test_validation_and_body_bound(client):
    assert submit(client, site_name='   ').status_code == 422
    assert submit(client, comment='a' * 1001).status_code == 422
    assert submit(client, contact='a' * 201).status_code == 422
    assert submit(client, key='not-a-uuid').status_code == 422
    assert submit(client, comment='a' * 20000).status_code == 413


def test_rate_limits_replay_and_refill(client, monkeypatch):
    from app import support_requests
    clock = [support_requests.now()]
    monkeypatch.setattr(support_requests, 'now', lambda: clock[0])
    key = str(uuid4())
    assert submit(client, key).status_code == 201
    for _ in range(4):
        assert submit(client).status_code == 201
    limited = submit(client)
    assert limited.status_code == 429 and int(limited.headers['Retry-After']) > 0
    assert submit(client, key).status_code == 201
    for _ in range(3):
        clock[0] += timedelta(seconds=61)
        for _ in range(5):
            assert submit(client).status_code == 201
    clock[0] += timedelta(seconds=61)
    assert submit(client).status_code == 429
    clock[0] += timedelta(days=1)
    assert submit(client).status_code == 201


def test_admin_pagination(client):
    for index in range(3):
        assert submit(client, site_name=f'Site {index}').status_code == 201
    auth = login(client, 'admin')
    first = client.get('/v1/admin/support-requests?kind=website&limit=2', headers=auth).json()
    second = client.get('/v1/admin/support-requests?kind=website&offset=2&limit=2', headers=auth).json()
    assert first['total'] == 3 and first['next_offset'] == 2
    assert second['next_offset'] is None
    assert len({row['id'] for row in first['items'] + second['items']}) == 3


def test_plugin_feedback_contact_and_kind_isolation(client):
    key = str(uuid4())
    body = {'kind': 'plugin', 'comment': '合成反馈：按钮不响应', 'contact': ' 任意联系方法：fixture QQ / 微信 / email@example.test '}
    first = client.post('/v1/support-requests', headers={'Idempotency-Key': key}, json=body)
    assert first.status_code == 201 and 'contact' not in first.json()
    assert client.post('/v1/support-requests', headers={'Idempotency-Key': key}, json=body).json() == first.json()
    assert client.post('/v1/support-requests', headers={'Idempotency-Key': str(uuid4())}, json={**body, 'comment': ' '}).status_code == 422
    assert submit(client, contact='test-only arbitrary handle').status_code == 201
    auth = login(client, 'admin')
    plugin = client.get('/v1/admin/support-requests?kind=plugin', headers=auth).json()
    websites = client.get('/v1/admin/support-requests?kind=website', headers=auth).json()
    assert plugin['total'] == websites['total'] == 1
    assert plugin['items'][0]['contact'] == body['contact'].strip()
    assert websites['items'][0]['contact'] == 'test-only arbitrary handle'
    assert client.get('/v1/admin/support-requests?kind=plugin').status_code == 401


def test_concurrent_replays_create_one_receipt(client):
    from concurrent.futures import ThreadPoolExecutor
    from app.db import session_factory
    from app.support_requests import SupportRequest, SupportRequestAdmission
    key = str(uuid4())
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: submit(client, key), range(4)))
    assert all(result.status_code == 201 for result in results)
    assert len({result.json()['id'] for result in results}) == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(SupportRequest)) == 1
        assert db.scalar(select(SupportRequestAdmission)).day_count == 1
