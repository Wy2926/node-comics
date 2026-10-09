import { OidcClient, User, WebStorageStateStore, type RefreshState } from 'oidc-client-ts';
import { accountReturnPath, oidcSettings, type AuthConfig } from './auth-config';
import { ApiError, SharedSession, changedSession, sessionPrefix, validUser } from './auth-session';
export { ApiError } from './auth-session';
export interface AuthIdentity { id: string; subject: string }

const changes = new EventTarget();
let connectionPromise: Promise<{ client: OidcClient; sessions: SharedSession }> | undefined;

async function connection() {
  if (!connectionPromise) connectionPromise = (async () => {
    const response = await fetch('/v1/auth/config', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('暂时无法连接登录服务，请重试。');
    const config = await response.json() as AuthConfig;
    const client = new OidcClient({ ...oidcSettings(config, location.origin),
      stateStore: new WebStorageStateStore({ store: sessionStorage, prefix: 'nc-site-state:' }),
    });
    await client.clearStaleState();
    const sessions = new SharedSession(localStorage, sessionPrefix + config.issuer + ':' + config.client_id,
      navigator.locks, async user => {
        const state: RefreshState = { ...user, refresh_token: user.refresh_token!, data: user.state };
        return new User({ ...state, ...await client.useRefreshToken({ state, resource: config.audience, timeoutInSeconds: 15 }) });
      }, () => changes.dispatchEvent(new Event('change')));
    return { client, sessions };
  })().catch(error => { connectionPromise = undefined; throw error; });
  return connectionPromise;
}

export function subscribeAuth(listener: () => void) {
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null) { listener(); return; }
    if (!event.key.startsWith(sessionPrefix)) return;
    // Rotation changes tokens, not the account. Do not reload every subscriber.
    const identity = (raw: string | null) => {
      try { const value = JSON.parse(raw ?? 'null'); return [value?.id, !!value?.user]; } catch { return []; }
    };
    if (JSON.stringify(identity(event.oldValue)) !== JSON.stringify(identity(event.newValue))) listener();
  };
  changes.addEventListener('change', listener);
  window.addEventListener('storage', storageChanged);
  return () => { changes.removeEventListener('change', listener); window.removeEventListener('storage', storageChanged); };
}

export async function signIn(returnPath = '/account/') {
  const { client, sessions } = await connection();
  const login = await sessions.beginLogin();
  sessionStorage.setItem('nc-site-return', accountReturnPath(returnPath));
  const request = await client.createSigninRequest({ state: { sessionId: login.id }, prompt: login.prompt });
  sessions.assert(login.id);
  location.assign(request.url);
}

export function loginReturnPath() {
  const path = sessionStorage.getItem('nc-site-return') || '/account/';
  sessionStorage.removeItem('nc-site-return');
  return accountReturnPath(path);
}

export async function signOut() { await (await connection()).sessions.signOut(); }

function hasStoredSession() {
  let present = false;
  for (let index = 0; index < localStorage.length && !present; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(sessionPrefix)) continue;
    try { present = !!JSON.parse(localStorage.getItem(key) ?? 'null')?.user; } catch { /* Ignore invalid records. */ }
  }
  return present;
}

export async function session() {
  if (!hasStoredSession()) return null;
  return (await (await connection()).sessions.get())?.user ?? null;
}

export async function sessionIdentity(): Promise<AuthIdentity | null> {
  if (!hasStoredSession()) return null;
  const binding = await (await connection()).sessions.get();
  return binding ? { id: binding.id, subject: binding.user.profile.sub } : null;
}

export async function assertSession(id: string) { (await connection()).sessions.assert(id); }

export async function finishLogin() {
  const callback = location.href;
  // Remove the authorization code before any further navigation or account request.
  history.replaceState(null, '', '/auth/callback/');
  const { client, sessions } = await connection();
  try {
    const user = new User(await client.processSigninResponse(callback));
    const id = (user.state as { sessionId?: string } | undefined)?.sessionId;
    if (!id || !validUser(user) || user.expired) throw changedSession();
    sessions.assert(id);
    // Verify the product identity before persisting anything from the callback.
    const response = await fetch('/v1/me', { headers: { Authorization: 'Bearer ' + user.access_token },
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw changedSession();
    const product = await response.json();
    if (typeof product.user?.id !== 'string' || !product.user.id) throw changedSession();
    await sessions.finishLogin(id, user);
  } catch { throw Error('登录未完成或授权已过期，请返回账户页重新登录。'); }
}

export async function authenticatedFetch(path: string, options: RequestInit = {}, identity?: AuthIdentity): Promise<Response> {
  if (!path.startsWith('/v1/')) throw Error('无效的账户请求');
  const { sessions } = await connection();
  let binding = await sessions.get(undefined, identity?.id);
  if (!binding || identity && binding.user.profile.sub !== identity.subject) throw new ApiError('请登录后查看账户。', 401);
  const id = binding.id;
  const send = (token: string) => {
    sessions.assert(id);
    const headers = new Headers(options.headers);
    headers.set('Authorization', 'Bearer ' + token);
    return fetch(path, { ...options, credentials: 'omit', cache: 'no-store', headers });
  };
  let response = await send(binding.user.access_token);
  sessions.assert(id);
  // Writes are never replayed. A late 401 reuses a token rotated by another tab.
  if (response.status === 401 && ['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase())) {
    const renewed = await sessions.get(binding.user.access_token, id);
    if (!renewed) throw changedSession();
    binding = renewed;
    response = await send(binding.user.access_token);
    sessions.assert(id);
  }
  if (response.status === 401) await sessions.expire(binding);
  return response;
}

export async function api<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, headers?: Record<string,string>, identity?: AuthIdentity): Promise<T> {
  const bound = identity ?? await sessionIdentity();
  if (!bound) throw new ApiError('请登录后查看账户。', 401);
  const response = await authenticatedFetch(path, { method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  }, bound);
  const result = response.ok ? await response.json() : await response.json().catch(() => ({}));
  if (response.status !== 401) await assertSession(bound.id);
  if (!response.ok) {
    throw new ApiError(result.error?.message || '账户服务暂时不可用，请重试。', response.status, result.error?.code);
  }
  return result as T;
}
