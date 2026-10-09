import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorResponse, InMemoryWebStorage, User } from 'oidc-client-ts';
import { ApiError, RefreshUnavailable, SharedSession } from '../src/lib/auth-session';

function authLocks(): Pick<LockManager, 'request'> {
  const pending = new Map<string, Promise<unknown>>();
  return { request: ((key: string, work: () => unknown) => {
    const result = (pending.get(key) ?? Promise.resolve()).then(work);
    pending.set(key, result.catch(() => undefined));
    return result;
  }) as LockManager['request'] };
}
const user = (token = 'access-one', ttl = 3600, subject = 'reader') => new User({
  access_token: token, refresh_token: 'refresh-' + token, token_type: 'Bearer',
  expires_at: Math.floor(Date.now() / 1000) + ttl, profile: { sub: subject, iss: 'identity', aud: 'client', exp: 9999999999, iat: 1 },
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function fixture(refresh: (value: User) => Promise<User> = async () => user('access-two')) {
  const storage = new InMemoryWebStorage(), locks = authLocks();
  const notifications: number[] = [];
  const tab = () => new SharedSession(storage, 'session', locks, refresh, () => notifications.push(1));
  const first = tab();
  const login = async (value = user()) => { const { id } = await first.beginLogin(); await first.finishLogin(id, value); return id; };
  const expire = () => {
    const record = JSON.parse(storage.getItem('session')!);
    const value = User.fromStorageString(record.user); value.expires_at = Math.floor(Date.now() / 1000) - 1;
    storage.setItem('session', JSON.stringify({ ...record, user: value.toStorageString() }));
  };
  return { storage, tab, first, login, expire, notifications };
}

test('a new tab/browser instance restores the one persistent session without a token request', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return user('access-two'); });
  const id = await f.login();
  assert.equal((await f.tab().get())?.id, id);
  assert.equal((await f.tab().get())?.user.access_token, 'access-one');
  assert.equal(calls, 0);
});

test('12 consumers across tabs rotate once and persist before returning, without identity events', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return user('access-two'); });
  await f.login(); f.expire(); f.notifications.length = 0;
  const result = await Promise.all(Array.from({ length: 12 }, () => f.tab().get()));
  assert.equal(calls, 1);
  assert.deepEqual(new Set(result.map(value => value?.user.access_token)), new Set(['access-two']));
  assert.equal((await f.tab().get())?.user.refresh_token, 'refresh-access-two');
  assert.equal(f.notifications.length, 0);
});

for (const action of ['logout', 'switch'] as const) test(`a delayed refresh cannot restore credentials after ${action}`, async () => {
  const response = deferred<User>(), started = deferred<void>();
  const f = fixture(async () => { started.resolve(); return response.promise; });
  await f.login(); f.expire();
  const pending = f.first.get(); const rejected = assert.rejects(pending, ApiError);
  await started.promise;
  if (action === 'logout') await f.tab().signOut(); else await f.login(user('other', 3600, 'other'));
  response.resolve(user('access-two')); await rejected;
  assert.equal((await f.tab().get())?.user.access_token, action === 'logout' ? undefined : 'other');
});

test('an old invalid_grant does not delete a newer account', async () => {
  const response = deferred<void>(), started = deferred<void>();
  const f = fixture(async () => { started.resolve(); await response.promise; throw new ErrorResponse({ error: 'invalid_grant' }); });
  await f.login(); f.expire();
  const pending = f.first.get(); const rejected = assert.rejects(pending, ApiError);
  await started.promise; await f.login(user('other', 3600, 'other')); response.resolve(); await rejected;
  assert.equal((await f.tab().get())?.user.access_token, 'other');
});

test('a revoked refresh token clears only its own session and notifies once', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new ErrorResponse({ error: 'invalid_grant' }); });
  await f.login(); f.expire(); f.notifications.length = 0;
  await Promise.allSettled(Array.from({ length: 4 }, () => f.tab().get()));
  assert.equal(await f.first.get(), null); assert.equal(calls, 1); assert.equal(f.notifications.length, 1);
  assert.ok(!f.storage.getItem('session')!.includes('refresh-access-one'));
});

test('offline refresh preserves an expired session and shares a 30s cooldown without sending old tokens', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw new TypeError('offline'); });
  await f.login(); f.expire();
  await assert.rejects(f.first.get(), RefreshUnavailable);
  await assert.rejects(f.tab().get(), RefreshUnavailable);
  assert.equal(calls, 1); assert.ok(JSON.parse(f.storage.getItem('session')!).user);
});

test('temporary refresh failure permits a still-valid access token, not a token rejected by the API', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw new Error('HTTP 503'); });
  await f.login(user('access-one', 40));
  assert.equal((await f.first.get())?.user.access_token, 'access-one');
  assert.equal((await f.tab().get())?.user.access_token, 'access-one');
  await assert.rejects(f.tab().get('access-one'), RefreshUnavailable); assert.equal(calls, 1);
});

test('late 401 uses a rotated token without a second refresh; stale 401 cannot clear it', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return user('access-two'); });
  await f.login(); const original = (await f.first.get())!;
  await f.first.get(original.user.access_token);
  assert.equal((await f.tab().get(original.user.access_token))?.user.access_token, 'access-two');
  await f.first.expire(original);
  assert.equal((await f.first.get())?.user.access_token, 'access-two'); assert.equal(calls, 1);
});

test('default SSO retains consent, while local explicit logout preserves account-switch intent', async () => {
  const f = fixture();
  assert.equal((await f.first.beginLogin()).prompt, 'consent');
  await f.first.signOut(); assert.equal((await f.tab().beginLogin()).prompt, 'login consent');
});

test('a late login callback cannot replace a later login or resurrect a signed-out account', async () => {
  const f = fixture(), pending = await f.first.beginLogin();
  await f.first.signOut(); await assert.rejects(f.first.finishLogin(pending.id, user()), ApiError);
  await f.login(user('other', 3600, 'other'));
  await assert.rejects(f.first.finishLogin(pending.id, user()), ApiError);
  assert.equal((await f.first.get())?.user.access_token, 'other');
});

test('requests bound before logout/relogin fail even when the same subject signs back in', async () => {
  const f = fixture(); const id = await f.login(); await f.first.signOut(); await f.login();
  await assert.rejects(f.first.get(undefined, id), ApiError);
});

test('invalid renewal or unexpected subject fails closed without saving new credentials', async () => {
  const f = fixture(async () => user('different', 3600, 'other'));
  await f.login(); f.expire(); await assert.rejects(f.first.get(), ApiError);
  assert.equal(await f.first.get(), null);
});

test('a corrupt stored record is not restored as an authenticated identity', async () => {
  const f = fixture(); f.storage.setItem('session', JSON.stringify({ id: 'old', user: '{"access_token":"old"}' }));
  assert.equal(await f.first.get(), null);
});
