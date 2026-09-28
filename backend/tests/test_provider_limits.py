"""Supplier upstream admission is shared; account business quotas stay separate."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from fastapi import HTTPException
import pytest
from sqlalchemy import func, select
from app import classic, comic_titles, translation_provider_limits
from app.adapters.llm import TextError, TextResponse
from admission_test_utils import window_count, window_members, milliseconds
from app import redis_state
from app.db import session_factory
from app.models import Job, TextCall, now
from app.scheduler import lock_scheduler
from app.translation_models import TranslationProvider
from app.translation_provider_limits import reserve_request
from conftest import login
from test_classic import SEGMENTS, text_case, text_database
from test_request_limits_migration import isolated_migration_database

TITLE = comic_titles.TitleTranslationRequest(name='A private test title', target_language='en')


def null_title(*args):
    return TextResponse('{"name":null,"target_language":null}', None, None)


def setup_limit(text_case, limit=1):
    with session_factory()() as db:
        job = db.get(Job, text_case[0])
        provider = db.get(TranslationProvider, job.config['text']['provider_id'])
        provider.requests_per_minute = limit
        db.commit()
        return job.owner_id, provider.id


@pytest.mark.parametrize('first', ['body', 'title'])
def test_body_and_title_share_upstream_budget(text_case, monkeypatch, first):
    owner_id, provider_id = setup_limit(text_case)
    monkeypatch.setattr(comic_titles, 'call_messages', null_title)
    if first == 'body':
        call_id = classic.reserve_call(*text_case, 0, SEGMENTS, 'en')[0]
        with pytest.raises(HTTPException) as error:
            comic_titles.query_title(TITLE, owner_id)
        assert error.value.status_code == 503
        assert error.value.detail['code'] == 'COMIC_TITLE_PROVIDER_BUSY'
        assert int(error.value.headers['Retry-After']) in (59, 60)
    else:
        comic_titles.query_title(TITLE, owner_id)
        with pytest.raises(TextError, match='TEXT_RATE_LIMITED'):
            classic.reserve_call(*text_case, 0, SEGMENTS, 'en')
        # A cache hit works even while this supplier has no upstream capacity.
        assert comic_titles.query_title(TITLE, owner_id).name is None
    with session_factory()() as db:
        requests = window_members('provider', provider_id)
        assert len(requests) == 1
        assert db.scalar(select(func.count()).select_from(TextCall)) == (1 if first == 'body' else 0)
        if first == 'body':
            assert list(requests) == [call_id]


def test_parallel_body_and_title_cannot_overbook_supplier(text_case, monkeypatch):
    owner_id, _ = setup_limit(text_case)
    monkeypatch.setattr(comic_titles, 'call_messages', null_title)
    barrier = Barrier(2)
    def run(purpose):
        barrier.wait(timeout=5)
        try:
            if purpose == 'body':
                classic.reserve_call(*text_case, 0, SEGMENTS, 'en')
            else:
                comic_titles.query_title(TITLE, owner_id)
            return 'admitted'
        except TextError as error:
            assert error.code == 'TEXT_RATE_LIMITED'
        except HTTPException as error:
            assert error.status_code == 503 and error.detail['code'] == 'COMIC_TITLE_PROVIDER_BUSY'
        return 'limited'
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(run, ['body', 'title'])) == ['admitted', 'limited']
    with session_factory()() as db:
        assert window_count('provider') == 1


def test_title_disabled_before_transport_reclaims_upstream_admission(text_case, monkeypatch):
    owner_id, provider_id = setup_limit(text_case)
    def disable(*args):
        from app.translation_providers import require_enabled
        with session_factory()() as db:
            lock_scheduler(db)
            db.get(TranslationProvider, provider_id).enabled = False
            db.commit()
            require_enabled(db, args[1])
    monkeypatch.setattr(comic_titles, 'call_messages', disable)
    with pytest.raises(HTTPException) as error:
        comic_titles.query_title(TITLE, owner_id)
    assert error.value.status_code == 502
    with session_factory()() as db:
        assert window_count('provider') == 0
        assert window_count('title', owner_id) == 1
        db.get(TranslationProvider, provider_id).enabled = True
        db.commit()
    monkeypatch.setattr(comic_titles, 'call_messages', null_title)
    assert comic_titles.query_title(TITLE, owner_id).name is None


def test_unknown_request_keeps_reservation_until_window_expires(text_case, monkeypatch):
    owner_id, provider_id = setup_limit(text_case)
    def interrupted(*args):
        raise TextError('TEXT_TRANSPORT_FAILED', 'Synthetic failure')
    monkeypatch.setattr(comic_titles, 'call_messages', interrupted)
    with pytest.raises(HTTPException) as error:
        comic_titles.query_title(TITLE, owner_id)
    assert error.value.status_code == 502
    with session_factory()() as db:
        previous_id, started = next(iter(window_members('provider', provider_id).items()))
        future = started + 61000
    with pytest.raises(HTTPException) as error:
        comic_titles.query_title(TITLE, owner_id)
    assert error.value.status_code == 503
    monkeypatch.setattr(redis_state, '_clock_ms', lambda: future)
    monkeypatch.setattr(comic_titles, 'call_messages', null_title)
    comic_titles.query_title(TITLE, owner_id)
    with session_factory()() as db:
        requests = window_members('provider', provider_id)
        assert len(requests) == 1 and previous_id not in requests
        assert list(requests.values()) == [future]


def test_supplier_cleanup_does_not_change_other_supplier_window(text_database):
    from translation_fixtures import configure_text_provider
    with session_factory()() as db:
        first = db.scalar(select(TranslationProvider))
        second = configure_text_provider(db)
        stale = now() - timedelta(minutes=2)
        redis_state.client().zadd(redis_state.key('provider', first.id), {'expired-first': milliseconds(stale)})
        redis_state.client().zadd(redis_state.key('provider', second.id), {'active-second': milliseconds(now())})
        db.commit()
        lock_scheduler(db)
        reserve_request(first)
        db.commit()
        assert 'expired-first' not in window_members('provider', first.id)
        assert 'active-second' in window_members('provider', second.id)


def test_redis_outage_pauses_text_without_spending_attempt_or_cost(text_case, monkeypatch):
    from test_redis_admission import break_redis
    from app import workers
    from app.queue_models import ExecutionLease, JobStage
    break_redis(monkeypatch)
    with pytest.raises(TextError) as failure:
        classic.reserve_call(*text_case, 0, SEGMENTS, 'en')
    assert failure.value.code == 'ADMISSION_UNAVAILABLE'
    workers.fail_stage(text_case[1], failure.value)
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(TextCall)) == 0
        lease = db.get(ExecutionLease, text_case[1])
        stage = db.get(JobStage, lease.stage_id)
        assert lease.completed_at is not None and stage.status == 'ready' and stage.attempts == 0
        assert stage.available_at > now()
        assert db.get(Job, text_case[0]).settlement == 'reserved'


def test_title_business_limit_counts_cached_requests_independently(client, monkeypatch):
    calls = []
    def translate(*args):
        calls.append(args)
        return null_title()
    monkeypatch.setattr(comic_titles, 'call_messages', translate)
    with session_factory()() as db:
        db.scalar(select(TranslationProvider)).requests_per_minute = 1
        db.commit()
    path, body = '/v1/comic-titles/translate', TITLE.model_dump()
    first, second = login(client, 'alice'), login(client, 'bob')
    for _ in range(30):
        assert client.post(path, headers=first, json=body).status_code == 200
    limited = client.post(path, headers=first, json=body)
    assert limited.status_code == 429 and limited.json()['error']['code'] == 'COMIC_TITLE_RATE_LIMITED'
    assert client.post(path, headers=second, json=body).status_code == 200
    upstream = client.post(path, headers=second, json={**body, 'name': 'An uncached name'})
    assert upstream.status_code == 503
    assert upstream.json()['error']['code'] == 'COMIC_TITLE_PROVIDER_BUSY' and upstream.headers['Retry-After']
    assert len(calls) == 1
    with session_factory()() as db:
        assert window_count('provider') == 1


def test_upgrade_drops_transient_tables_without_rewriting_durable_calls(isolated_migration_database):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text
    from app import db as database
    from app.models import Attempt, User
    from translation_fixtures import configure_text_provider
    database.initialize()
    at = now()
    with session_factory()() as db:
        provider = configure_text_provider(db)
        db.add(User(id='migration-owner', subject='migration-owner', name='Isolated'))
        db.flush()
        db.add(Job(id='migration-job', owner_id='migration-owner', mode='classic', target_language='en',
            idempotency_key='isolated-migration', operation='translate', request_hash='r' * 64,
            cache_key='c' * 64, config={}, quota_pages=0, quota_kind='unlimited'))
        db.flush()
        db.add(Attempt(id='migration-attempt', job_id='migration-job', provider_id=provider.id,
            lease_expires_at=at + timedelta(minutes=1)))
        db.flush()
        for index, (name, error, started) in enumerate([
                ('recent-call', None, at), ('upstream-429', 'TEXT_RATE_LIMITED', at),
                ('old-call', None, at - timedelta(minutes=2)),
                ('disabled-call', 'TEXT_PROVIDER_DISABLED', at)]):
            db.add(TextCall(id=name, job_id='migration-job', attempt_id='migration-attempt',
                provider_id=provider.id, model='isolated', group_index=0, sequence=index + 1,
                reserved_micros=0, accounted_micros=0, error_code=error, started_at=started))
        db.commit()
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / 'alembic.ini'))
    config.set_main_option('script_location', str(root / 'migrations'))
    with isolated_migration_database.begin() as connection:
        config.attributes['connection'] = connection
        command.downgrade(config, 'comic_titles_0002')
        before = connection.execute(text('SELECT * FROM text_calls ORDER BY id')).all()
        command.upgrade(config, 'head')
        assert connection.execute(text('SELECT * FROM text_calls ORDER BY id')).all() == before
        from sqlalchemy import inspect
        assert 'translation_provider_requests' not in inspect(connection).get_table_names()
        assert window_count('provider') == 0
