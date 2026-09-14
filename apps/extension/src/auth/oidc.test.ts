import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finishOidc, startOidc, type AuthConfig } from './oidc';

const KEY = 'nc-oidc-pending';
const API = 'https://comics.example.test';
const READER = 'https://reader.example.test/reader.html';
const TOKEN = 'test-access-token';
const user = { id: 'oidc-test-user', name: 'Test reader', role: 'user' };
const config: AuthConfig = {
  mode: 'oidc', dev_auth: false, issuer: 'https://identity.example.test',
  client_id: 'test-public-client', audience: API,
  authorization_endpoint: 'https://identity.example.test/authorize',
  token_endpoint: 'https://identity.example.test/token', scopes: 'openid profile',
};
type Pending = {
  state: string; verifier: string; redirect: string; created: number;
  apiBase: string; tokenEndpoint: string; clientId: string;
};

let current: URL;
let entries: Map<string, string>;
let assigned: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  current = new URL(READER);
  entries = new Map();
  assigned = vi.fn();
  request = vi.fn(async () => { throw Error('Unexpected network request'); });
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('chrome', undefined);
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('location', {
    get href() { return current.href; },
    get origin() { return current.origin; },
    get pathname() { return current.pathname; },
    get search() { return current.search; },
    get hash() { return current.hash; },
    assign: assigned,
  });
  vi.stubGlobal('history', {
    replaceState: vi.fn((_state: unknown, _unused: string, url: string) => {
      current = new URL(url, current);
    }),
  });
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  });
});
afterEach(() => vi.unstubAllGlobals());

async function begin(): Promise<Pending> {
  expect(await startOidc(config, API)).toBeNull();
  expect(assigned).toHaveBeenCalledOnce();
  return JSON.parse(entries.get(KEY)!) as Pending;
}
function callback(pending: Pending, base = pending.redirect) {
  const url = new URL(base);
  url.search = new URLSearchParams({ state: pending.state, code: 'test-code' }).toString();
  return url;
}
function successfulResponses() {
  request.mockResolvedValueOnce(Response.json({ access_token: TOKEN }));
  request.mockResolvedValueOnce(Response.json({ user }));
}

describe('OIDC public-client boundaries', () => {
  it('binds an S256 challenge to the exact verifier used in the token exchange', async () => {
    const pending = await begin();
    const authorization = new URL(assigned.mock.calls[0][0]);
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(pending.verifier).digest('base64url'),
    );
    expect(authorization.searchParams.get('state')).toBe(pending.state);
    expect(authorization.searchParams.get('redirect_uri')).toBe(READER);
    expect(authorization.searchParams.get('resource')).toBe(API);
    successfulResponses();
    current = callback(pending);
    expect(await finishOidc()).toEqual({ token: TOKEN, user, apiOrigin: API });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe(config.token_endpoint);
    const exchange = request.mock.calls[0][1] as RequestInit;
    expect(exchange.method).toBe('POST');
    expect(exchange.body).toBeInstanceOf(URLSearchParams);
    const body = exchange.body as URLSearchParams;
    expect(body.get('code_verifier')).toBe(pending.verifier);
    expect(body.get('resource')).toBe(API);
    expect(body.get('redirect_uri')).toBe(READER);
    expect(body.get('client_id')).toBe(config.client_id);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('test-code');
    expect(request.mock.calls[1][0]).toBe(API + '/v1/me');
    expect(request.mock.calls[1][1]).toMatchObject({ headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(entries.has(KEY)).toBe(false);
    expect(current.search).toBe('');
  });

  it.each(['state', 'origin', 'path', 'expiry'] as const)(
    'rejects a mismatched %s before making any token or API request', async (mismatch) => {
      const pending = await begin();
      if (mismatch === 'expiry') {
        pending.created = Date.now() - 600001;
        entries.set(KEY, JSON.stringify(pending));
      }
      current = callback(pending);
      if (mismatch === 'state') current.searchParams.set('state', 'different-state');
      if (mismatch === 'origin') current = callback(pending, 'https://other.example.test/reader.html');
      if (mismatch === 'path') current = callback(pending, 'https://reader.example.test/other.html');
      await expect(finishOidc()).rejects.toThrow('登录状态无效或已过期');
      expect(request).not.toHaveBeenCalled();
      expect(current.search).toBe('');
    },
  );

  it('consumes the callback once even when the same code is replayed', async () => {
    const pending = await begin();
    successfulResponses();
    current = callback(pending);
    await finishOidc();
    current = callback(pending);
    await expect(finishOidc()).rejects.toThrow('缺少本次登录上下文');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not establish an identity from a token response rejected by the product API', async () => {
    const pending = await begin();
    request.mockResolvedValueOnce(Response.json({ access_token: TOKEN }));
    request.mockResolvedValueOnce(Response.json({ error: { code: 'INVALID_TOKEN', message: 'Invalid token' } }, { status: 401 }));
    current = callback(pending);
    await expect(finishOidc()).rejects.toThrow('Invalid token');
    expect(entries.has(KEY)).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not exchange a callback reporting an authorization error', async () => {
    const pending = await begin();
    current = new URL(pending.redirect);
    current.search = new URLSearchParams({ state: pending.state, error: 'access_denied' }).toString();
    await expect(finishOidc()).rejects.toThrow('身份服务未完成登录');
    expect(entries.has(KEY)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('returns the API origin captured at login even if another tab changes service settings', async () => {
    const pending = await begin();
    const changedService = 'https://different-comics.example.test';
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ apiBase: changedService }),
    });
    successfulResponses();
    current = callback(pending);
    const result = await finishOidc();
    expect(result?.apiOrigin).toBe(API);
    expect(result?.apiOrigin).not.toBe(changedService);
    expect(request.mock.calls[1][0]).toBe(API + '/v1/me');
  });

  it('rejects insecure remote identity endpoints before redirecting', async () => {
    await expect(startOidc({ ...config, token_endpoint: 'http://identity.example.test/token' }, API))
      .rejects.toThrow('身份服务必须使用 HTTPS');
    expect(assigned).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(entries.has(KEY)).toBe(false);
  });

  it('runs the extension redirect through the same PKCE exchange and identity verification', async () => {
    const redirect = 'https://test-extension.chromiumapp.org/oidc';
    const launch = vi.fn(async ({ url }: { url: string }) => {
      const authorization = new URL(url);
      const pending = JSON.parse(entries.get(KEY)!) as Pending;
      expect(authorization.searchParams.get('redirect_uri')).toBe(redirect);
      expect(pending.redirect).toBe(redirect);
      return callback(pending).href;
    });
    const permissions = vi.fn(async () => true);
    vi.stubGlobal('chrome', {
      permissions: { request: permissions },
      identity: { getRedirectURL: () => redirect, launchWebAuthFlow: launch },
    });
    successfulResponses();
    expect(await startOidc(config, API)).toEqual({ token: TOKEN, user, apiOrigin: API });
    expect(permissions).toHaveBeenCalledWith({ origins: ['https://identity.example.test/*'] });
    expect(launch).toHaveBeenCalledOnce();
    expect(assigned).not.toHaveBeenCalled();
    expect(entries.has(KEY)).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
