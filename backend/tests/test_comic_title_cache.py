from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import json
import threading
import time
import pytest
from sqlalchemy import event, select, update
from conftest import login
from app import comic_titles, comic_title_cache as cache
from app.adapters.llm import TextResponse, TextError
from app.db import session_factory, engine
from app.models import now
from app.translation_models import TranslationProvider

URL = '/v1/comic-titles/translate'


@pytest.fixture
def model(monkeypatch):
    calls = []
    names = {'en': 'Attack on Titan', 'ja': '進撃の巨人', 'zh-Hans': '进击的巨人'}
    def translate(messages, profile):
        body = json.loads(messages[1]['content'])
        language = body['target_language']
        calls.append((body['name'], language))
        name = names.get(language)
        return TextResponse(json.dumps({'name': name, 'target_language': language if name else None}), None, None)
    monkeypatch.setattr(comic_titles, 'call_messages', translate)
    return calls


def query(client, auth, name='进击的巨人', language='en'):
    return client.post(URL, headers=auth, json={'name': name, 'target_language': language})


def test_aliases_link_all_known_languages_and_survive_reconnect(client, model):
    auth = login(client)
    assert query(client, auth).json()['name'] == 'Attack on Titan'
    assert query(client, auth, language='ja').json()['name'] == '進撃の巨人'
    engine().dispose()
    for source in ('进击的巨人', 'Attack on Titan', '進撃の巨人'):
        assert query(client, auth, source, 'ja').json()['name'] == '進撃の巨人'
        assert query(client, auth, source, 'en').json()['name'] == 'Attack on Titan'
    assert len(model) == 2


def test_null_is_cached_but_not_assumed_for_other_languages(client, model):
    auth = login(client)
    for _ in range(3):
        assert query(client, auth, '虚构漫画', 'fr').json() == {'name': None, 'target_language': None}
    assert len(model) == 1
    assert query(client, auth, '虚构漫画', 'en').json()['name'] == 'Attack on Titan'
    assert len(model) == 2
    assert query(client, auth, 'Attack on Titan', 'fr').json()['name'] is None
    assert len(model) == 2


def test_requested_and_actual_language_both_cached_without_locale_mapping(client, monkeypatch):
    calls = []
    def translate(*args, **kwargs):
        calls.append(1)
        return TextResponse('{"name":"Frieren: Beyond Journey\'s End","target_language":"en"}', None, None)
    monkeypatch.setattr(comic_titles, 'call_messages', translate)
    auth = login(client)
    for source, language in [('葬送的芙莉莲', 'nl'), ('Frieren: Beyond Journey\'s End', 'nl'),
                             ('Frieren: Beyond Journey\'s End', 'en'), ('葬送的芙莉莲', 'EN')]:
        assert query(client, auth, source, language).json()['target_language'] == 'en'
    assert len(calls) == 1
    assert query(client, auth, language='en-US').status_code == 200
    assert len(calls) == 2  # Locale suitability is still an LLM decision.


def test_shared_cache_keeps_only_generator_id_and_requires_login(client, model):
    alice, bob = login(client), login(client, 'bob')
    assert query(client, alice).status_code == 200
    assert query(client, {}).status_code == 401
    assert query(client, bob).status_code == 200
    assert len(model) == 1
    alice_id = client.get('/v1/me', headers=alice).json()['user']['id']
    with session_factory()() as db:
        assert db.scalar(select(cache.TitleRecord)).created_by == alice_id


def test_cached_result_available_without_provider(client, model):
    auth = login(client)
    assert query(client, auth).status_code == 200
    with session_factory()() as db:
        db.execute(update(TranslationProvider).values(enabled=False))
        db.commit()
    assert query(client, auth).status_code == 200
    assert query(client, auth, language='ja').status_code == 503
    with session_factory()() as db:
        assert not db.scalar(select(cache.TitleRecord).where(cache.TitleRecord.ready.is_(False)))


