import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const scope = 'https://www.googleapis.com/auth/drive.file';
const firstToken = 'synthetic-drive-token-one';
const nextToken = 'synthetic-drive-token-two';
const accountResponse = (id = 'permission-account') => Response.json({user: {permissionId: id, displayName: 'Reader'}});
let getAuthToken: ReturnType<typeof vi.fn>;
let removeCachedAuthToken: ReturnType<typeof vi.fn>;
let getManifest: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  getAuthToken = vi.fn().mockResolvedValue({token: firstToken, grantedScopes: [scope]});
  removeCachedAuthToken = vi.fn().mockResolvedValue(undefined);
  getManifest = vi.fn().mockReturnValue({oauth2: {client_id: 'configured.apps.googleusercontent.com', scopes: [scope]}});
  request = vi.fn().mockImplementation(async () => accountResponse());
  vi.stubGlobal('chrome', {runtime: {getManifest}, identity: {getAuthToken, removeCachedAuthToken}});
  vi.stubGlobal('navigator', {userAgent: 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36'});
  vi.stubGlobal('fetch', request);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Chrome-managed Drive credentials', () => {
  it('requests only drive.file and uses Drive permissionId as the verified account identity', async () => {
    const {chromeDriveAvailable, requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    expect(chromeDriveAvailable()).toBe(true);
    expect(await requestChromeDriveToken(true, 'permission-account')).toEqual({accessToken: firstToken, account: {id: 'permission-account', displayName: 'Reader'}});
    expect(getAuthToken).toHaveBeenCalledExactlyOnceWith({interactive: true, scopes: [scope], enableGranularPermissions: true});
    expect(request).toHaveBeenCalledExactlyOnceWith('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress)', expect.objectContaining({credentials: 'omit', redirect: 'error'}));
    expect((request.mock.calls[0][1].headers as Headers).get('Authorization')).toBe(`Bearer ${firstToken}`);
  });

  it.each(['Edg/153.0', 'EdgA/141.0', 'EdgiOS/141.0'])('falls back for Edge %s even if a partial identity API exists', async browser => {
    vi.stubGlobal('navigator', {userAgent: `Mozilla/5.0 Chrome/141.0 ${browser}`});
    const {chromeDriveAvailable, requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    expect(chromeDriveAvailable()).toBe(false);
    await expect(requestChromeDriveToken(true)).rejects.toMatchObject({code: 'not-configured'});
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, {client_id: '', scopes: [scope]}, {client_id: 'client', scopes: []}, {client_id: 'client', scopes: ['openid']}])('falls back when manifest OAuth configuration is absent or incomplete', async oauth2 => {
    getManifest.mockReturnValue({oauth2});
    const {chromeDriveAvailable} = await import('../src/comics/sources/google-drive/chrome-auth');
    expect(chromeDriveAvailable()).toBe(false);
  });

  it('falls back for Firefox without getAuthToken, missing chrome, and unavailable manifest', async () => {
    const {chromeDriveAvailable} = await import('../src/comics/sources/google-drive/chrome-auth');
    vi.stubGlobal('navigator', {userAgent: 'Mozilla/5.0 Firefox/141.0'});
    vi.stubGlobal('chrome', {runtime: {getManifest}, identity: {launchWebAuthFlow: vi.fn()}});
    expect(chromeDriveAvailable()).toBe(false);
    vi.stubGlobal('chrome', undefined);
    expect(chromeDriveAvailable()).toBe(false);
    vi.stubGlobal('chrome', {runtime: {getManifest: () => { throw Error('unavailable'); }}, identity: {getAuthToken}});
    expect(chromeDriveAvailable()).toBe(false);
  });

  it.each([undefined, null, {}, {token: ''}, {token: 'short'}, {token: 'invalid token value'}, {token: 'invalid\nheader-token'}, {token: 'a'.repeat(8193)}])('rejects missing and malformed credentials before any network request', async result => {
    getAuthToken.mockResolvedValue(result);
    const {requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    await expect(requestChromeDriveToken(true)).rejects.toMatchObject({code: 'reconnect-required'});
    expect(request).not.toHaveBeenCalled();
    expect(removeCachedAuthToken).not.toHaveBeenCalled();
  });

  it.each([undefined, [], ['openid'], scope, [scope, 42]])('rejects denied or malformed granted scopes before verification', async grantedScopes => {
    getAuthToken.mockResolvedValue({token: firstToken, grantedScopes});
    const {requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    await expect(requestChromeDriveToken(true)).rejects.toMatchObject({code: 'reconnect-required'});
    expect(request).not.toHaveBeenCalled();
    expect(removeCachedAuthToken).not.toHaveBeenCalled();
  });

  it('reports explicit cancellation without forwarding Chrome error details', async () => {
    getAuthToken.mockRejectedValue(Error(`The user did not approve access. ${firstToken}`));
    const {requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    await expect(requestChromeDriveToken(true)).rejects.toMatchObject({code: 'cancelled', message: '已取消 Google Drive 授权。'});
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects an unexpected Drive account and does not invalidate its credential', async () => {
    const {requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    await expect(requestChromeDriveToken(false, 'another-permission-account')).rejects.toMatchObject({code: 'account-mismatch'});
    expect(removeCachedAuthToken).not.toHaveBeenCalled();
    expect(getAuthToken).toHaveBeenCalledTimes(1);
  });

  it('removes a credential rejected with 401 and retries exactly once without prompting', async () => {
    getAuthToken.mockResolvedValueOnce({token: firstToken, grantedScopes: [scope]}).mockResolvedValueOnce({token: nextToken, grantedScopes: [scope]});
    request.mockResolvedValueOnce(new Response('', {status: 401})).mockResolvedValueOnce(accountResponse());
    const {requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    expect((await requestChromeDriveToken(true)).accessToken).toBe(nextToken);
    expect(removeCachedAuthToken).toHaveBeenCalledExactlyOnceWith({token: firstToken});
    expect(getAuthToken.mock.calls.map(([details]) => details.interactive)).toEqual([true, false]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not loop when the replacement credential is also rejected', async () => {
    request.mockImplementation(async () => new Response('', {status: 401}));
    const {requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    await expect(requestChromeDriveToken(true)).rejects.toMatchObject({code: 'reconnect-required'});
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    expect(removeCachedAuthToken).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([403, 429, 503])('does not clear Chrome credentials for non-401 API failure %i', async status => {
    request.mockResolvedValue(new Response('', {status}));
    const {requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    await expect(requestChromeDriveToken(false)).rejects.toMatchObject({code: 'unavailable'});
    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(removeCachedAuthToken).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected identity, network and cache-removal errors', async () => {
    const {requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    getAuthToken.mockRejectedValueOnce(Error(`OAuth failed: ${firstToken}`));
    await expect(requestChromeDriveToken(false)).rejects.toMatchObject({code: 'reconnect-required', message: 'Google Drive 需要重新连接，请点击连接账户后重试。'});
    request.mockRejectedValueOnce(Error(`Network failed: ${firstToken}`));
    await expect(requestChromeDriveToken(false)).rejects.toMatchObject({code: 'offline', message: '无法核验 Google Drive 账户，请检查网络后重试。'});
    request.mockResolvedValueOnce(new Response('', {status: 401}));
    removeCachedAuthToken.mockRejectedValueOnce(Error(`Cache failed: ${firstToken}`));
    await expect(requestChromeDriveToken(false)).rejects.toMatchObject({code: 'reconnect-required', message: 'Google Drive 凭据无法更新，请重新连接。'});
  });

  it('merges simultaneous account verification and reuses it for at most five minutes', async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    request.mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve; }));
    const {requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    const first = requestChromeDriveToken(false), second = requestChromeDriveToken(false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    release(accountResponse());
    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    one.account.id = 'changed-by-caller';
    expect(two.account.id).toBe('permission-account');
    expect((await requestChromeDriveToken(false)).account.id).toBe('permission-account');
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60_000);
    await requestChromeDriveToken(false);
    expect(request).toHaveBeenCalledTimes(2);
    // Chrome remains the source of token validity on every request, even while identity is cached.
    expect(getAuthToken).toHaveBeenCalledTimes(4);
  });

  it('bounds the in-memory account cache and does not cache failed verification', async () => {
    const {requestChromeDriveToken} = await import('../src/comics/sources/google-drive/chrome-auth');
    request.mockResolvedValueOnce(Response.json({user: {displayName: 'Unverified'}}));
    await expect(requestChromeDriveToken(false)).rejects.toMatchObject({code: 'invalid-response'});
    await requestChromeDriveToken(false);
    expect(request).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 8; index++) {
      getAuthToken.mockResolvedValueOnce({token: `synthetic-extra-token-${index}`, grantedScopes: [scope]});
      await requestChromeDriveToken(false);
    }
    await requestChromeDriveToken(false);
    expect(request).toHaveBeenCalledTimes(11);
  });
});
