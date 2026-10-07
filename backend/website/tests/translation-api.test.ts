import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request, TranslationError, watch } from '../src/lib/translation-api';
import { localSnapshotState, recordOrder } from '../src/lib/translation-store';

test('batch rows keep the same order when timestamps tie or a record is updated', () => {
  const rows = [{ id: 'b', created: 1 }, { id: 'a', created: 1 }, { id: 'c', created: 2 }];
  assert.deepEqual(rows.sort(recordOrder).map(row => row.id), ['c', 'a', 'b']);
  assert.deepEqual([rows[1], rows[2], rows[0]].sort(recordOrder).map(row => row.id), ['c', 'a', 'b']);
});

test('a completed server task is receiving until its full image is saved locally', () => {
  assert.equal(
    localSnapshotState({ id: 'test', state: 'succeeded' }, false),
    'receiving',
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
  const reason = await watch(
    '/v1/guest/translations',
    'test',
    undefined,
    new AbortController().signal,
    async (snapshot) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      seen.push(snapshot.state);
    },
  );
  assert.deepEqual(seen, ['succeeded']);
  assert.equal(reason, 'complete');
});

test('SSE handles split UTF-8, CRLF and CR lines, multiple data fields and field order', async (context) => {
  const frames = new TextEncoder().encode(
    ': keepalive\r\n\r\n' +
      'id: ignored\r\n' +
      'data: {"items":[\r\n' +
      'data: {"id":"other","state":"failed"},\r\n' +
      'data: {"id":"test","state":"running","error":{"code":"TEST","message":"中文🙂日本語"}}\r\n' +
      'data: ],"missing_ids":[]}\r\n' +
      'event:snapshot\r\n\r\n' +
      'event: end\rdata: {"reason":"reconnect"}\r\r',
  );
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (_path: string, options: RequestInit) => {
    calls++;
    assert.equal((options.headers as Headers).get('Accept'), 'text/event-stream');
    return new Response(new ReadableStream({
      start(controller) {
        for (const byte of frames) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }));
  });
  const seen: string[] = [];
  const reason = await watch('/v1/guest/translations', 'test', undefined,
    new AbortController().signal, async (snapshot) => {
      seen.push(snapshot.id + ':' + snapshot.state + ':' + snapshot.error?.message);
    });
  assert.deepEqual(seen, ['test:running:中文🙂日本語']);
  assert.equal(reason, 'reconnect');
  assert.equal(calls, 1);
});

test('EOF without end preserves received state and reports a disconnect without replaying', async (context) => {
  let calls = 0;
  let ending = '';
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(
      'event: snapshot\ndata: {"items":[{"id":"test","state":"running"}]}\n\n' +
      'event: snapshot\ndata: {"items":[{"id":"test","state":"succeeded"}]}' + ending,
    );
  });
  for (const separator of ['', '\n\n']) {
    ending = separator;
    const seen: string[] = [];
    await assert.rejects(watch('/v1/guest/translations', 'test', undefined,
      new AbortController().signal, async (snapshot) => { seen.push(snapshot.state); }),
      (error) => error instanceof TranslationError && error.code === 'NETWORK_ERROR');
    assert.deepEqual(seen, separator ? ['running', 'succeeded'] : ['running']);
  }
  assert.equal(calls, 2); // One connection per invocation; no internal retry.
});

test('explicit missing UUID stops the stream with the same 404 semantics as a snapshot GET', async (context) => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(
      'event: snapshot\ndata: {"items":[],"missing_ids":["test"]}\n\n' +
      'event: end\ndata: {"reason":"complete"}\n\n',
    );
  });
  await assert.rejects(watch('/v1/guest/translations', 'test', undefined,
    new AbortController().signal, async () => assert.fail('Missing UUID has no snapshot')),
    (error) => error instanceof TranslationError && error.code === 'NOT_FOUND' && error.status === 404);
  assert.equal(calls, 1);
});

test('malformed and oversized frames fail and release their reader', async (context) => {
  let canceled = 0;
  let frame = '';
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame)); },
    cancel() { canceled++; },
  })));
  for (const value of [
    'event: snapshot\ndata: {broken}\n\n',
    'event: snapshot\ndata: ' + 'x'.repeat(1024 * 1024) + '\n\n',
    'event: end\ndata: {"reason":"unknown"}\n\n',
  ]) {
    frame = value;
    await assert.rejects(watch('/v1/guest/translations', 'test', undefined,
      new AbortController().signal, async () => assert.fail('Invalid frame has no snapshot')),
      (error) => error instanceof TranslationError && error.code === 'NETWORK_ERROR');
  }
  assert.equal(canceled, 3);
});

test('caller abort cancels a stalled reader and remains distinct from completion or disconnect', async (context) => {
  const abort = new AbortController();
  let ready!: () => void;
  const received = new Promise<void>((resolve) => { ready = resolve; });
  let canceled = 0;
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'event: snapshot\ndata: {"items":[{"id":"test","state":"running"}]}\n\n',
      ));
    },
    cancel() { canceled++; },
  })));
  const watching = watch('/v1/guest/translations', 'test', undefined,
    abort.signal, async () => { ready(); });
  await received;
  const reason = new DOMException('User paused', 'AbortError');
  abort.abort(reason);
  await assert.rejects(watching, (error) => error === reason);
  assert.equal(canceled, 1);
});

test('45 seconds without bytes cancels the subscription without creating another connection', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let ready!: () => void;
  const received = new Promise<void>((resolve) => { ready = resolve; });
  let calls = 0;
  let canceled = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: snapshot\ndata: {"items":[{"id":"test","state":"queued"}]}\n\n',
        ));
      },
      cancel() { canceled++; },
    }));
  });
  const watching = watch('/v1/guest/translations', 'test', undefined,
    new AbortController().signal, async () => { ready(); });
  await received;
  await new Promise<void>((resolve) => setImmediate(resolve));
  context.mock.timers.tick(45000);
  await assert.rejects(watching,
    (error) => error instanceof TranslationError && error.code === 'NETWORK_ERROR');
  assert.equal(calls, 1);
  assert.equal(canceled, 1);
});
