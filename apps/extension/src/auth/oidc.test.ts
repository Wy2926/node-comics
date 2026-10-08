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
  request.mockResolvedValueOnce(Response.json({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: 'test-refresh' }));
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
    expect(authorization.searchParams.get('prompt')).toBe('login consent');
    expect(authorization.searchParams.get('scope')?.split(' ')).toContain('offline_access');
    successfulResponses();
    current = callback(pending);
    expect(await finishOidc()).toMatchObject({ token: TOKEN, user, apiOrigin: API });
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
    expect(new Headers(request.mock.calls[1][1].headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(entries.has(KEY)).toBe(false);
    expect(current.search).toBe('');
  });

  it.each([
    {access_token:TOKEN,token_type:'Bearer',expires_in:3600},
    {access_token:TOKEN,token_type:'Bearer',refresh_token:'refresh'},
    {access_token:TOKEN,token_type:'Bearer',refresh_token:'refresh',expires_in:0},
  ])('rejects incomplete renewable credentials before trusting an identity',async tokens=>{
    const pending=await begin();request.mockResolvedValueOnce(Response.json(tokens));current=callback(pending);
    await expect(finishOidc()).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
  });

  it('captures expiry and refresh credentials from the same authorization exchange',async()=>{
    const pending=await begin();successfulResponses();current=callback(pending);
    const before=Date.now(),session=await finishOidc();
    expect(session).toMatchObject({id:expect.any(String),credential:{kind:'oidc',refreshToken:'test-refresh',clientId:config.client_id,tokenEndpoint:config.token_endpoint,resource:API}});
    expect(session!.expiresAt).toBeGreaterThanOrEqual(before+3600000);
    expect(session!.refreshAt).toBe(session!.expiresAt-60000);
  });

  it.each(['state', 'origin', 'path', 'expiry', 'issuer', 'duplicate-code', 'duplicate-state', 'duplicate-issuer', 'mixed-result', 'fragment', 'userinfo'] as const)(
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
      if (mismatch === 'issuer') current.searchParams.set('iss', 'https://other-issuer.example.test');
      if (mismatch === 'duplicate-code') current.searchParams.append('code', 'another-code');
      if (mismatch === 'duplicate-state') current.searchParams.append('state', pending.state);
      if (mismatch === 'duplicate-issuer') current.searchParams.append('iss', config.issuer), current.searchParams.append('iss', config.issuer);
      if (mismatch === 'mixed-result') current.searchParams.set('error', 'access_denied');
      if (mismatch === 'fragment') current.hash = 'fragment';
      if (mismatch === 'userinfo') current.username = 'other-user';
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
    request.mockResolvedValueOnce(Response.json({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: 'test-refresh' }));
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

  it.each(['web', 'extension'] as const)('allows a different account on a subsequent %s sign-in', async (platform) => {
    const authorizations: URL[] = [];
    if (platform === 'extension') {
      vi.stubGlobal('chrome', {
        runtime: { id: 'test-extension' },
        permissions: { contains: vi.fn(async () => true) },
        identity: {
          getRedirectURL: () => 'https://test-extension.chromiumapp.org/oidc',
          launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
            authorizations.push(new URL(url));
            return callback(JSON.parse(entries.get(KEY)!) as Pending).href;
          }),
        },
      });
    }
    const otherUser = { ...user, id: 'other-user', name: 'Other reader' };
    for (const [index, selectedUser] of [user, otherUser].entries()) {
      const token = `selected-account-token-${index}`;
      request.mockResolvedValueOnce(Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: 'test-refresh' }));
      request.mockResolvedValueOnce(Response.json({ user: selectedUser }));
      let session = await startOidc(config, API);
      if (platform === 'web') {
        authorizations.push(new URL(assigned.mock.calls[index][0]));
        current = callback(JSON.parse(entries.get(KEY)!) as Pending);
        session = await finishOidc();
      }
      expect(session).toMatchObject({ token, user: selectedUser, apiOrigin: API });
      expect(authorizations[index].searchParams.get('prompt')).toBe('login consent');
      expect(entries.has(KEY)).toBe(false);
    }
    expect(authorizations[0].searchParams.get('state')).not.toBe(authorizations[1].searchParams.get('state'));
    expect(authorizations[0].searchParams.get('code_challenge')).not.toBe(authorizations[1].searchParams.get('code_challenge'));
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('runs the extension redirect through the same PKCE exchange and identity verification', async () => {
    const redirect = 'https://test-extension.chromiumapp.org/oidc';
    const launch = vi.fn(async ({ url }: { url: string }) => {
      const authorization = new URL(url);
      const pending = JSON.parse(entries.get(KEY)!) as Pending;
      expect(authorization.searchParams.get('redirect_uri')).toBe(redirect);
      expect(authorization.searchParams.get('prompt')).toBe('login consent');
      expect(pending.redirect).toBe(redirect);
      return callback(pending).href;
    });
    const permissions = vi.fn(async () => true);
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-extension' },
      permissions: { contains: permissions, request: vi.fn() },
      identity: { getRedirectURL: () => redirect, launchWebAuthFlow: launch },
    });
    successfulResponses();
    expect(await startOidc(config, API)).toMatchObject({ token: TOKEN, user, apiOrigin: API });
    expect(permissions).toHaveBeenCalledWith({ origins: ['https://identity.example.test/*'] });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
    expect(assigned).not.toHaveBeenCalled();
    expect(entries.has(KEY)).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('uses the registered callback and same exchange on an extension without identity', async () => {
    const event = {addListener: vi.fn(), removeListener: vi.fn()};
    const authorizations: URL[] = [];
    const remove = vi.fn(async () => undefined);
    const permissions = vi.fn(async () => true);
    vi.stubGlobal('chrome', {
      runtime: {id: 'comics@nodelane.net', getManifest: () => ({browser_specific_settings: {gecko: {id: 'comics@nodelane.net'}}})},
      permissions: {contains: permissions},
      tabs: {getCurrent: vi.fn(async () => ({id: 2})), create: vi.fn(async () => ({id: 4})), remove, onUpdated: event, onRemoved: event,
        update: vi.fn(async (_id: number, {url}: {url?: string; active?: boolean}) => {
          if (!url) return {id: 2};
          authorizations.push(new URL(url));
          const returned = callback(JSON.parse(entries.get(KEY)!) as Pending);
          returned.searchParams.set('iss', config.issuer);
          return {url: returned.href};
        })},
      webRequest: {onBeforeRequest: event},
    });
    successfulResponses();
    expect(await startOidc(config, API)).toMatchObject({token: TOKEN, user, apiOrigin: API});
    const redirect = 'https://b6537bc59408f22ed5813efab806261a7e62bd16.extensions.allizom.org/oidc';
    expect(authorizations[0].searchParams.get('redirect_uri')).toBe(redirect);
    expect(authorizations[0].searchParams.get('code_challenge_method')).toBe('S256');
    expect(permissions).toHaveBeenCalledExactlyOnceWith({origins: ['https://identity.example.test/*', new URL(redirect).origin + '/*']});
    expect((request.mock.calls[0][1].body as URLSearchParams).get('redirect_uri')).toBe(redirect);
    expect(assigned).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledExactlyOnceWith(4);
    expect(entries.has(KEY)).toBe(false);
  });
});
