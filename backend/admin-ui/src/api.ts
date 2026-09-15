import type {User} from './types';

const SESSION_KEY = 'nc-admin-session';
const PENDING_KEY = 'nc-admin-oidc';
let token = sessionStorage.getItem(SESSION_KEY) || '';
export const hasSession = () => !!token;
export function saveToken(value: string) {
  token = value;
  if (value) sessionStorage.setItem(SESSION_KEY, value);
  else {sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(PENDING_KEY);}
}
export class ApiError extends Error {
  constructor(message: string, public status: number) {super(message);}
}
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {cache: 'no-store', ...options,
    headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...options.headers}});
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error?.message || `请求失败 (${response.status})`, response.status);
  }
  return response.json();
}
export const errorText = (error: unknown) => error instanceof TypeError
  ? '连接失败，请检查服务是否运行，再点击刷新重试。' : error instanceof Error ? error.message : '请求失败，请重试。';
export const authError = (error: unknown) => error instanceof ApiError && [401, 403].includes(error.status);
export async function getAdmin() {
  const {user} = await request<{user: User}>('/v1/me');
  if (user.role !== 'admin') throw new ApiError('此账户没有管理员权限，请使用管理员账户登录。', 403);
  return user;
}
export type AuthConfig = {dev_auth: boolean; client_id: string; authorization_endpoint: string;
  token_endpoint: string; scopes: string; audience: string};
function secureUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw Error('身份服务需要 HTTPS 地址。');
  }
  return url;
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export async function startLogin(config: AuthConfig) {
  if (!config.client_id || !config.authorization_endpoint || !config.token_endpoint) throw Error('身份服务尚未配置完整，请检查服务端 OIDC 配置。');
  const url = secureUrl(config.authorization_endpoint);
  secureUrl(config.token_endpoint);
  const verifier = encode(crypto.getRandomValues(new Uint8Array(48)));
  const state = encode(crypto.getRandomValues(new Uint8Array(24)));
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const redirect = `${location.origin}/admin/`;
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({state, verifier, redirect, created: Date.now()}));
  url.search = new URLSearchParams({response_type: 'code', client_id: config.client_id, redirect_uri: redirect,
    scope: config.scopes || 'openid profile', state, code_challenge: challenge, code_challenge_method: 'S256',
    ...(config.audience ? {resource: config.audience, audience: config.audience} : {})}).toString();
  location.assign(url.href);
}
export async function finishLogin(config: AuthConfig) {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  const raw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  history.replaceState(null, '', location.pathname + location.hash);
  const pending = raw && JSON.parse(raw);
  if (!pending || pending.state !== params.get('state') || Date.now() - pending.created > 600000 ||
      pending.redirect !== location.origin + location.pathname) throw Error('登录状态无效或已过期，请重新登录。');
  if (params.has('error')) throw Error('身份服务未完成登录，请重试。');
  const endpoint = secureUrl(config.token_endpoint);
  const response = await fetch(endpoint.href, {method: 'POST', credentials: 'omit', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'authorization_code', client_id: config.client_id, code: params.get('code')!,
      redirect_uri: pending.redirect, code_verifier: pending.verifier, ...(config.audience ? {resource: config.audience} : {})})});
  if (!response.ok) throw Error('登录授权码交换失败，请重新登录。');
  const data = await response.json();
  if (typeof data.access_token !== 'string' || !data.access_token) throw Error('身份服务未返回访问令牌。');
  saveToken(data.access_token);
}
