"""Redis atomicity, expiry, isolation and dependency failures, without upstream requests."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from types import SimpleNamespace
import os
import subprocess
import sys
import pytest
from redis import ConnectionError
from sqlalchemy import func, select
from app import redis_state
from app.adapters.llm import TextError
from app.translation_provider_limits import reserve_request
from admission_test_utils import freeze_clock, window_count
from conftest import login, request_id


def test_parallel_reservations_and_duplicate_token_are_atomic(redis_client):
    barrier = Barrier(32)
    def attempt(index):
        barrier.wait(timeout=10)
        return redis_state.window('image', 'owner', 7, member=str(index))['retry_after_seconds'] == 0
    with ThreadPoolExecutor(32) as pool:
        assert sum(pool.map(attempt, range(32))) == 7
    assert window_count('image', 'owner') == 7
    member = redis_client.zrange(redis_state.key('image', 'owner'), 0, 0)[0]
    assert redis_state.window('image', 'owner', 7, member=member)['retry_after_seconds'] == 0
    assert window_count('image', 'owner') == 7
    assert redis_state.window('image', 'another', 7, member=member)['remaining'] == 6
    assert 0 < redis_client.pttl(redis_state.key('image', 'owner')) <= 60000


def test_different_processes_share_the_same_supplier_window(redis_client):
    if not os.environ.get('TEST_REDIS_URL'):
        pytest.skip('Requires TEST_REDIS_URL to an isolated Redis 8 service')
    code = """from concurrent.futures import ThreadPoolExecutor
from app.redis_state import window
with ThreadPoolExecutor(8) as pool:
    results = list(pool.map(lambda i: not window('provider', 'shared', 7, member=__import__('uuid').uuid4().hex)['retry_after_seconds'], range(20)))
print(sum(results))
"""
    children = [subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0) for _ in range(3)]
    try:
        outputs = [child.communicate(timeout=20) for child in children]
        assert all(child.returncode == 0 for child in children), [error for _, error in outputs]
        assert sum(int(output.strip()) for output, _ in outputs) == 7
        assert window_count('provider', 'shared') == 7
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)


def test_short_new_lease_does_not_expire_an_existing_long_lease(redis_client, monkeypatch):
    from app.models import now
    freeze_clock(monkeypatch, [now()])
    redis_state.bucket('control', 'owner', 300, 30, member='long', concurrency=2, lease_seconds=60)
    redis_state.bucket('control', 'owner', 300, 30, member='short', concurrency=2, lease_seconds=15)
    assert redis_client.pttl(redis_state.key('control-leases', 'owner')) > 59000
    assert not redis_state.bucket('control', 'owner', 300, 30, member='third', concurrency=2)['allowed']


def test_expired_execution_slot_rejects_old_renewal_and_release(monkeypatch):
    clock = [100000]
    monkeypatch.setattr(redis_state, '_clock_ms', lambda: clock[0])
    keys = [redis_state.key('test-execution')]
    assert redis_state.run('slots', keys, 'acquire', 'old', 1, 1000) == 1
    clock[0] += 1001
    assert redis_state.run('slots', keys, 'acquire', 'new', 1, 1000) == 1
    assert redis_state.run('slots', keys, 'renew', 'old', 1, 1000) == 0
    assert redis_state.run('slots', keys, 'release', 'old', 1, 1000) == 0
    assert redis_state.run('slots', keys, 'acquire', 'third', 1, 1000) == 0


def break_redis(monkeypatch):
    def unavailable(*args, **kwargs):
        raise ConnectionError('redis://private-user:private-password@private-host')
    monkeypatch.setattr(redis_state, 'client', lambda: SimpleNamespace(register_script=unavailable, ping=unavailable))


def test_unavailable_redis_fails_closed_without_creating_jobs(client, monkeypatch):
    from app.db import session_factory
    from app.models import Job, Ledger
    auth = login(client)
    break_redis(monkeypatch)
    response = client.put('/v1/translations/' + request_id('redis-failure'), headers=auth, json={
        'image': {'sha256': 'a' * 64, 'byte_size': 100, 'content_type': 'image/png'},
        'mode': 'classic', 'target_language': 'en'})
    assert response.status_code == 503 and response.headers['Retry-After'] == '2'
    assert response.json()['error']['code'] == 'ADMISSION_UNAVAILABLE'
    assert 'private-' not in response.text
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 0
        assert db.scalar(select(func.count()).select_from(Ledger)) == 0
    assert client.get('/health/live').status_code == 200
    ready = client.get('/health/ready')
    assert ready.status_code == 503 and ready.json()['checks']['redis'] == 'unavailable'
    with pytest.raises(TextError) as failure:
        reserve_request(SimpleNamespace(id='supplier', requests_per_minute=60))
    assert failure.value.code == 'ADMISSION_UNAVAILABLE'


def test_multiple_title_executors_share_capacity_until_running_work_finishes(monkeypatch):
    from app import comic_titles
    from fastapi import HTTPException
    entered, release = Event(), Event()
    def query(*args):
        entered.set()
        assert release.wait(timeout=5)
        return 'done'
    monkeypatch.setattr(comic_titles, 'query_title', query)
    first, second = comic_titles.TitleExecutor(1), comic_titles.TitleExecutor(1)
    async def run():
        task = asyncio.create_task(first.run(None, 'first'))
        assert await asyncio.to_thread(entered.wait, 2)
        with pytest.raises(HTTPException) as busy:
            await second.run(None, 'second')
        assert busy.value.detail['code'] == 'COMIC_TITLE_BUSY'
        release.set()
        assert await task == 'done'
        assert await second.run(None, 'second') == 'done'
    try:
        asyncio.run(run())
    finally:
        release.set()
        first.close()
        second.close()
