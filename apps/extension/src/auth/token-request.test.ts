import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {requestOidcToken} from './token-request';

const extensionUrl = 'moz-extension://private-profile-uuid/';
const endpoint = 'https://identity.example/token?client=one.test';
let request: ReturnType<typeof vi.fn>;
let update: ReturnType<typeof vi.fn>;
let lock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  let queue: Promise<unknown> = Promise.resolve();
  request = vi.fn(async () => new Response('{}'));
  update = vi.fn(async () => undefined);
  lock = vi.fn((_name: string, run: () => Promise<Response>) => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  });
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('navigator', {locks: {request: lock}});
  vi.stubGlobal('chrome', {runtime: {getURL: () => extensionUrl}, declarativeNetRequest: {updateSessionRules: update}});
});
afterEach(() => vi.unstubAllGlobals());

describe('OIDC token request Origin boundary', () => {
  it('limits the Firefox rule to our exact token POST and preserves request protections', async () => {
    const body = new URLSearchParams({grant_type: 'authorization_code', code_verifier: 'fixture-verifier'});
    await requestOidcToken(endpoint + '#ignored-fragment', body);
    const rule = update.mock.calls[0][0].addRules[0];
    expect(rule.action.requestHeaders).toEqual([{header: 'Origin', operation: 'remove'}]);
    expect(rule.condition.initiatorDomains).toEqual(['private-profile-uuid']);
    expect(rule.condition.requestMethods).toEqual(['post']);
    expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest']);
    expect(rule.condition.isUrlFilterCaseSensitive).toBe(true);
    const exact = new RegExp(rule.condition.regexFilter);
    expect(exact.test(endpoint)).toBe(true);
    for (const other of [endpoint + '&extra=1', endpoint.replace('one.test', 'oneXtest'), endpoint.replace('/token', '/other')]) {
      expect(exact.test(other)).toBe(false);
    }
    expect(request.mock.calls[0]).toEqual([endpoint, expect.objectContaining({
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', body,
      signal: expect.any(AbortSignal), headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    })]);
    expect(update.mock.calls[1][0]).toEqual({removeRuleIds: [rule.id]});
  });

  it.each([undefined, 'chrome-extension://chrome-public-id/', 'chrome-extension://edge-public-id/'])('uses the browser request unchanged for %s', async root => {
    vi.stubGlobal('chrome', root ? {runtime: {getURL: () => root}} : undefined);
    await requestOidcToken(endpoint, new URLSearchParams({grant_type: 'refresh_token'}));
    expect(request).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it('removes the rule on failure and allows the next exchange', async () => {
    request.mockRejectedValueOnce(new TypeError('Network failed'));
    await expect(requestOidcToken(endpoint, new URLSearchParams())).rejects.toThrow('Network failed');
    const rule = update.mock.calls[0][0].addRules[0];
    expect(update.mock.calls[1][0]).toEqual({removeRuleIds: [rule.id]});
    await expect(requestOidcToken(endpoint, new URLSearchParams())).resolves.toBeInstanceOf(Response);
    expect(update).toHaveBeenCalledTimes(4);
  });

  it('serializes exchanges so another endpoint cannot replace an in-flight rule', async () => {
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}));
    const first = requestOidcToken(endpoint, new URLSearchParams());
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const other = 'https://other.example/token';
    const second = requestOidcToken(other, new URLSearchParams());
    await Promise.resolve();
    expect(update).toHaveBeenCalledOnce();
    finish(new Response('{}'));
    await Promise.all([first, second]);
    expect(update).toHaveBeenCalledTimes(4);
    expect(new RegExp(update.mock.calls[2][0].addRules[0].condition.regexFilter).test(other)).toBe(true);
    expect(request.mock.calls.map(call => call[0])).toEqual([endpoint, other]);
  });

  it.each(['http://identity.example/token', 'https://name:password@identity.example/token'])(
    'rejects unsafe token endpoints before a request: %s', async unsafe => {
      await expect(requestOidcToken(unsafe, new URLSearchParams())).rejects.toThrow('身份服务必须使用 HTTPS');
      expect(request).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );
});
