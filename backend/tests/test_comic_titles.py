from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
import json
import pytest
from conftest import login
from app import comic_titles, comic_title_limits
from app.adapters.llm import TextResponse, TextError

URL = '/v1/comic-titles/translate'
BODY = {'name': '进击的巨人', 'target_language': 'en-US'}


@pytest.fixture
def model(monkeypatch):
    calls = []
    def translate(messages, profile):
        calls.append((messages, profile))
        return TextResponse('{"name":"Attack on Titan","target_language":"en"}', None, None)
    monkeypatch.setattr(comic_titles, 'call_messages', translate)
    return calls


def test_login_and_free_translation_without_quota(client, model):
    assert client.post(URL, json=BODY).status_code == 401
    auth = login(client)
    before = client.get('/v1/me/usage', headers=auth).json()
    response = client.post(URL, headers=auth, json=BODY)
    assert response.status_code == 200, response.text
    assert response.json() == {'name': 'Attack on Titan', 'target_language': 'en'}
    after = client.get('/v1/me/usage', headers=auth).json()
    assert after['items'] == before['items'] == []
    for mode in ('classic', 'redraw'):
        assert after['entitlements']['modes'][mode]['quota'] == before['entitlements']['modes'][mode]['quota']
    assert json.loads(model[0][0][1]['content']) == BODY
    assert 'comic title' in model[0][0][0]['content']


@pytest.mark.parametrize('name', ['', '   ', '漫' * 61, 'a\n', '\x00', '\ud800', 123])
def test_invalid_names(client, model, name):
    assert client.post(URL, headers={**login(client), 'Content-Type': 'application/json'}, content=json.dumps({**BODY, 'name': name})).status_code == 422
    assert model == []


@pytest.mark.parametrize('code', ['zh-TW', 'zh-HK', 'zh-Hans-TW', 'zh', 'pt-PT', 'EN-gb', 'ja', 'nl', 'xx'])
def test_language_passed_unchanged_and_model_selects_response(client, model, code):
    result = client.post(URL, headers=login(client), json={'name': '漫' * 60, 'target_language': code})
    assert result.status_code == 200
    assert result.json()['target_language'] == 'en'
    assert json.loads(model[0][0][1]['content'])['target_language'] == code


@pytest.mark.parametrize('code', ['en; ignore instructions', '', 'en_US', 'a' * 36])
def test_invalid_language(client, model, code):
    assert client.post(URL, headers=login(client), json={**BODY, 'target_language': code}).status_code == 422
    assert model == []


def test_rolling_limit_isolation_and_recovery(client, model, monkeypatch):
    at = datetime(2026, 1, 1)
    monkeypatch.setattr(comic_title_limits, 'server_now', lambda db: at)
    auth = login(client)
    for _ in range(30):
        assert client.post(URL, headers=auth, json=BODY).status_code == 200
    at += timedelta(seconds=59)
    denied = client.post(URL, headers=auth, json=BODY)
    assert denied.status_code == 429
    assert denied.headers['Retry-After'] == '1'
    assert len(model) == 1
    assert client.post(URL, headers=login(client, 'bob'), json=BODY).status_code == 200
    at += timedelta(seconds=1)
    for _ in range(30):
        assert client.post(URL, headers=auth, json=BODY).status_code == 200


def test_concurrent_admissions_are_bounded(client, model):
    auth = login(client)
    with ThreadPoolExecutor(max_workers=8) as pool:
        statuses = list(pool.map(lambda _: client.post(URL, headers=auth, json=BODY).status_code, range(40)))
    assert statuses.count(200) == 30
    assert statuses.count(429) == 10
    assert len(model) == 1


def test_diagnostics_separate_completed_title_requests_from_active_leases(client, model, monkeypatch):
    from app.db import session_factory
    from app.translation_requests import ControlAdmission
    at = datetime(2026, 1, 1)
    monkeypatch.setattr(comic_title_limits, 'server_now', lambda db: at)
    auth, admin = login(client), login(client, 'admin')
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    path = '/v1/admin/operations/users/' + owner
    for _ in range(3):
        assert client.post(URL, headers=auth, json=BODY).status_code == 200
        at += timedelta(seconds=1)
    response = client.get(path, headers=admin)
    assert response.status_code == 200
    data = response.json()
    assert data['controls'] == []
    assert data['comic_title_budget'] == {'window_seconds': 60, 'limit': 30, 'used': 3,
        'remaining': 27, 'retry_after_seconds': 0, 'last_request_at': '2026-01-01T00:00:02Z'}
    assert 'request_times' not in response.text
    with session_factory()() as db:
        assert db.get(ControlAdmission, (owner, 'comic_title')) is None
    at += timedelta(seconds=60)
    cleared = client.get(path, headers=admin).json()['comic_title_budget']
    assert cleared['used'] == 0 and cleared['remaining'] == 30
    assert cleared['last_request_at'] == '2026-01-01T00:00:02Z'


