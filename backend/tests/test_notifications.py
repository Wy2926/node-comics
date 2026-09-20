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


def wait_for_idle_subscriptions(count):
    """A subscriber registers before its initial DB snapshot has finished."""
    deadline=time.monotonic()+2
    quiet_since=None
    while time.monotonic()<deadline:
        idle=len(hub().waiters)==count and engine().pool.checkedout()==0
        quiet_since=(quiet_since or time.monotonic()) if idle else None
        if quiet_since and time.monotonic()-quiet_since>=.05:
            return
        time.sleep(.01)
    raise AssertionError("Long poll did not release its database connections while waiting")


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
        wait_for_idle_subscriptions(2)
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


def test_policy_only_change_wakes_long_poll_with_no_duplicate_job_fetch(client):
    from conftest import login
    auth=login(client)
    admin=login(client,'admin')
    initial=client.get('/v1/me/translation-changes',headers=auth).json()
    settings=client.get('/v1/admin/system-settings',headers=admin).json()
    def wait():
        return client.get('/v1/me/translation-changes',headers=auth,params={
            'cursor':initial['cursor'],'policy_revision':initial['policy_revision'],'wait_seconds':3})
    with ThreadPoolExecutor(1) as pool:
        pending=pool.submit(wait)
        wait_for_idle_subscriptions(1)
        start=time.monotonic()
        response=client.put('/v1/admin/system-settings',headers=admin,json={
            'expected_version':settings['version'],
            'values':{**settings['values'],'free_images_per_minute':31}})
        assert response.status_code==200
        changed=pending.result(timeout=1)
        assert time.monotonic()-start<1
        assert changed.json()['items']==[] and changed.json()['cursor']==initial['cursor']
        assert changed.json()['policy_revision']!=initial['policy_revision']
        assert changed.json()['image_rate_limit']['limit']==31
    assert not hub().waiters


def test_nested_page_savepoints_notify_only_after_outer_commit(client):
    if engine().dialect.name == 'postgresql':
        assert hub().ready.wait(3), 'Wait for initial LISTEN reconnect wakeup before testing transactions'
    async def run():
        with hub().subscribe('savepoints') as wake:
            with session_factory()() as db:
                # Materialize the outer transaction before beginning savepoints.
                from sqlalchemy import text
                db.execute(text('SELECT 1'))
                with db.begin_nested():
                    publish(db,'savepoints')
                await asyncio.sleep(.01)
                assert not wake.is_set(), 'SAVEPOINT release is not a committed reading plan'
                try:
                    with db.begin_nested():
                        publish(db,'savepoints')
                        raise ValueError('one rejected page')
                except ValueError:
                    pass
                await asyncio.sleep(.01)
                assert not wake.is_set()
                db.commit()
            await asyncio.wait_for(wake.wait(),1)
            wake.clear()
            with session_factory()() as db:
                db.execute(text('SELECT 1'))
                with db.begin_nested():
                    publish(db,'savepoints')
                db.rollback()
            await asyncio.sleep(.01)
            assert not wake.is_set(), 'Rolled-back plan must not notify subscribers'
    asyncio.run(run())
