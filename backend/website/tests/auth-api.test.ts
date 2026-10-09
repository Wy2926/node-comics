import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { InMemoryWebStorage, User } from 'oidc-client-ts';
import { api, ApiError, authenticatedFetch, finishLogin, session, sessionIdentity, signIn, signOut, subscribeAuth } from '../src/lib/auth';
import { currentAccount, json } from '../src/lib/translation-api';
import { sessionPrefix } from '../src/lib/auth-session';

const config = { mode: 'oidc', dev_auth: false, issuer: 'https://identity.example/oidc', client_id: 'website-client',
  audience: 'https://comics.example/api', authorization_endpoint: 'https://identity.example/oidc/auth',
  token_endpoint: 'https://identity.example/oidc/token', scopes: 'openid profile offline_access' };
const key = sessionPrefix + config.issuer + ':' + config.client_id;
const storage = new InMemoryWebStorage(), states = new InMemoryWebStorage(), browser = new EventTarget();
const queues = new Map<string, Promise<unknown>>();
const locks = { request: (name: string, work: () => unknown) => {
  const result = (queues.get(name) ?? Promise.resolve()).then(work); queues.set(name, result.catch(() => undefined)); return result;
} };
let current = 'https://comics.example/account/', assigned = '';
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  localStorage: storage, sessionStorage: states, window: browser, navigator: { locks },
  location: { origin: 'https://comics.example', get href() { return current; }, assign: (value: string) => { assigned = value; } },
  history: { replaceState: (_value: unknown, _unused: string, path: string) => { current = 'https://comics.example' + path; } },
})) { previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value }); }
after(() => { for (const [name, value] of previous) if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name); });
beforeEach(() => { storage.clear(); states.clear(); current = 'https://comics.example/account/'; assigned = ''; });

const profile = { sub: 'reader', iss: config.issuer, aud: config.client_id, exp: 9999999999, iat: 1 };
function seed(token = 'old-token', id = 'login-one', subject = 'reader') {
  const user = new User({ access_token: token, refresh_token: 'refresh-one', token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600, profile: { ...profile, sub: subject } });
  storage.setItem(key, JSON.stringify({ id, user: user.toStorageString() }));
}
const renewed = () => Response.json({ access_token: 'new-token', refresh_token: 'refresh-two', token_type: 'Bearer', expires_in: 3600 });
const unauthorized = () => Response.json({ error: { code: 'TOKEN_INVALID' } }, { status: 401 });
const configuration = (path: string | URL | Request) => String(path) === '/v1/auth/config' ? Response.json(config) : undefined;

test('authenticated GET retries once through the installed OIDC SDK and persists refresh rotation', async context => {
  seed(); const calls: { path: string; init?: RequestInit }[] = [];
  context.mock.method(globalThis, 'fetch', async (path: string, init?: RequestInit) => {
    const configured = configuration(path); if (configured) return configured;
    calls.push({ path, init });
    if (path === config.token_endpoint) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('refresh_token'), 'refresh-one'); assert.equal(body.get('resource'), config.audience);
      assert.equal(init?.credentials, 'omit'); return renewed();
    }
    return new Headers(init?.headers).get('Authorization') === 'Bearer old-token' ? unauthorized() : Response.json({ ok: true });
  });
  assert.deepEqual(await api('/v1/me'), { ok: true });
  assert.deepEqual(calls.map(call => call.path), ['/v1/me', config.token_endpoint, '/v1/me']);
  assert.equal((await session())?.refresh_token, 'refresh-two');
});

test('POST 401 is not replayed and a business 403 does not clear a valid login', async context => {
  seed(); let calls = 0;
  context.mock.method(globalThis, 'fetch', async (path: string) => {
    const configured = configuration(path); if (configured) return configured;
    calls++; return unauthorized();
  });
  await assert.rejects(api('/v1/billing/checkouts', 'POST', { price_id: 'quote' }, { 'Idempotency-Key': 'same' }), ApiError);
  assert.equal(calls, 1); assert.equal(await session(), null);
  seed();
  context.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }));
  await assert.rejects(api('/v1/me'), error => error instanceof ApiError && error.status === 403);
  assert.equal((await session())?.access_token, 'old-token');
});

test('second GET 401 expires the session and stops retrying', async context => {
  seed(); let calls = 0;
  context.mock.method(globalThis, 'fetch', async (path: string) => {
    const configured = configuration(path); if (configured) return configured;
    calls++; return path === config.token_endpoint ? renewed() : unauthorized();
  });
  await assert.rejects(api('/v1/me'), ApiError); assert.equal(calls, 3); assert.equal(await session(), null);
});

