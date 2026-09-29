"""Wakeups are commit-scoped and never hold a database session while waiting."""
import asyncio
import time

from app.db import engine, session_factory
from app.models import Job
from app.notifications import hub, publish
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
    raise AssertionError("Subscription did not release its database connections while waiting")


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


def test_reader_snapshot_is_immediate_and_owner_scoped(client, png, monkeypatch):
    auth, other = login_plus(client), login(client, 'other')
    source = upload(client, auth, png)
    created = submit_asset(client, auth, source).json()
    request_path = '/v1/translations?ids=' + created['id']
    def unexpected(*_args):
        raise AssertionError('Snapshot reads must never subscribe for changes')
    monkeypatch.setattr(hub(), 'subscribe', unexpected)
    initial = client.get(request_path, headers=auth)
    foreign = client.get(request_path, headers=other)
    assert initial.status_code == 200
    assert foreign.json() == {'items': [], 'missing_ids': [created['id']]}
    assert client.get(request_path, headers={**auth, 'If-None-Match': initial.headers['ETag']}).status_code == 304
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
    recovered = client.get(path, headers={**auth, 'If-None-Match': first.headers['ETag']})
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


def test_snapshot_contract_has_no_long_poll_parameters(client):
    schema = client.get('/openapi.json').json()
    for path in ['/v1/translations', '/v1/translations/{translation_id}']:
        assert 'wait_seconds' not in {param['name'] for param in schema['paths'][path]['get']['parameters']}
