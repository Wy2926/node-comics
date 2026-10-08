import 'fake-indexeddb/auto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {catalog, openCatalog} from '../src/comics/repositories';
import * as auth from '../src/tracking/auth';
import {aniListProvider} from '../src/tracking/anilist';
import {registerTrackingBackground, trackingCommand, trustedTrackingSender} from '../src/tracking/background';
import {TrackingCoordinator} from '../src/tracking/coordinator';
import {TRACKING_IDLE, TRACKING_SESSION, trackingJobId, trackingScope, type TrackingJob} from '../src/tracking/model';
import {beginPrivateTrackingAuthorization, commitPrivateTrackingCredential} from '../src/tracking/private-store';
import {readTrackingSession, writeTrackingSession} from '../src/tracking/store';

const redirect = 'https://tracker-extension.chromiumapp.org/anilist';
const deferred = <T>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};};
const callback = (url: string) => `${redirect}#${new URLSearchParams({state: new URL(url).searchParams.get('state')!, access_token: 'renewed-token', token_type: 'Bearer', expires_in: '3600'})}`;
let epoch: string, scope: string;
async function seedCredential(expiresAt = Date.now() + 60_000) {
  await beginPrivateTrackingAuthorization('fixture');
  await commitPrivateTrackingCredential('fixture', {accountId: 7, name: 'Reader', token: 'old-token', epoch, expiresAt});
}
beforeEach(async () => {
  await trackingCommand({command: 'disconnect'});
  epoch = crypto.randomUUID(); scope = trackingScope(7, epoch);
  vi.stubEnv('VITE_ANILIST_CLIENT_ID', '98765');
  vi.stubGlobal('chrome', {
    identity: {getRedirectURL: () => redirect, launchWebAuthFlow: vi.fn(async ({url}: {url: string}) => callback(url))},
    runtime: {id: 'tracker-extension', getURL: (path: string) => `chrome-extension://tracker-extension/${path.replace(/^\/+/, '')}`,
      onMessage: {addListener: vi.fn()}, onStartup: {addListener: vi.fn()}, onInstalled: {addListener: vi.fn()}},
    alarms: {create: vi.fn(async () => {}), clear: vi.fn(async () => true), onAlarm: {addListener: vi.fn()}},
  });
  vi.spyOn(aniListProvider, 'viewer').mockResolvedValue({id: 7, name: 'Reader'});
  await seedCredential();
  await writeTrackingSession({id: TRACKING_SESSION, accountId: 7, name: 'Reader', epoch, enabled: true});
});
afterEach(async () => {
  await trackingCommand({command: 'disconnect'});
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('background account commands do not lock behind OAuth', () => {
  it('disconnects promptly while the popup remains open and ignores its late callback', async () => {
    const popup = deferred<string>(), opened = deferred<void>(); let authorizationUrl = '';
    vi.mocked(chrome.identity.launchWebAuthFlow).mockImplementation(({url}) => {authorizationUrl = url; opened.resolve(); return popup.promise;});
    const connecting = trackingCommand({command: 'connect'});
    const cancelled = expect(connecting).rejects.toMatchObject({code: 'cancelled'});
    await opened.promise;
    expect((await readTrackingSession()).enabled).toBe(false);
    // This must complete before popup.resolve(), not wait for user interaction.
    await trackingCommand({command: 'disconnect'});
    await cancelled;
    expect(await readTrackingSession()).toEqual({id: TRACKING_SESSION, enabled: false});
    expect(await auth.getTrackingCredential()).toBeUndefined();
    popup.resolve(callback(authorizationUrl));
    await Promise.resolve();
    expect(aniListProvider.viewer).not.toHaveBeenCalled();
  }, 2000);
  it('a stale connect result cannot restore the public session after disconnect even if its provider ignores cancellation', async () => {
    const pending = deferred<auth.TrackingCredential>(), started = deferred<void>();
    vi.spyOn(auth, 'connectAniList').mockImplementation(() => {started.resolve(); return pending.promise;});
    const connecting = trackingCommand({command: 'connect'}), cancelled = expect(connecting).rejects.toMatchObject({code: 'cancelled'});
    await started.promise;
    await trackingCommand({command: 'disconnect'});
    pending.resolve({accountId: 7, name: 'Reader', epoch, token: 'late-token', expiresAt: Date.now() + 60_000});
    await cancelled;
    expect(await readTrackingSession()).toEqual({id: TRACKING_SESSION, enabled: false});
  });
  it('disable is immediate for expired credentials and is not undone by same-account authorization', async () => {
    await seedCredential(1);
    const popup = deferred<string>(), opened = deferred<void>(); let authorizationUrl = '';
    vi.mocked(chrome.identity.launchWebAuthFlow).mockImplementation(({url}) => {authorizationUrl = url; opened.resolve(); return popup.promise;});
    const connecting = trackingCommand({command: 'connect'});
    await opened.promise;
    await trackingCommand({command: 'enable', enabled: false});
    expect((await readTrackingSession()).enabled).toBe(false);
    popup.resolve(callback(authorizationUrl)); await connecting;
    expect(await readTrackingSession()).toMatchObject({accountId: 7, epoch, enabled: false});
  });
  it('does not re-enable sends during a pending account switch', async () => {
    const popup = deferred<string>(), opened = deferred<void>();
    vi.mocked(chrome.identity.launchWebAuthFlow).mockImplementation(() => {opened.resolve(); return popup.promise;});
    const connecting = trackingCommand({command: 'connect'}), cancelled = expect(connecting).rejects.toMatchObject({code: 'cancelled'});
    await opened.promise;
    await expect(trackingCommand({command: 'enable', enabled: true})).rejects.toMatchObject({code: 'cancelled'});
    expect((await readTrackingSession()).enabled).toBe(false);
    await trackingCommand({command: 'disconnect'}); await cancelled;
  });
  it.each([
    ['The user did not approve access.', 'cancelled'],
    ['Authorization page could not be loaded.', 'authorization'],
  ])('restores a still-valid old session after a failed authorization: %s', async (message, code) => {
    vi.mocked(chrome.identity.launchWebAuthFlow).mockRejectedValue(new Error(message));
    await expect(trackingCommand({command: 'connect'})).rejects.toMatchObject({code});
    expect(await readTrackingSession()).toMatchObject({accountId: 7, epoch, enabled: true});
  });
  it('same-account reauthorization resumes only its auth-blocked index, including more than one bounded batch', async () => {
    await seedCredential(1);
    const job = (mediaId: number, jobScope = scope, reason = 'auth'): TrackingJob => ({
      id: trackingJobId(jobScope, mediaId), scope: jobScope, accountId: jobScope === scope ? 7 : 9, epoch,
      mediaId, revision: 3, contributions: [], progress: 12, status: 'blocked', reason, attempts: 4, nextRunAt: TRACKING_IDLE, updatedAt: 1,
    });
    for (let mediaId = 1; mediaId <= 105; mediaId++) await catalog.put('trackingJobs', job(mediaId));
    const protectedJob = job(106, scope, 'remote-reset'), foreignJob = job(107, trackingScope(9, epoch));
    await catalog.put('trackingJobs', protectedJob); await catalog.put('trackingJobs', foreignJob);
    const db = await openCatalog();
    expect(db.transaction('trackingJobs').objectStore('trackingJobs').index('blocked').keyPath).toEqual(['scope', 'status', 'reason']);
    await trackingCommand({command: 'connect'});
    expect(await readTrackingSession()).toMatchObject({accountId: 7, epoch, enabled: true});
    const resumed = await catalog.list('trackingJobs', {index: 'scope', range: scope, limit: 110});
    expect(resumed.filter(value => value.status === 'pending')).toHaveLength(105);
    expect(resumed.filter(value => value.status === 'pending').every(value => value.revision === 4 && value.attempts === 0 && !value.reason)).toBe(true);
    expect(await catalog.get('trackingJobs', protectedJob.id)).toMatchObject({status: 'blocked', reason: 'remote-reset'});
    expect(await catalog.get('trackingJobs', foreignJob.id)).toMatchObject({status: 'blocked', reason: 'auth'});
    expect(JSON.stringify(await readTrackingSession())).not.toMatch(/old-token|renewed-token/);
    await catalog.remove('trackingJobs', foreignJob.id);
  });
});

describe('tracking message sender boundary', () => {
  it('the registered listener dispatches disconnect without waiting for an interactive connect response', async () => {
    vi.spyOn(TrackingCoordinator.prototype, 'runNext').mockResolvedValue(false);
    const popup = deferred<string>(), opened = deferred<void>();
    vi.mocked(chrome.identity.launchWebAuthFlow).mockImplementation(() => {opened.resolve(); return popup.promise;});
    registerTrackingBackground();
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
    const send = (command: string) => new Promise<unknown>(resolve => {
      expect(listener({type: 'NC_TRACKING', command}, {id: chrome.runtime.id, url: chrome.runtime.getURL('/index.html')}, resolve)).toBe(true);
    });
    const connecting = send('connect');
    await opened.promise;
    expect(await send('disconnect')).toEqual({ok: true, value: undefined});
    expect(await connecting).toEqual({ok: false, error: 'cancelled'});
    expect(await readTrackingSession()).toEqual({id: TRACKING_SESSION, enabled: false});
  }, 2000);
  it('accepts only this extension origin, not website content scripts, lookalike origins or other extensions', () => {
    expect(trustedTrackingSender({id: chrome.runtime.id, url: chrome.runtime.getURL('/index.html')})).toBe(true);
    for (const sender of [
      {id: chrome.runtime.id, url: 'https://manga.example/read/1'},
      {id: chrome.runtime.id, url: 'chrome-extension://tracker-extension.attacker/index.html'},
      {id: 'other-extension', url: chrome.runtime.getURL('/index.html')},
      {id: chrome.runtime.id},
    ]) expect(trustedTrackingSender(sender)).toBe(false);
  });
  it('the registered listener never runs or responds to an untrusted account command', async () => {
    vi.spyOn(TrackingCoordinator.prototype, 'runNext').mockResolvedValue(false);
    registerTrackingBackground();
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
    const respond = vi.fn();
    expect(listener({type: 'NC_TRACKING', command: 'disconnect'}, {id: chrome.runtime.id, url: 'https://manga.example/read/1'}, respond)).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
    expect(await readTrackingSession()).toMatchObject({accountId: 7, epoch, enabled: true});
    expect((await auth.getTrackingCredential())?.token).toBe('old-token');
  });
});
