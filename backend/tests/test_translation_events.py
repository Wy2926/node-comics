"""SSE transport, notification reuse, authentication and resource release."""
import asyncio
import json
import time
from uuid import uuid4

import jwt
import pytest
from starlette.requests import Request

from app import translation_api, translation_events as events
from app.db import engine, session_factory
from app.models import Job
from app.notifications import hub
from app.scheduler import touch_job
from app.translation_limits import control_budget
from conftest import login, login_plus, upload, submit_asset, request_record


def decode_frames(text):
    return [json.loads(line[6:]) for line in text.splitlines() if line.startswith('data: {"items"')]


def test_stream_auth_validation_and_foreign_ids(client):
    key = str(uuid4())
    assert client.get('/v1/translations/events', params={'ids': key}).status_code == 401
    auth = login(client)
    assert client.get('/v1/translations/events', params={'ids': 'bad'}, headers=auth).status_code == 422
    assert client.get('/v1/translations/events', params={'ids': ','.join(str(uuid4()) for _ in range(33))}, headers=auth).status_code == 422
    result = client.get('/v1/translations/events', params={'ids': key}, headers=auth)
    assert result.headers['content-type'].startswith('text/event-stream')
    assert result.headers['x-accel-buffering'] == 'no'
    assert decode_frames(result.text) == [{'items': [], 'missing_ids': [key]}]
    assert '"reason":"complete"' in result.text
    assert not hub().waiters


def test_stream_only_reads_owned_requests(client, png):
    auth, stranger = login_plus(client), login(client, 'stranger')
    created = submit_asset(client, auth, upload(client, auth, png)).json()
    result = client.get('/v1/translations/events', params={'ids': created['id']}, headers=stranger)
    assert decode_frames(result.text) == [{'items': [], 'missing_ids': [created['id']]}]


@pytest.mark.parametrize('disconnect', [False, True])
def test_idle_heartbeats_do_not_query_db_and_stream_releases_resources(client, png, monkeypatch, disconnect):
    auth = login_plus(client)
    created = submit_asset(client, auth, upload(client, auth, png)).json()
    record = request_record(client, auth, created['id'])
    reads = []
    original = translation_api.read_snapshot
    def read(*args, **kwargs):
        reads.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(translation_api, 'read_snapshot', read)
    monkeypatch.setattr(events, 'HEARTBEAT_SECONDS', .02)

    async def run():
        request = Request({'type': 'http', 'headers': [(b'authorization', auth['Authorization'].encode())]})
        stream = await events.translation_events(record.owner_id, [created['id']], request)
        chunks, closing = [], asyncio.Event()
        async def send(message):
            if message['type'] == 'http.response.body':
                chunks.append(message['body'].decode())
        async def receive():
            await closing.wait()
            return {'type': 'http.disconnect'}
        task = asyncio.create_task(stream({'type': 'http', 'asgi': {'spec_version': '2.0'}}, receive, send))
        await asyncio.sleep(.09)
        assert len(reads) == 1
        assert engine().pool.checkedout() == 0
        assert any(': keepalive' in chunk for chunk in chunks)
        assert control_budget(record.owner_id, 'events')['active_leases'] == 1
        if disconnect:
            closing.set()
        else:
            with session_factory()() as db:
                job = db.get(Job, record.job_id)
                job.status = 'failed'
                touch_job(db, job)
                db.commit()
        await asyncio.wait_for(task, 2)
        if not disconnect:
            frames = decode_frames(''.join(chunks))
            assert len(frames) == 2 and frames[-1]['items'][0]['state'] == 'failed'
        assert not hub().waiters
        assert engine().pool.checkedout() == 0
        assert control_budget(record.owner_id, 'events')['active_leases'] == 0
    asyncio.run(run())


