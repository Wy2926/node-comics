import { ApiError } from '../src/lib/auth-session';
import type { AuthIdentity } from '../src/lib/auth';
export { ApiError };
export type { AuthIdentity };

export const liveOrigin = 'http://127.0.0.1:5195';
export const liveAccounts = ['document-local-paid', 'document-local-other'] as const;
const storageKey = 'nc-document-live-session:v1', changes = new EventTarget();
interface LocalSession extends AuthIdentity { accessToken: string; expiresAt: number; username: string }
let loginVersion = 0;

export function requireLiveOrigin() {
  if (location.origin !== liveOrigin) throw new ApiError('此测试登录只允许在 http://127.0.0.1:5195 使用。', 403, 'LOCAL_ORIGIN_REQUIRED');
}

export function liveApiPath(path: string) {
  requireLiveOrigin();
  const url = new URL(path, liveOrigin);
  if (!path.startsWith('/v1/') || path.includes('\\') || url.origin !== liveOrigin || !url.pathname.startsWith('/v1/') || url.hash) {
    throw new ApiError('测试令牌只允许发送给本地 /v1/ 接口。', 400, 'LOCAL_API_REQUIRED');
  }
  return url.pathname + url.search;
}

function storedSession(): LocalSession | null {
  requireLiveOrigin();
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (typeof value?.id === 'string' && value.id && typeof value.subject === 'string' && value.subject &&
        typeof value.accessToken === 'string' && value.accessToken.length > 0 && value.accessToken.length <= 32768 &&
        Number.isFinite(value.expiresAt) && value.expiresAt > Date.now() && liveAccounts.includes(value.username)) return value;
  } catch { /* Invalid or expired local test sessions never authorize a request. */ }
  return null;
}

function changedSession() { return new ApiError('本地测试账户已退出或登录已过期，请重新登录。', 401, 'AUTH_REQUIRED'); }
function boundSession(identity?: AuthIdentity) {
  const current = storedSession();
  if (!current || identity && (identity.id !== current.id || identity.subject !== current.subject)) throw changedSession();
  return current;
}
export async function sessionIdentity(): Promise<AuthIdentity | null> {
  const current = storedSession();
  return current ? { id: current.id, subject: current.subject } : null;
}
export function localAccountName() { return storedSession()?.username ?? ''; }
export function subscribeAuth(listener: () => void) {
  changes.addEventListener('change', listener);
  return () => changes.removeEventListener('change', listener);
}
export async function assertSession(id: string) {
  if (storedSession()?.id !== id) throw changedSession();
}

export async function checkLocalApi() {
  const response = await fetch(liveApiPath('/v1/auth/config'), { credentials: 'omit', cache: 'no-store',
    redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new ApiError('本地 API 未启动或暂时不可用。', response.status, 'LOCAL_API_UNAVAILABLE');
  const config = await response.json();
  if (config.mode !== 'development' || config.dev_auth !== true) throw new ApiError('API 未开启隔离开发登录；不会尝试正式登录。', 403, 'LOCAL_DEV_AUTH_REQUIRED');
}

function clearSession() {
  loginVersion++;
  sessionStorage.removeItem(storageKey);
  changes.dispatchEvent(new Event('change'));
  return loginVersion;
}
export async function signOut() { requireLiveOrigin(); clearSession(); }

export async function loginAs(username: string) {
  requireLiveOrigin();
  if (!liveAccounts.some(account => account === username)) throw new ApiError('请选择启动器预置的本地测试账户。', 400);
  const version = clearSession();
  await checkLocalApi();
  const response = await fetch(liveApiPath('/v1/auth/dev'), { method: 'POST', body: JSON.stringify({ username }),
    headers: { 'Content-Type': 'application/json' }, credentials: 'omit', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new ApiError('本地开发登录失败，请检查隔离 API 与测试账户初始化。', response.status);
  const result = await response.json();
  if (version !== loginVersion) throw changedSession();
  if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 32768 ||
      typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer' || typeof result.user?.id !== 'string' || !result.user.id ||
      !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 86400) {
    throw new ApiError('本地登录响应无效；没有保存会话。', 502);
  }
  const current: LocalSession = { id: crypto.randomUUID(), subject: result.user.id, username,
    accessToken: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  sessionStorage.setItem(storageKey, JSON.stringify(current));
  changes.dispatchEvent(new Event('change'));
}

export async function signIn(_returnPath?: string) { await loginAs(liveAccounts[0]); }

export async function authenticatedFetch(path: string, options: RequestInit = {}, identity?: AuthIdentity): Promise<Response> {
  const target = liveApiPath(path), current = boundSession(identity), headers = new Headers(options.headers);
  headers.set('Authorization', 'Bearer ' + current.accessToken);
  const response = await fetch(target, { ...options, headers, credentials: 'omit', cache: 'no-store',
    redirect: 'error', referrerPolicy: 'no-referrer', signal: options.signal ?? AbortSignal.timeout(20000) });
  // Bind and expire in one synchronous segment: an old 401 must not clear a new login.
  boundSession(current);
  if (response.status === 401) { clearSession(); throw changedSession(); }
  return response; // No automatic write replay or invented API responses.
}
