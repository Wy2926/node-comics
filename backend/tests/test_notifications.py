"""Wakeups are commit-scoped and never hold a database session while waiting."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import time

from sqlalchemy import select
from app.db import engine, session_factory
from app.models import Job
from app.notifications import hub, publish
from app.scheduler import touch_job
from conftest import login, login_plus, upload, submit_asset


def test_commit_and_rollback_wakeups(client):
    async def run():
        with hub().subscribe('test') as wake:
            with session_factory()() as db:
                publish(db, 'test')
                db.rollback()
            await asyncio.sleep(.01)
            assert not wake.is_set()
            with session_factory()() as db:
                publish(db, 'test')
                db.commit()
            await asyncio.wait_for(wake.wait(), 1)
    asyncio.run(run())


def test_reader_long_poll_is_owner_scoped_and_wakes_without_poll_interval(client, png):
    auth = login_plus(client)
    other = login(client, 'other')
    source = upload(client, auth, png)
    created = submit_asset(client, auth, source).json()['items'][0]['job']
    initial = client.get('/v1/me/translation-changes', headers=auth).json()
    def waiting(headers, cursor):
        return client.get(f'/v1/me/translation-changes?cursor={cursor}&wait_seconds=2', headers=headers)
    with ThreadPoolExecutor(2) as pool:
        future = pool.submit(waiting, auth, initial['cursor'])
        outsider = pool.submit(waiting, other, '0')
        deadline = time.monotonic() + 2
        while len(hub().waiters) < 2 and time.monotonic() < deadline:
            time.sleep(.01)
        assert len(hub().waiters) == 2
        assert engine().pool.checkedout() == 0
        start = time.monotonic()
        with session_factory()() as db:
            job = db.get(Job, created['id'])
            touch_job(db, job)
            db.commit()
        response = future.result(timeout=1)
        assert response.status_code == 200
        assert [j['id'] for j in response.json()['items']] == [created['id']]
        assert time.monotonic() - start < 1
        assert not outsider.done()
        assert outsider.result(timeout=3).json()['items'] == []
    assert not hub().waiters