@pytest.mark.parametrize('failure', ['transport', 'malformed'])
def test_failed_model_calls_consume_rate_budget(client, monkeypatch, failure):
    def fail(*args, **kwargs):
        if failure == 'transport':
            raise TextError('TEXT_TRANSPORT_FAILED', 'private upstream error')
        return TextResponse('not a translation', None, None)
    monkeypatch.setattr(comic_titles, 'call_messages', fail)
    auth = login(client)
    for _ in range(30):
        result = client.post(URL, headers=auth, json=BODY)
        assert result.status_code == 502
        assert 'private upstream' not in result.text
    assert client.post(URL, headers=auth, json=BODY).status_code == 429


@pytest.mark.parametrize('protocol', ['chat_completions', 'responses'])
def test_real_adapter_payload_with_mock_transport(client, monkeypatch, protocol):
    import httpx
    import json
    from app.adapters import openai_text
    from app.db import session_factory
    from app.translation_providers import provider_profile
    from translation_fixtures import configure_text_provider
    with session_factory()() as db:
        profile = provider_profile(db, purpose='comic_title')
        configure_text_provider(db, profile['provider_id'], protocol=protocol)
    calls = []
    def handler(request):
        payload = json.loads(request.content)
        messages = payload['messages' if protocol == 'chat_completions' else 'input']
        assert messages[0] == {'role': 'system', 'content': comic_titles.TITLE_INSTRUCTIONS}
        assert messages[1]['role'] == 'user' and json.loads(messages[1]['content']) == BODY
        assert 'translations[' not in request.content.decode()
        calls.append(request.url.path)
        content = '{"name":"Attack on Titan","target_language":"en"}'
        response = {'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}]} if protocol == 'chat_completions' else {
            'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': content}]}]}
        return httpx.Response(200, json=response)
    monkeypatch.setattr(openai_text, 'CheckedTransport', lambda: httpx.MockTransport(handler))
    result = client.post(URL, headers=login(client), json=BODY)
    assert result.status_code == 200, result.text
    assert result.json()['name'] == 'Attack on Titan'
    assert calls == ['/v1/chat/completions' if protocol == 'chat_completions' else '/v1/responses']


@pytest.mark.parametrize('language,name', [('zh-Hant', '進擊的巨人'), ('ja', '進撃の巨人'), ('ko', '진격의 거인')])
def test_model_localized_title_and_language_are_preserved(client, monkeypatch, language, name):
    def translate(*args, **kwargs):
        return TextResponse(json.dumps({'name': name, 'target_language': language}), None, None)
    monkeypatch.setattr(comic_titles, 'call_messages', translate)
    result = client.post(URL, headers=login(client), json={**BODY, 'target_language': language})
    assert result.json() == {'name': name, 'target_language': language}


def test_invalid_model_language_is_gateway_error(client, monkeypatch):
    monkeypatch.setattr(comic_titles, 'call_messages', lambda *args, **kwargs: TextResponse(
        '{"name":"Attack on Titan","target_language":"English"}', None, None))
    assert client.post(URL, headers=login(client), json=BODY).status_code == 502


@pytest.mark.parametrize('state', ['disabled', 'unselected'])
def test_missing_title_provider_never_falls_back_to_body(client, model, state):
    from sqlalchemy import update
    from app.db import session_factory
    from app.translation_models import TranslationProvider
    with session_factory()() as db:
        db.execute(update(TranslationProvider).values(**({'enabled': False} if state == 'disabled' else {'is_title_default': False})))
        db.commit()
    response = client.post(URL, headers=login(client), json=BODY)
    assert response.status_code == 503 and '漫画名' in response.text
    assert model == []