test('a multi-request operation cannot switch accounts or reuse its former login identity', async context => {
  seed(); context.mock.method(globalThis, 'fetch', async (path: string) => configuration(path) ?? Response.json({ ok: true }));
  const identity = (await sessionIdentity())!;
  await signOut(); seed('other-token', 'new-login');
  await assert.rejects(api('/v1/billing/checkouts', 'POST', {}, {}, identity), ApiError);
  await assert.rejects(authenticatedFetch('/v1/me', {}, {id:'new-login',subject:'other-subject'}), ApiError);
});

test('a late response after account switch is discarded and cannot sign out the replacement', async context => {
  seed(); let resolve!: (value: Response) => void, start!: () => void;
  const started = new Promise<void>(done => { start = done; });
  context.mock.method(globalThis, 'fetch', async (path: string) => configuration(path) ?? new Promise<Response>(done => { resolve = done; start(); }));
  const pending = api('/v1/me'); const rejected = assert.rejects(pending, ApiError);
  await started; seed('other-token', 'new-login', 'other-subject'); resolve(unauthorized()); await rejected;
  assert.equal((await session())?.access_token, 'other-token');
});

for (const consumer of ['account', 'translation'] as const) test(`${consumer} JSON finishing after account switch is discarded`, async context => {
  seed(); let finish!: (value: unknown) => void, parsing!: () => void;
  const started = new Promise<void>(done => { parsing = done; });
  const response = Response.json({});
  response.json = () => { parsing(); return new Promise(done => { finish = done; }); };
  context.mock.method(globalThis, 'fetch', async (path: string) => configuration(path) ?? response);
  const pending = consumer === 'account' ? api('/v1/me') :
    json('/v1/capabilities', {}, { id: 'reader-id', name: 'Reader', subject: 'reader', sessionId: 'login-one' });
  const rejected = assert.rejects(pending, ApiError);
  await started; seed('other-token', 'new-login', 'other-subject'); finish({ user: 'old-reader' }); await rejected;
  assert.equal((await session())?.access_token, 'other-token');
});

test('website translation discovers a persisted login without old sessionStorage markers', async context => {
  seed(); context.mock.method(globalThis, 'fetch', async (path: string) => configuration(path) ?? Response.json({ user: { id: 'reader-id', name: 'Reader' } }));
  assert.deepEqual(await currentAccount(), { id: 'reader-id', name: 'Reader', subject: 'reader', sessionId: 'login-one' });
  assert.equal(states.length, 0);
});

test('storage events report identity changes but not refreshes, and unsubscribe removes listeners', () => {
  let calls = 0; const unsubscribe = subscribeAuth(() => calls++);
  const emit = (oldValue: unknown, newValue: unknown) => {
    const event = new Event('storage'); Object.assign(event, { key, oldValue: JSON.stringify(oldValue), newValue: JSON.stringify(newValue) }); browser.dispatchEvent(event);
  };
  emit({ id: 'one', user: 'old-token' }, { id: 'one', user: 'new-token' }); assert.equal(calls, 0);
  emit({ id: 'one', user: 'old-token' }, { id: 'two', user: null }); assert.equal(calls, 1);
  unsubscribe(); emit(null, { id: 'three', user: 'token' }); assert.equal(calls, 1);
});

test('real SDK PKCE redirect/callback verifies API identity before persisting and reuses SSO', async context => {
  let meCalled = false;
  context.mock.method(globalThis, 'fetch', async (path: string, init?: RequestInit) => {
    const configured = configuration(path); if (configured) return configured;
    if (path === config.token_endpoint) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'authorization_code'); assert.ok(body.get('code_verifier'));
      const payload = Buffer.from(JSON.stringify(profile)).toString('base64url');
      return Response.json({ access_token: 'login-token', refresh_token: 'login-refresh', token_type: 'Bearer', expires_in: 3600, id_token: `eyJhbGciOiJub25lIn0.${payload}.fixture` });
    }
    assert.equal(path, '/v1/me'); assert.equal(await session(), null); meCalled = true;
    return Response.json({ user: { id: 'reader-id' } });
  });
  await signIn('/en/account/');
  const authorize = new URL(assigned);
  assert.equal(authorize.searchParams.get('prompt'), 'consent'); assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  current = 'https://comics.example/auth/callback/?code=fixture&state=' + authorize.searchParams.get('state');
  await finishLogin(); assert.equal(meCalled, true); assert.equal((await session())?.access_token, 'login-token');
  assert.equal(current, 'https://comics.example/auth/callback/');
});
