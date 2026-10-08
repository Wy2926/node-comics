import 'fake-indexeddb/auto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {aniListProvider} from '../anilist';
import {connectAniList, disconnectAniList, getAniListAuthConfiguration, getTrackingCredential, validateAniListCallback} from '../auth';
import {beginPrivateTrackingAuthorization, commitPrivateTrackingCredential} from '../private-store';

const redirectUrl = 'https://test-extension.chromiumapp.org/anilist';
const callback = (state: string, token = 'secret-token') => `${redirectUrl}#${new URLSearchParams({state, access_token: token, token_type: 'Bearer', expires_in: '3600'})}`;
const credential = (accountId = 7, epoch = 'epoch-one') => ({accountId, name: 'Reader', token: 'secret-token', epoch, expiresAt: Date.now() + 60_000});
const deferred = <T>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};};
beforeEach(async () => {
  await disconnectAniList();
  vi.stubEnv('VITE_ANILIST_CLIENT_ID', '98765');
  vi.stubGlobal('chrome', {identity: {getRedirectURL: () => redirectUrl, launchWebAuthFlow: vi.fn(async ({url}: {url: string}) => callback(new URL(url).searchParams.get('state')!))}});
});
afterEach(async () => {await disconnectAniList(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();});

describe('AniList public-client OAuth safety', () => {
  it('uses our configured client and controlled browser redirect, verifies Viewer and stores no public token', async () => {
    const viewer = vi.spyOn(aniListProvider, 'viewer').mockResolvedValue({id: 7, name: 'Reader'});
    const value = await connectAniList();
    expect(viewer).toHaveBeenCalledWith('secret-token');
    expect(value).toMatchObject({accountId: 7, name: 'Reader', token: 'secret-token'});
    const launch = vi.mocked(chrome.identity.launchWebAuthFlow);
    const authorization = new URL(launch.mock.calls[0][0].url);
    expect(authorization.origin).toBe('https://anilist.co');
    expect(authorization.searchParams.get('client_id')).toBe('98765');
    expect(authorization.searchParams.get('redirect_uri')).toBe(redirectUrl);
    expect(authorization.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/);
    expect(authorization.searchParams.has('client_secret')).toBe(false);
    expect(await getTrackingCredential()).toEqual(value);
    expect((chrome as unknown as Record<string, unknown>).storage).toBeUndefined();
  });
  it('has no default/upstream client, token-paste fallback or web-preview authorization', async () => {
    vi.stubEnv('VITE_ANILIST_CLIENT_ID', '');
    expect(getAniListAuthConfiguration()).toMatchObject({configured: false, clientId: '', redirectUrl});
    await expect(connectAniList()).rejects.toMatchObject({code: 'configuration'});
    expect(chrome.identity.launchWebAuthFlow).not.toHaveBeenCalled();
    vi.stubEnv('VITE_ANILIST_CLIENT_ID', '98765'); vi.stubGlobal('chrome', undefined);
    expect(getAniListAuthConfiguration().configured).toBe(false);
  });
  it.each(['Authorization page could not be loaded.', 'Did not redirect to the right URL.', 'failed https://callback/#access_token=private'])('does not misreport a browser authorization failure as cancellation: %s', async message => {
    vi.mocked(chrome.identity.launchWebAuthFlow).mockRejectedValue(new Error(message));
    const viewer = vi.spyOn(aniListProvider, 'viewer');
    await expect(connectAniList()).rejects.toMatchObject({code: 'authorization', message: 'AniList authorization'});
    expect(viewer).not.toHaveBeenCalled();
    expect(await getTrackingCredential()).toBeUndefined();
  });
  it.each(['The user did not approve access.', 'User cancelled or denied access.'])('recognizes explicit browser cancellation: %s', async message => {
    vi.mocked(chrome.identity.launchWebAuthFlow).mockRejectedValue({message});
    await expect(connectAniList()).rejects.toMatchObject({code: 'cancelled'});
    expect(await getTrackingCredential()).toBeUndefined();
  });
  it('preserves application cancellation while the browser flow is pending', async () => {
    const waiting = deferred<string>(), started = deferred<void>(), controller = new AbortController();
    vi.mocked(chrome.identity.launchWebAuthFlow).mockImplementation(() => {started.resolve(); return waiting.promise;});
    const connecting = connectAniList({signal: controller.signal});
    const rejected = expect(connecting).rejects.toMatchObject({code: 'cancelled'});
    await started.promise;
    controller.abort();
    await rejected;
    waiting.resolve(callback('obsolete'));
    expect(await getTrackingCredential()).toBeUndefined();
  });
  it('only treats access_denied callbacks as cancellation, after validating state', () => {
    const returned = (error: string) => `${redirectUrl}#state=right&error=${error}`;
    expect(() => validateAniListCallback(returned('access_denied'), redirectUrl, 'right', 100_000, 100_000)).toThrow('AniList cancelled');
    expect(() => validateAniListCallback(returned('invalid_client'), redirectUrl, 'right', 100_000, 100_000)).toThrow('AniList authorization');
    expect(() => validateAniListCallback(returned('access_denied'), redirectUrl, 'wrong', 100_000, 100_000)).toThrow('AniList auth');
  });
  it.each([
    `${redirectUrl}#access_token=secret&token_type=Bearer&expires_in=3600`,
    callback('wrong'),
    callback('right').replace('test-extension.chromiumapp.org', 'attacker.example'),
    callback('right').replace('/anilist#', '/other#'),
    callback('right') + '&state=right',
    callback('right') + '&access_token=other',
    callback('right').replace('expires_in=3600', 'expires_in=0'),
    callback('right').replace('token_type=Bearer', 'token_type=Other'),
  ])('rejects missing state, callback tampering or malformed token parameters', returned => {
    expect(() => validateAniListCallback(returned, redirectUrl, 'right', 100_000, 100_000)).toThrow('AniList auth');
  });
  it('rejects an expired authorization attempt', () => {
    expect(() => validateAniListCallback(callback('right'), redirectUrl, 'right', 100_000, 700_001)).toThrow('AniList auth');
  });
  it('does not accept any token before identity validation succeeds', async () => {
    vi.spyOn(aniListProvider, 'viewer').mockRejectedValue(new Error('viewer unavailable'));
    await expect(connectAniList()).rejects.toThrow();
    expect(await getTrackingCredential()).toBeUndefined();
  });
  it('preserves same-account epochs through expired-token renewal but changes epoch on another account', async () => {
    await beginPrivateTrackingAuthorization('initial');
    await commitPrivateTrackingCredential('initial', {...credential(), expiresAt: 1});
    const viewer = vi.spyOn(aniListProvider, 'viewer').mockResolvedValue({id: 7, name: 'Renamed'});
    expect(await connectAniList()).toMatchObject({accountId: 7, name: 'Renamed', epoch: 'epoch-one'});
    viewer.mockResolvedValue({id: 9, name: 'Another'});
    const next = await connectAniList();
    expect(next.accountId).toBe(9); expect(next.epoch).not.toBe('epoch-one');
  });
  it('consumes authorization once and cannot replay a completed attempt', async () => {
    await beginPrivateTrackingAuthorization('single-use');
    expect(await commitPrivateTrackingCredential('single-use', credential())).toBeDefined();
    expect(await commitPrivateTrackingCredential('single-use', credential(9))).toBeUndefined();
    expect((await getTrackingCredential())?.accountId).toBe(7);
  });
  it('disconnect invalidates a pending callback and never lets late Viewer restore an account', async () => {
    const waiting = deferred<{id: number; name: string}>(), started = deferred<void>();
    vi.spyOn(aniListProvider, 'viewer').mockImplementation(() => {started.resolve(); return waiting.promise;});
    const connecting = connectAniList();
    const rejected = expect(connecting).rejects.toMatchObject({code: 'cancelled'});
    await started.promise;
    await disconnectAniList();
    waiting.resolve({id: 7, name: 'Reader'});
    await rejected;
    expect(await getTrackingCredential()).toBeUndefined();
  });
  it('an older simultaneous authorization cannot overwrite the newest account', async () => {
    await beginPrivateTrackingAuthorization('older');
    await beginPrivateTrackingAuthorization('newer');
    expect(await commitPrivateTrackingCredential('older', credential(7))).toBeUndefined();
    expect(await commitPrivateTrackingCredential('newer', credential(9))).toMatchObject({accountId: 9});
  });
});
