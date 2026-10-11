import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ApiError, authenticatedFetch, checkLocalApi, liveAccounts, liveApiPath, liveOrigin,
  localAccountName, loginAs, sessionIdentity, signOut, subscribeAuth } from './document-live-auth';

// Unit doubles are confined to this test file. The served entry uses native fetch.
const values = new Map<string, string>(), locationValue = { origin: liveOrigin };
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ location: locationValue, sessionStorage: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
} })) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
after(() => { for (const [name, value] of previous) if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name); });
beforeEach(async () => { locationValue.origin = liveOrigin; await signOut(); values.clear(); });
const configuration = () => Response.json({ mode: 'development', dev_auth: true });
const login = (id = 'local-user') => Response.json({ access_token: 'unit-test-token', token_type: 'bearer', expires_in: 43200, user: { id } });

test('live entry keeps native document requests and only aliases local test authentication', () => {
  const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
  const config = read('./document-live.config.ts'), entry = read('./document-live.tsx'), auth = read('./document-live-auth.ts');
  assert.match(config, /host: '127\.0\.0\.1', port: 5195, strictPort: true, open: false/);
  assert.match(config, /proxy: \{ '\/v1': \{ target: 'http:\/\/127\.0\.0\.1:4324'/);
  assert.match(config, /document-live-auth\.ts/);
  assert.match(entry, /import DocumentWorkbench from '\.\.\/src\/components\/DocumentWorkbench'/);
  assert.match(entry, /R2 存储、传输与 LLM 请求都是真实调用/);
  assert.match(entry, /尚未接入测试 GPU 时任务会正常排队/);
  assert.match(entry, /付费资格和初始额度由隔离启动器在本地数据库预置/);
  assert.doesNotMatch(config + entry + auth, /window\.fetch\s*=|globalThis\.fetch\s*=|document-fixture|new Response\(|Response\.json\(/);
  assert.match(read('./document-live.html'), /noindex,nofollow/);
  assert.equal(JSON.parse(read('../package.json')).scripts['dev:documents'], 'vite --config tests/document-live.config.ts');
});

test('local token path guard blocks non-loopback entry, absolute URLs, traversal and object-store paths', () => {
  assert.equal(liveApiPath('/v1/documents?limit=20'), '/v1/documents?limit=20');
  for (const path of ['https://object.invalid/result', '//object.invalid/v1/me', '/v1/../admin', '/v1/%2e%2e/admin', '/v1/\\other', '/v1/me#secret']) {
    assert.throws(() => liveApiPath(path), ApiError);
  }
  locationValue.origin = 'https://comics.example';
  assert.throws(() => liveApiPath('/v1/me'), (error: unknown) => error instanceof ApiError && error.code === 'LOCAL_ORIGIN_REQUIRED');
});

test('native dev login contract binds the server-returned identity and sends bearer only to local API', async context => {
  const calls: { path: string; options?: RequestInit }[] = [];
  context.mock.method(globalThis, 'fetch', async (path: string, options?: RequestInit) => {
    calls.push({ path, options });
    return path === '/v1/auth/config' ? configuration() : path === '/v1/auth/dev' ? login() : Response.json({ fromServer: true });
  });
  await loginAs(liveAccounts[0]);
  assert.deepEqual(JSON.parse(String(calls[1].options?.body)), { username: 'document-local-paid' });
  assert.equal(calls[1].options?.method, 'POST');
  assert.equal(new Headers(calls[1].options?.headers).has('Authorization'), false);
  const identity = (await sessionIdentity())!;
  assert.equal(identity.subject, 'local-user'); assert.equal(localAccountName(), liveAccounts[0]);
  const response = await authenticatedFetch('/v1/documents?limit=20', {}, identity);
  assert.deepEqual(await response.json(), { fromServer: true });
  assert.equal(new Headers(calls[2].options?.headers).get('Authorization'), 'Bearer unit-test-token');
  assert.equal(calls[2].options?.credentials, 'omit'); assert.equal(calls[2].options?.redirect, 'error');
  assert.equal(calls[2].options?.referrerPolicy, 'no-referrer');
});

test('OIDC or unavailable API never proceeds to the development login endpoint', async context => {
  let count = 0;
  context.mock.method(globalThis, 'fetch', async () => { count++; return Response.json({ mode: 'oidc', dev_auth: false }); });
  await assert.rejects(loginAs(liveAccounts[0]), (error: unknown) => error instanceof ApiError && error.code === 'LOCAL_DEV_AUTH_REQUIRED');
  assert.equal(count, 1); assert.equal(await sessionIdentity(), null);
  context.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(checkLocalApi(), (error: unknown) => error instanceof ApiError && error.code === 'LOCAL_API_UNAVAILABLE');
});

test('unknown account, invalid token response and expired stored session remain signed out', async context => {
  let count = 0;
  context.mock.method(globalThis, 'fetch', async (path: string) => { count++; return path === '/v1/auth/config' ? configuration() : Response.json({ access_token: 'bad', token_type: {}, user: { id: 'u' }, expires_in: 1 }); });
  await assert.rejects(loginAs('production-admin'), ApiError); assert.equal(count, 0);
  await assert.rejects(loginAs(liveAccounts[0]), ApiError); assert.equal(await sessionIdentity(), null);
  context.mock.method(globalThis, 'fetch', async (path: string) => path === '/v1/auth/config' ? configuration() : login());
  await loginAs(liveAccounts[0]);
  const [key, raw] = [...values.entries()][0];
  values.set(key, JSON.stringify({ ...JSON.parse(raw), expiresAt: Date.now() - 1 }));
  assert.equal(await sessionIdentity(), null);
  await assert.rejects(authenticatedFetch('/v1/documents'), ApiError);
});

test('signing out while login is in flight cannot restore the old session', async context => {
  let deliver!: (response: Response) => void, reached!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  context.mock.method(globalThis, 'fetch', async (path: string) => path === '/v1/auth/config' ? configuration() :
    new Promise<Response>(resolve => { deliver = resolve; reached(); }));
  const request = loginAs(liveAccounts[0]); await started; await signOut(); deliver(login());
  await assert.rejects(request, ApiError); assert.equal(await sessionIdentity(), null);
});

test('switching accounts fences former identities and a late response without replay', async context => {
  context.mock.method(globalThis, 'fetch', async (path: string, options?: RequestInit) => path === '/v1/auth/config' ? configuration() : login(JSON.parse(String(options?.body)).username));
  await loginAs(liveAccounts[0]); const first = (await sessionIdentity())!;
  await loginAs(liveAccounts[1]);
  await assert.rejects(authenticatedFetch('/v1/documents', {}, first), ApiError);
  const second = (await sessionIdentity())!;
  let deliver!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { deliver = resolve; }));
  const pending = authenticatedFetch('/v1/documents', {}, second);
  await signOut(); deliver(Response.json({ old: true }));
  await assert.rejects(pending, ApiError);
});

test('overlapping logins cannot let a late first response replace the selected account', async context => {
  const deliveries = new Map<string, (response: Response) => void>();
  let ready!: () => void;
  const bothStarted = new Promise<void>(resolve => { ready = resolve; });
  context.mock.method(globalThis, 'fetch', async (path: string, options?: RequestInit) => path === '/v1/auth/config' ? configuration() :
    new Promise<Response>(resolve => {
      deliveries.set(JSON.parse(String(options?.body)).username, resolve);
      if (deliveries.size === 2) ready();
    }));
  const first = loginAs(liveAccounts[0]), second = loginAs(liveAccounts[1]);
  await bothStarted;
  deliveries.get(liveAccounts[1])!(login('second')); await second;
  deliveries.get(liveAccounts[0])!(login('first')); await assert.rejects(first, ApiError);
  assert.equal((await sessionIdentity())?.subject, 'second');
});

test('401 ends the local session and never retries a mutation', async context => {
  context.mock.method(globalThis, 'fetch', async (path: string) => path === '/v1/auth/config' ? configuration() : login());
  await loginAs(liveAccounts[0]); const identity = (await sessionIdentity())!;
  let requests = 0, events = 0;
  const unsubscribe = subscribeAuth(() => { events++; });
  context.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('', { status: 401 }); });
  await assert.rejects(authenticatedFetch('/v1/documents/id/cancel', { method: 'POST' }, identity), ApiError);
  unsubscribe(); assert.equal(requests, 1); assert.equal(events, 1); assert.equal(await sessionIdentity(), null);
});

test('an old 401 cannot invalidate a new login started in the next microtask', async context => {
  context.mock.method(globalThis, 'fetch', (path: string, options?: RequestInit) => Promise.resolve(
    path === '/v1/auth/config' ? configuration() : path.startsWith('/v1/documents') ? new Response('', { status: 401 }) :
      login(JSON.parse(String(options?.body)).username)));
  await loginAs(liveAccounts[0]); const identity = (await sessionIdentity())!;
  const rejected = assert.rejects(authenticatedFetch('/v1/documents', {}, identity), ApiError);
  let nextLogin!: Promise<string | undefined>;
  queueMicrotask(() => { nextLogin = loginAs(liveAccounts[1]).then(() => undefined, error => error.code); });
  await rejected;
  assert.equal(await nextLogin, undefined);
  assert.equal((await sessionIdentity())?.subject, liveAccounts[1]);
});