def test_reconciles_lost_notifications_and_ends_before_token_expiry(client, png, monkeypatch):
    auth = login_plus(client)
    created = submit_asset(client, auth, upload(client, auth, png)).json()
    record = request_record(client, auth, created['id'])
    monkeypatch.setattr(events, 'HEARTBEAT_SECONDS', .02)
    monkeypatch.setattr(events, 'RECONCILE_SECONDS', .03)

    async def run():
        request = Request({'type': 'http', 'headers': [(b'authorization', auth['Authorization'].encode())]})
        stream = await events.translation_events(record.owner_id, [created['id']], request)
        iterator = stream.body_iterator
        assert '"state":"queued"' in await anext(iterator)
        with session_factory()() as db:
            db.get(Job, record.job_id).status = 'failed'
            db.commit()  # Intentionally no notification.
        received = []
        async for frame in iterator:
            received.append(frame)
        await stream.cleanup()
        assert '"state":"failed"' in ''.join(received)
        # Same already-verified credential, approaching expiry. No need to wait
        # for JWT's integer-second rounding in this transport-only test.
        original_decode = jwt.decode
        monkeypatch.setattr(events.jwt, 'decode', lambda *a, **k: {**original_decode(*a, **k), 'exp': time.time()+.05})
        with session_factory()() as db:
            db.get(Job, record.job_id).status = 'queued'
            db.commit()
        stream = await events.translation_events(record.owner_id, [created['id']], request)
        frames = [frame async for frame in stream.body_iterator]
        await stream.cleanup()
        assert '"reason":"reconnect"' in ''.join(frames)
        assert not hub().waiters
    asyncio.run(run())


def test_stream_admission_failure_releases_redis_lease(client, monkeypatch):
    auth = login(client)
    def busy(*_args):
        from fastapi import HTTPException
        raise HTTPException(429, headers={'Retry-After': '2'})
    monkeypatch.setattr(hub(), 'subscribe', busy)
    result = client.get('/v1/translations/events', params={'ids': str(uuid4())}, headers=auth)
    assert result.status_code == 429
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    assert control_budget(owner, 'events')['active_leases'] == 0


def test_send_failure_before_first_frame_also_releases_subscription(client):
    from starlette.requests import ClientDisconnect
    auth = login(client)
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    async def run():
        request = Request({'type': 'http', 'headers': [(b'authorization', auth['Authorization'].encode())]})
        stream = await events.translation_events(owner, [str(uuid4())], request)
        async def send(_message):
            raise OSError('disconnected')
        async def receive():
            return {'type': 'http.disconnect'}
        with pytest.raises(ClientDisconnect):
            await stream({'type': 'http', 'asgi': {'spec_version': '2.4'}}, receive, send)
        assert not hub().waiters
        assert control_budget(owner, 'events')['active_leases'] == 0
    asyncio.run(run())


def test_account_stream_limit_is_shared_and_does_not_block_other_accounts(client):
    from fastapi import HTTPException
    from app.config import settings
    settings().translation_request_concurrency = 2
    auth, other = login(client), login(client, 'other')
    owner = client.get('/v1/me', headers=auth).json()['user']['id']
    other_owner = client.get('/v1/me', headers=other).json()['user']['id']
    async def run():
        request = Request({'type': 'http', 'headers': [(b'authorization', auth['Authorization'].encode())]})
        streams = []
        try:
            for _ in range(2):
                streams.append(await events.translation_events(owner, [str(uuid4())], request))
            with pytest.raises(HTTPException) as denied:
                await events.translation_events(owner, [str(uuid4())], request)
            assert denied.value.status_code == 429
            assert int(denied.value.headers['Retry-After']) > 0
            other_request = Request({'type': 'http', 'headers': [(b'authorization', other['Authorization'].encode())]})
            streams.append(await events.translation_events(other_owner, [str(uuid4())], other_request))
            assert control_budget(owner, 'events')['active_leases'] == 2
        finally:
            for stream in streams:
                await stream.body_iterator.aclose()
                await stream.cleanup()
        assert not hub().waiters
        assert control_budget(owner, 'events')['active_leases'] == 0
    asyncio.run(run())
