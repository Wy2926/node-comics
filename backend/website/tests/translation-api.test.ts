import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request, TranslationError, watch } from '../src/lib/translation-api';
import { localSnapshotState } from '../src/lib/translation-store';

test('a completed server task remains resumable until its full image is saved locally', () => {
  assert.equal(
    localSnapshotState({ id: 'test', state: 'succeeded' }, false),
    'paused',
  );
  assert.equal(
    localSnapshotState({ id: 'test', state: 'succeeded' }, true),
    'succeeded',
  );
  for (const state of [
    'needs_input',
    'queued',
    'running',
    'failed',
    'needs_attention',
  ] as const) {
    assert.equal(localSnapshotState({ id: 'test', state }, false), state);
  }
});

test('guest requests use the protocol, same-origin credentials and a bounded cancellable signal', async (context) => {
  const abort = new AbortController();
  let sent: RequestInit | undefined;
  context.mock.method(
    globalThis,
    'fetch',
    async (_path: string, options: RequestInit) => {
      sent = options;
      return new Response('{}');
    },
  );
  await request('/v1/guest/session', { signal: abort.signal });
  assert.equal(sent?.credentials, 'same-origin');
  assert.equal(sent?.cache, 'no-store');
  const headers = sent?.headers as Headers;
  assert.equal(headers.get('X-Guest-Request'), '1');
  assert.equal(headers.get('X-Translation-Protocol'), 'overlay-v1');
  assert.equal(headers.has('Authorization'), false);
  assert.notEqual(sent?.signal, abort.signal); // Deadline remains active when callers can cancel.
  assert.equal(sent?.signal?.aborted, false);
  abort.abort();
  assert.equal(sent?.signal?.aborted, true);
});

test('HTTP errors preserve the server code and retry delay without replaying writes', async (context) => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 'GUEST_BUSY' } }), {
      status: 429,
      headers: { 'Retry-After': '5' },
    });
  });
  await assert.rejects(
    request('/v1/guest/translations/test', { method: 'PUT' }),
    (error) => {
      assert.ok(error instanceof TranslationError);
      assert.equal(error.code, 'GUEST_BUSY');
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 5);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('snapshot streams tolerate network chunk boundaries and finish without another submission', async (context) => {
  const encoder = new TextEncoder();
  const frames =
    ': keepalive\n\nevent: snapshot\ndata: {"items":[{"id":"test","state":"succeeded"}]}\n\nevent: end\ndata: {"reason":"complete"}\n\n';
  context.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let index = 0; index < frames.length; index += 7)
              controller.enqueue(
                encoder.encode(frames.slice(index, index + 7)),
              );
            controller.close();
          },
        }),
      ),
  );
  const seen: string[] = [];
  await watch(
    '/v1/guest/translations',
    'test',
    undefined,
    new AbortController().signal,
    async (snapshot) => {
      seen.push(snapshot.state);
    },
  );
  assert.deepEqual(seen, ['succeeded']);
});
