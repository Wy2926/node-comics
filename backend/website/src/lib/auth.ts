import { UserManager, WebStorageStateStore, ErrorResponse, type User } from 'oidc-client-ts';
import { oidcSettings, type AuthConfig } from './auth-config';
let managerPromise: Promise<UserManager> | undefined;
let renewal: Promise<User | null> | undefined;
let generation = 0;
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }

export async function manager() {
  if (!managerPromise) managerPromise = (async () => {
    const response = await fetch('/v1/auth/config', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('暂时无法连接登录服务，请重试。');
    const config = await response.json() as AuthConfig;
    const value = new UserManager({ ...oidcSettings(config, location.origin),
      userStore: new WebStorageStateStore({ store: sessionStorage, prefix: 'nc-site-user:' }),
      stateStore: new WebStorageStateStore({ store: sessionStorage, prefix: 'nc-site-state:' }),
    });
    await value.clearStaleState();
    return value;
  })().catch(error => { managerPromise = undefined; throw error; });
  return managerPromise;
}

export async function signIn(returnPath = '/account/') {
  const auth = await manager();
  sessionStorage.setItem('nc-site-return', /^\/(?:zh-tw\/|en\/|ja\/|ko\/)?account\/$/.test(returnPath) ? returnPath : '/account/');
  await auth.signinRedirect({ prompt: 'login consent' });
}

export function loginReturnPath() {
  const path = sessionStorage.getItem('nc-site-return') || '/account/';
  sessionStorage.removeItem('nc-site-return');
  return /^\/(?:zh-tw\/|en\/|ja\/|ko\/)?account\/$/.test(path) ? path : '/account/';
}

export async function signOut() {
  generation++;
  const auth = await manager();
  await auth.removeUser();
  // A token response already in flight must not restore the local session.
  if (renewal) await renewal.catch(() => undefined);
  await auth.removeUser();
}

async function renew(auth: UserManager) {
  if (!renewal) {
    const started = generation;
    renewal = auth.signinSilent().then(async user => {
      if (started !== generation) { await auth.removeUser(); return null; }
      return user;
    }).catch(async error => {
      if (error instanceof ErrorResponse && ['invalid_grant','login_required','interaction_required'].includes(error.error ?? '')) await auth.removeUser();
      throw Error('登录续期未完成，请检查网络后重试；授权已失效时请重新登录。');
    }).finally(() => { renewal = undefined; });
  }
  return renewal;
}

export async function session(forceRenew = false) {
  const auth = await manager();
  let user = await auth.getUser();
  if (!user) return null;
  if (forceRenew || user.expired || (user.expires_in ?? 0) < 60) {
    if (!user.refresh_token) { await auth.removeUser(); return null; }
    user = await renew(auth);
  }
  return user;
}

export async function finishLogin() {
  const callback = location.href;
  // Remove the authorization code before any further navigation or account request.
  history.replaceState(null, '', '/auth/callback/');
  const auth = await manager();
  try {
    const user = await auth.signinRedirectCallback(callback);
    if (!user.access_token || !user.refresh_token || user.token_type?.toLowerCase() !== 'bearer' || user.expired || !user.expires_at) throw Error('无效会话');
    await api('/v1/me'); // Never use unverified browser claims as product identity.
  } catch {
    await auth.removeUser();
    throw Error('登录未完成或授权已过期，请返回账户页重新登录。');
  }
}

export async function api<T>(path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  if (!path.startsWith('/v1/')) throw Error('无效的账户请求');
  const started = generation;
  let user = await session();
  if (!user) throw new ApiError('请登录后查看账户。', 401);
  const send = (token: string) => fetch(path, { method, credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  let response = await send(user.access_token);
  // Only read requests are replayed automatically; checkout mutations are explicit.
  if (response.status === 401 && method === 'GET' && user.refresh_token && generation === started) {
    user = await session(true);
    if (user && generation === started) response = await send(user.access_token);
  }
  if (started !== generation) throw new ApiError('账户已退出，请重新登录。', 401);
  if (!response.ok) {
    if (response.status === 401) await (await manager()).removeUser();
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error?.message || '账户服务暂时不可用，请重试。', response.status);
  }
  return response.json() as Promise<T>;
}
