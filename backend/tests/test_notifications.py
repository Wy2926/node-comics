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


def test_reader_long_poll_is_owner_scoped_and_releases_database(client, png):
    from conftest import request_record
    auth, other = login_plus(client), login(client, 'other')
    source = upload(client, auth, png)
    created = submit_asset(client, auth, source).json()
    request_path = '/v1/translations?ids=' + created['id']
    initial = client.get(request_path, headers=auth)
    foreign = client.get(request_path, headers=other)
    def waiting(headers, etag):
        return client.get(request_path + '&wait_seconds=2', headers={**headers, 'If-None-Match': etag})
    with ThreadPoolExecutor(2) as pool:
        future = pool.submit(waiting, auth, initial.headers['ETag'])
        outsider = pool.submit(waiting, other, foreign.headers['ETag'])
        wait_for_idle_subscriptions(2)
        start = time.monotonic()
        record = request_record(client, auth, created['id'])
        with session_factory()() as db:
            job = db.get(Job, record.job_id)
            job.status = 'running'
            touch_job(db, job)
            db.commit()
        response = future.result(timeout=1)
        assert response.status_code == 200
        assert [(item['id'], item['state']) for item in response.json()['items']] == [(created['id'], 'running')]
        assert time.monotonic() - start < 1 and not outsider.done()
        assert outsider.result(timeout=3).status_code == 304
    assert not hub().waiters


def test_snapshot_handles_lost_notification_and_auth_scoped_etag(client, png, monkeypatch):
    from conftest import request_record
    auth, stranger = login_plus(client), login(client, 'other')
    created = submit_asset(client, auth, upload(client, auth, png)).json()
    path = '/v1/translations?ids=' + created['id']
    first = client.get(path, headers=auth)
    assert client.get(path, headers={**auth, 'If-None-Match': first.headers['ETag']}).status_code == 304
    foreign = client.get(path, headers={**stranger, 'If-None-Match': first.headers['ETag']})
    assert foreign.status_code == 200 and foreign.json()['missing_ids'] == [created['id']]
    record = request_record(client, auth, created['id'])
    with session_factory()() as db:
        db.get(Job, record.job_id).status = 'running'
        db.commit()  # Deliberately omit publish: durable snapshots remain authoritative.
    recovered = client.get(path, headers={**auth, 'If-None-Match': first.headers['ETag']}, params={'wait_seconds': 1})
    assert recovered.status_code == 200 and recovered.json()['items'][0]['state'] == 'running'
    assert client.get(path, headers=auth).json()['items'][0]['state'] == 'running'


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
                assert not wake.is_set(), 'SAVEPOINT release is not a committed transaction'
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
            assert not wake.is_set(), 'Rolled-back transaction must not notify subscribers'
    asyncio.run(run())


def test_wait_timeout_rechecks_persistent_state_after_notification_loss(client, png):
    from conftest import request_record
    auth = login_plus(client)
    created = submit_asset(client,auth,upload(client,auth,png)).json()
    path = '/v1/translations?ids=' + created['id']
    initial = client.get(path,headers=auth)
    record = request_record(client,auth,created['id'])
    with ThreadPoolExecutor(1) as pool:
        pending = pool.submit(client.get,path+'&wait_seconds=1',
            headers={**auth,'If-None-Match':initial.headers['ETag']})
        wait_for_idle_subscriptions(1)
        with session_factory()() as db:
            db.get(Job,record.job_id).status = 'running'
            db.commit()  # A lost notification must not turn a changed snapshot into 304.
        result = pending.result(timeout=3)
    assert result.status_code == 200 and result.json()['items'][0]['state'] == 'running'
    assert result.headers['ETag'] != initial.headers['ETag']