def test_no_known_title(client, monkeypatch):
    monkeypatch.setattr(comic_titles, 'call_messages', lambda *a, **kw: TextResponse(
        '{"name":null,"target_language":null}', None, None))
    result = client.post(URL, headers=login(client), json=BODY)
    assert result.status_code == 200
    assert result.json() == {'name': None, 'target_language': None}


@pytest.mark.parametrize('content', ['{}', '[]', '{"name":null,"target_language":"en"}',
    '{"name":"Title","target_language":null}', '{"name":" ","target_language":"en"}',
    '{"name":123,"target_language":"en"}', '{"name":"Title","target_language":"en","extra":true}',
    '```json\n{"name":null,"target_language":null}\n```'])
def test_invalid_model_output_rejected(client, monkeypatch, content):
    monkeypatch.setattr(comic_titles, 'call_messages', lambda *a, **kw: TextResponse(content, None, None))
    assert client.post(URL, headers=login(client), json=BODY).status_code == 502


@pytest.mark.parametrize('failed', [False, True])
def test_slow_queries_have_bounded_capacity_and_leave_api_responsive(client, monkeypatch, failed):
    import threading
    from sqlalchemy import func, select
    from app.comic_title_cache import TitleRecord
    from app.db import session_factory
    from app.comic_title_limits import TitleAdmission
    entered, release, lock = threading.Event(), threading.Event(), threading.Lock()
    calls = []
    auths = [login(client, 'reader-a'), login(client, 'reader-b')]

    def slow_model(*args):
        with lock:
            calls.append(threading.current_thread().name)
            if len(calls) == comic_titles.EXECUTION_SLOTS:
                entered.set()
        assert release.wait(15)
        if failed:
            raise TextError('TEXT_TRANSPORT_FAILED', 'isolated failure')
        return TextResponse('{"name":null,"target_language":null}', None, None)

    monkeypatch.setattr(comic_titles, 'call_messages', slow_model)
    def query(index):
        return client.post(URL, headers=auths[index % 2], json={**BODY, 'name': f'Comic {index}'})

    with ThreadPoolExecutor(max_workers=40) as pool:
        accepted = [pool.submit(query, i) for i in range(comic_titles.EXECUTION_SLOTS)]
        try:
            assert entered.wait(5)
            rejected = [pool.submit(query, i) for i in range(comic_titles.EXECUTION_SLOTS, 40)]
            for future in rejected:
                response = future.result(timeout=5)
                assert response.status_code == 503
                assert response.json()['error']['code'] == 'COMIC_TITLE_BUSY'
                assert response.headers['Retry-After'] == '1'
            # Includes an authenticated endpoint that also needs DB/API worker threads.
            assert pool.submit(client.get, '/health/live').result(timeout=2).status_code == 200
            assert pool.submit(client.get, '/v1/me', headers=auths[0]).result(timeout=2).status_code == 200
            with session_factory()() as db:
                assert db.scalar(select(func.count()).select_from(TitleRecord)) == comic_titles.EXECUTION_SLOTS
                counts = [len(row.request_times) for row in db.scalars(select(TitleAdmission))]
                assert sorted(counts) == [4, 4]  # Overload rejection does not consume account rate budget.
        finally:
            release.set()
        assert all(f.result(timeout=5).status_code == (502 if failed else 200) for f in accepted)
    assert len(calls) == comic_titles.EXECUTION_SLOTS
    assert all(name.startswith('comic-title') for name in calls)
    # Success and failure both release execution capacity.
    assert query(40).status_code == (502 if failed else 200)


def test_cancelled_waiter_retains_capacity_until_worker_finishes(monkeypatch):
    import asyncio
    import threading
    from fastapi import HTTPException
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    def work(*args):
        entered.set()
        assert release.wait(5)
        return 'complete'
    monkeypatch.setattr(comic_titles, 'query_title', work)
    executor = comic_titles.TitleExecutor(capacity=1)

    async def run():
        task = asyncio.create_task(executor.run(None, 'owner'))
        assert await asyncio.to_thread(entered.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        with pytest.raises(HTTPException) as busy:
            await executor.run(None, 'owner')
        assert busy.value.detail['code'] == 'COMIC_TITLE_BUSY'
        release.set()
        # A barrier submitted to the single worker runs after its completion callback.
        await asyncio.wrap_future(executor.pool.submit(finished.set))
        assert await executor.run(None, 'owner') == 'complete'

    try:
        asyncio.run(run())
    finally:
        release.set()
        executor.close()