@pytest.mark.parametrize('bad', ['malformed', 'transport'])
def test_failures_not_cached_and_reservation_released(client, monkeypatch, bad):
    calls = []
    def translate(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            if bad == 'transport':
                raise TextError('TEXT_TRANSPORT_FAILED', 'test')
            return TextResponse('not JSON', None, None)
        return TextResponse('{"name":null,"target_language":null}', None, None)
    monkeypatch.setattr(comic_titles, 'call_messages', translate)
    auth = login(client)
    assert query(client, auth).status_code == 502
    assert query(client, auth).json() == {'name': None, 'target_language': None}
    assert query(client, auth).status_code == 200
    assert len(calls) == 2


@pytest.mark.parametrize('negative', [False, True])
def test_concurrent_identical_requests_call_model_once(client, monkeypatch, negative):
    entered, release = threading.Event(), threading.Event()
    calls = []
    def translate(*args, **kwargs):
        calls.append(1)
        entered.set()
        assert release.wait(5)
        value = {'name': None, 'target_language': None} if negative else {'name': 'Attack on Titan', 'target_language': 'en'}
        return TextResponse(json.dumps(value), None, None)
    monkeypatch.setattr(comic_titles, 'call_messages', translate)
    users = [login(client, 'reader-' + str(i)) for i in range(8)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(query, client, auth) for auth in users]
        assert entered.wait(5)
        time.sleep(0.15)
        release.set()
        results = [f.result(timeout=10) for f in futures]
    assert all(r.status_code == 200 for r in results)
    assert len(calls) == 1
    with session_factory()() as db:
        records = list(db.scalars(select(cache.TitleRecord)))
        assert len(records) == 1 and records[0].created_by is not None


def test_expired_lease_recovers_and_late_writer_cannot_replace(client, model):
    auth = login(client)
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    _, old = cache.lookup_or_claim('进击的巨人', 'en')
    with session_factory()() as db:
        row = db.scalar(select(cache.TitleRecord).where(cache.TitleRecord.token == old))
        row.lease_until = now() - timedelta(seconds=1)
        db.commit()
    assert query(client, auth).json()['name'] == 'Attack on Titan'
    cache.save_result(owner, old, comic_titles.TitleTranslationResponse(name=None, target_language=None))
    assert query(client, auth).json()['name'] == 'Attack on Titan'
    assert len(model) == 1


def test_busy_lease_returns_retry_without_duplicate_call(client, model, monkeypatch):
    auth = login(client)
    cache.lookup_or_claim('进击的巨人', 'en')
    monkeypatch.setattr(cache, 'WAIT_SECONDS', 0)
    response = query(client, auth)
    assert response.status_code == 503
    assert response.headers['Retry-After'] == '1'
    assert model == []


def test_output_lookup_reuses_records_without_rewriting_them(client, model):
    auth = login(client)
    assert query(client, auth, '进击的巨人', 'ja').status_code == 200
    assert query(client, auth, 'Attack on Titan', 'en').status_code == 200
    assert query(client, auth, '進撃の巨人', 'en').status_code == 200
    assert query(client, auth, 'Attack on Titan', 'ja').json()['name'] == '進撃の巨人'
    assert len(model) == 3
    with session_factory()() as db:
        assert len(list(db.scalars(select(cache.TitleRecord)))) == 3


def test_similar_names_are_not_aliases(client, model):
    auth = login(client)
    query(client, auth, 'Title', 'en')
    query(client, auth, 'title', 'en')
    assert len(model) == 2


def test_shared_negative_cache_keeps_original_generator(client, model):
    alice, bob = login(client), login(client, 'bob')
    for auth in (alice, bob):
        assert query(client, auth, '虚构漫画', 'fr').json() == {'name': None, 'target_language': None}
    assert len(model) == 1
    with session_factory()() as db:
        rows = list(db.scalars(select(cache.TitleRecord)))
        assert len(rows) == 1
        assert rows[0].created_by == client.get('/v1/me', headers=alice).json()['user']['id']


def test_conflicting_mapping_records_are_preserved(client, monkeypatch):
    replies = iter([('First Title', 'en'), ('Second Title', 'en'), ('Common Name', 'ja'), ('Common Name', 'ja')])
    def translate(*args, **kwargs):
        name, language = next(replies)
        return TextResponse(json.dumps({'name': name, 'target_language': language}), None, None)
    monkeypatch.setattr(comic_titles, 'call_messages', translate)
    auth = login(client)
    for name, language in [('原名一', 'en'), ('原名二', 'en'), ('原名一', 'ja'), ('原名二', 'ja')]:
        assert query(client, auth, name, language).status_code == 200
    assert query(client, auth, '原名一', 'en').json()['name'] == 'First Title'
    assert query(client, auth, '原名二', 'en').json()['name'] == 'Second Title'
    with session_factory()() as db:
        assert len(list(db.scalars(select(cache.TitleRecord)))) == 4
        assert cache.find_related(db, cache.name_key('Common Name'), 'en') is None


def test_cache_hit_has_constant_sql_cost(client, model):
    auth = login(client)
    query(client, auth)
    statements = []
    def track(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    event.listen(engine(), 'before_cursor_execute', track)
    try:
        cached, claim = cache.lookup_or_claim('进击的巨人', 'en')
    finally:
        event.remove(engine(), 'before_cursor_execute', track)
    assert cached['name'] == 'Attack on Titan' and claim is None
    assert len(statements) == 1
    assert statements[0].lstrip().upper().startswith('SELECT')


def test_output_chain_and_concurrent_results_keep_separate_records(client):
    alice, bob = login(client), login(client, 'bob')
    a = client.get('/v1/me', headers=alice).json()['user']['id']
    b = client.get('/v1/me', headers=bob).json()['user']['id']
    _, first = cache.lookup_or_claim('原名', 'en')
    _, second = cache.lookup_or_claim('Existing Title', 'ja')
    cache.save_result(a, first, comic_titles.TitleTranslationResponse(name='Existing Title', target_language='en'))
    cache.save_result(b, second, comic_titles.TitleTranslationResponse(name='既存作品', target_language='ja'))
    _, third = cache.lookup_or_claim('既存作品', 'fr')
    cache.save_result(b, third, comic_titles.TitleTranslationResponse(name='Titre existant', target_language='fr'))
    result, claim = cache.lookup_or_claim('原名', 'fr')
    assert result == {'name': 'Titre existant', 'target_language': 'fr'} and claim is None
    result, claim = cache.lookup_or_claim('Titre existant', 'en')
    assert result == {'name': 'Existing Title', 'target_language': 'en'} and claim is None
    with session_factory()() as db:
        rows = list(db.scalars(select(cache.TitleRecord)))
        assert len(rows) == 3
        assert {row.input_name: row.created_by for row in rows} == {'原名': a, 'Existing Title': b, '既存作品': b}


def test_pending_poll_is_read_only(client, monkeypatch):
    cache.lookup_or_claim('原名', 'en')
    monkeypatch.setattr(cache, 'WAIT_SECONDS', 0)
    statements = []
    def track(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    event.listen(engine(), 'before_cursor_execute', track)
    try:
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as error:
            cache.lookup_or_claim('原名', 'en')
        assert error.value.status_code == 503
    finally:
        event.remove(engine(), 'before_cursor_execute', track)
    assert all(sql.lstrip().upper().startswith(('SELECT', 'WITH')) for sql in statements)


def test_live_slow_transport_renews_lease_and_cannot_be_claimed_twice(client, monkeypatch):
    from datetime import datetime
    from types import SimpleNamespace
    import httpx
    from app.adapters import images, openai_text
    from app.translation_providers import provider_profile
    from translation_fixtures import configure_text_provider
    auth = login(client)
    with session_factory()() as db:
        configure_text_provider(db, provider_profile(db, purpose='comic_title')['provider_id'], timeout_seconds=180)
    base, clock = datetime(2026, 1, 1), [0]
    monkeypatch.setattr(cache, 'server_now', lambda db: base + timedelta(seconds=clock[0]))
    monkeypatch.setattr(cache, 'HEARTBEAT_SECONDS', 0.01)
    monkeypatch.setattr(cache, 'WAIT_SECONDS', 0)
    for module in (images, openai_text):
        monkeypatch.setattr(module, 'time', SimpleNamespace(monotonic=lambda: clock[0]))
    renewed, reading, release = threading.Event(), threading.Event(), threading.Event()
    original_renew = cache.renew_claim
    def renew(claim):
        at = clock[0]
        result = original_renew(claim)
        if at == 150 and result:
            renewed.set()
        return result
    monkeypatch.setattr(cache, 'renew_claim', renew)
    calls = []
    class SlowBody(httpx.SyncByteStream):
        def __iter__(self):
            assert renewed.wait(3)
            clock[0] = 220  # Beyond the original 210-second lease, within the body read timeout.
            reading.set()
            assert release.wait(5)
            yield json.dumps({'choices': [{'message': {'content': '{"name":"Existing Title","target_language":"en"}'},
                'finish_reason': 'stop'}]}).encode()
    def handler(request):
        calls.append(1)
        assert request.extensions['timeout']['read'] == 180
        clock[0] = 150  # Headers arrive within the per-read timeout.
        return httpx.Response(200, stream=SlowBody())
    monkeypatch.setattr(openai_text, 'CheckedTransport', lambda: httpx.MockTransport(handler))
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(query, client, auth)
        try:
            assert reading.wait(4)
            second = pool.submit(query, client, auth).result(timeout=3)
            assert second.status_code == 503
            assert second.json()['error']['code'] == 'COMIC_TITLE_PENDING'
        finally:
            release.set()
        assert first.result(timeout=5).json()['name'] == 'Existing Title'
    assert query(client, auth).json()['name'] == 'Existing Title'
    assert len(calls) == 1
    with session_factory()() as db:
        row = db.scalar(select(cache.TitleRecord))
        assert row.ready and row.token is None and row.lease_until is None


def test_expired_claim_cannot_be_renewed_or_published(client, monkeypatch):
    from datetime import datetime
    at = datetime(2026, 1, 1)
    monkeypatch.setattr(cache, 'server_now', lambda db: at)
    _, old = cache.lookup_or_claim('原名', 'en')
    at += timedelta(seconds=cache.LEASE_SECONDS + 1)
    result = comic_titles.TitleTranslationResponse(name='Existing Title', target_language='en')
    assert not cache.renew_claim(old)
    assert not cache.save_result(None, old, result)
    _, new = cache.lookup_or_claim('原名', 'en')
    assert new != old
    assert not cache.renew_claim(old)
    cache.release_claim(old)
    assert cache.renew_claim(new)
    assert cache.save_result(None, new, result)


def test_expired_execution_does_not_return_uncommitted_result(client, monkeypatch):
    from datetime import datetime
    at = datetime(2026, 1, 1)
    monkeypatch.setattr(cache, 'server_now', lambda db: at)
    def lose_lease(*args):
        nonlocal at
        at += timedelta(seconds=cache.LEASE_SECONDS + 1)
        return TextResponse('{"name":"Stale result","target_language":"en"}', None, None)
    monkeypatch.setattr(comic_titles, 'call_messages', lose_lease)
    response = query(client, login(client))
    assert response.status_code == 503
    assert response.json()['error']['code'] == 'COMIC_TITLE_LEASE_LOST'
    with session_factory()() as db:
        assert db.scalar(select(cache.TitleRecord)) is None
