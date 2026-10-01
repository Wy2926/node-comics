"""Bounded SSE snapshots: wait on commits without holding DB connections."""
import asyncio
import json
import time

import anyio
import jwt
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from .errors import problem
from .notifications import hub
from .translation_limits import acquire_control, release_control

HEARTBEAT_SECONDS = 20
RECONCILE_SECONDS = 60
STREAM_SECONDS = 295


def event(name, value):
    return f'event: {name}\ndata: {json.dumps(value, ensure_ascii=False, separators=(",", ":"))}\n\n'


class SnapshotStream(StreamingResponse):
    def __init__(self, content, cleanup, deadline):
        super().__init__(content, media_type='text/event-stream', headers={
            'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no'})
        self.cleanup = cleanup
        self.deadline = deadline

    async def __call__(self, scope, receive, send):
        try:
            # A peer that stops reading must not hold a subscription indefinitely.
            with anyio.move_on_after(max(0, self.deadline - time.monotonic())):
                await super().__call__(scope, receive, send)
        finally:
            # Also runs on disconnect/send failure, including before iteration starts.
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()
                await self.cleanup()


async def translation_events(owner_id, ids, request, *, expires_at=None):
    from .translation_api import read_snapshot

    # identity has already verified the signature, issuer and audience. Bound the
    # stream to that same credential's expiry; reconnect uses normal auth again.
    if expires_at is None:
        claims = jwt.decode(request.headers['authorization'].split()[1], options={'verify_signature': False})
        expires_at = claims['exp']
    lifetime = min(STREAM_SECONDS, expires_at - time.time())
    if lifetime <= 0:
        problem('TOKEN_INVALID', '登录已过期，请重新登录', 401)
    end = time.monotonic() + lifetime
    token = await run_in_threadpool(acquire_control, owner_id, 'events', lease_seconds=300)
    subscription = None
    entered = False

    async def cleanup():
        if entered:
            subscription.__exit__(None, None, None)
        await run_in_threadpool(release_control, owner_id, token, 'events')

    try:
        subscription = hub().subscribe('user:' + owner_id)
        wake = subscription.__enter__()
        entered = True
        # Subscribe before reading: a commit during the first read cannot be lost.
        first = await run_in_threadpool(read_snapshot, owner_id, ids)
    except BaseException:
        with anyio.CancelScope(shield=True):
            await cleanup()
        raise

    async def frames():
        etag, payload = first
        yield event('snapshot', payload)
        reconcile_at = time.monotonic() + RECONCILE_SECONDS
        while any(item['state'] in {'needs_input', 'queued', 'running', 'needs_attention'} for item in payload['items']):
            remaining = end - time.monotonic()
            if remaining <= 0 or hub().stop.is_set():
                yield event('end', {'reason': 'reconnect'})
                return
            try:
                await asyncio.wait_for(wake.wait(), min(HEARTBEAT_SECONDS, remaining))
            except TimeoutError:
                pass
            if time.monotonic() >= end:
                continue
            if not wake.is_set() and time.monotonic() < reconcile_at:
                yield ': keepalive\n\n'
                continue
            # Merge bursts of phase/queue commits, not one query per notification.
            await asyncio.sleep(.05)
            wake.clear()
            next_etag, next_payload = await run_in_threadpool(read_snapshot, owner_id, ids)
            reconcile_at = time.monotonic() + RECONCILE_SECONDS
            if next_etag != etag:
                etag, payload = next_etag, next_payload
                yield event('snapshot', payload)
        yield event('end', {'reason': 'complete'})

    return SnapshotStream(frames(), cleanup, end + .1)
