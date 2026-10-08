import {TrackingCoordinator} from './coordinator';
import {aniListProvider, TrackingError} from './anilist';
import {connectAniList, disconnectAniList, getTrackingCredential, getAniListAuthConfiguration} from './auth';
import {readTrackingSession, trackingStore, writeTrackingSession} from './store';
import {TRACKING_SESSION, trackingScope, type TrackingSession} from './model';
import type {TrackingView} from './client';

export const TRACKING_ALARM = 'nc-anilist-tracking';
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
let accountGeneration = 0, accountWrites: Promise<unknown> = Promise.resolve();
let authorization: {generation: number; controller: AbortController; enabled?: boolean} | undefined;
/** Only short local commits serialize. An interactive OAuth window never holds this queue. */
function accountCommit<T>(action: () => Promise<T>): Promise<T> {
  const task = accountWrites.catch(() => {}).then(action);
  accountWrites = task;
  return task;
}
export function trustedTrackingSender(sender: chrome.runtime.MessageSender) {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL('/'));
}
export async function trackingStatus(comicId?: string): Promise<TrackingView> {
  const session = await readTrackingSession(), configuration = getAniListAuthConfiguration();
  const binding = comicId ? await trackingStore.binding(comicId) : undefined;
  const job = binding && session.accountId && session.epoch ? await trackingStore.job(trackingScope(session.accountId, session.epoch), binding.mediaId) : undefined;
  return {configured: configuration.configured, redirectUrl: configuration.redirectUrl, enabled: session.enabled,
    suggestedMediaId: comicId && !binding ? await trackingStore.suggestedMediaId(comicId) : undefined,
    account: session.accountId ? {id: session.accountId, name: session.name ?? ''} : undefined,
    binding: binding ? {mediaId: binding.mediaId, title: binding.title, offset: binding.offset, paused: binding.paused} : undefined,
    job: binding?.issue ? {status: 'blocked', progress: job?.progress ?? 0, reason: binding.issue}
      : job ? {status: job.status, progress: job.status === 'synced' ? job.baseline?.progress ?? job.progress : job.progress, reason: job.reason} : undefined};
}
export async function trackingCommand(message: Record<string, unknown>): Promise<unknown> {
  const {command, comicId} = message;
  if (command === 'status') {
    if (comicId !== undefined && !identifier(comicId)) throw new TrackingError('invalid');
    return trackingStatus(comicId as string | undefined);
  }
  if (command === 'wake') return;
  if (command === 'connect') {
    authorization?.controller.abort();
    const attempt = {generation: ++accountGeneration, controller: new AbortController(), enabled: undefined as boolean | undefined};
    authorization = attempt;
    let before: TrackingSession | undefined;
    const current = () => {if (attempt.generation !== accountGeneration || attempt.controller.signal.aborted) throw new TrackingError('cancelled');};
    try {
      await accountCommit(async () => {
        current(); before = await readTrackingSession(); current();
        attempt.enabled ??= before.enabled;
        // Pause old-account sends while the user may be choosing another account.
        await writeTrackingSession({...before, enabled: false});
      });
      current();
      const credential = await connectAniList({signal: attempt.controller.signal});
      const same = before?.accountId === credential.accountId && before?.epoch === credential.epoch;
      await accountCommit(async () => {
        current();
        const stored = await getTrackingCredential(); current();
        if (stored?.accountId !== credential.accountId || stored.epoch !== credential.epoch || stored.token !== credential.token) throw new TrackingError('cancelled');
        await writeTrackingSession({id: TRACKING_SESSION, accountId: credential.accountId, name: credential.name, epoch: credential.epoch, enabled: same && Boolean(attempt.enabled)});
      });
      if (same) await trackingStore.resumeAuthorization(trackingScope(credential.accountId, credential.epoch));
      if (!same && before?.accountId && before.epoch) await trackingStore.discardScope(trackingScope(before.accountId, before.epoch));
      return;
    } catch (error) {
      await accountCommit(async () => {
        if (attempt.generation !== accountGeneration || !before) return;
        const credential = await getTrackingCredential();
        if (attempt.generation !== accountGeneration) return;
        const usable = credential?.accountId === before.accountId && credential?.epoch === before.epoch && credential !== undefined && credential.expiresAt > Date.now();
        await writeTrackingSession({...before, enabled: usable && Boolean(attempt.enabled)});
      });
      throw error;
    } finally {if (authorization === attempt) authorization = undefined;}
  }
  if (command === 'disconnect') {
    ++accountGeneration;
    authorization?.controller.abort(); authorization = undefined;
    const before = await accountCommit(async () => {
      const previous = await readTrackingSession();
      await writeTrackingSession({id: TRACKING_SESSION, enabled: false});
      await disconnectAniList();
      return previous;
    });
    if (before.accountId && before.epoch) await trackingStore.discardScope(trackingScope(before.accountId, before.epoch)); return;
  }
  if (command === 'enable') {
    if (typeof message.enabled !== 'boolean') throw new TrackingError('invalid');
    const enabled = message.enabled;
    if (!enabled && authorization) authorization.enabled = false;
    await accountCommit(async () => {
      const session = await readTrackingSession();
      // Disabling must remain available for expired auth and an open OAuth window.
      if (enabled) {
        if (authorization) throw new TrackingError('cancelled');
        const credential = await getTrackingCredential();
        if (!credential || credential.expiresAt <= Date.now() || session.accountId !== credential.accountId || session.epoch !== credential.epoch) throw new TrackingError('auth');
      }
      await writeTrackingSession({...session, enabled});
    });
    return;
  }
  if (command === 'search') {
    if (!identifier(message.query)) throw new TrackingError('invalid');
    const query = message.query.trim(), match = query.match(/^https:\/\/anilist\.co\/manga\/(\d+)(?:\/[^?#]*)?\/?$/);
    const id = /^\d+$/.test(query) ? Number(query) : match ? Number(match[1]) : undefined;
    if (id !== undefined && !positiveInteger(id)) throw new TrackingError('invalid');
    const media = id ? [await aniListProvider.media(id)] : await aniListProvider.search(query);
    return media.map(({id, title, chapters}) => ({id, title, chapters}));
  }
  const session = await readTrackingSession(), credential = await getTrackingCredential();
  if (!credential || credential.expiresAt <= Date.now() || session.accountId !== credential.accountId || session.epoch !== credential.epoch) throw new TrackingError('auth');
  if (!identifier(comicId)) throw new TrackingError('invalid');
  if (command === 'bind') {
    if (!positiveInteger(message.mediaId) || typeof message.offset !== 'number' || !Number.isSafeInteger(message.offset) || Math.abs(message.offset) > 100000) throw new TrackingError('invalid');
    const media = await aniListProvider.media(message.mediaId);
    await trackingStore.bind(comicId, media, message.offset); return;
  }
  if (command === 'unbind') return trackingStore.unbind(comicId);
  if (command === 'pause') {
    if (typeof message.paused !== 'boolean') throw new TrackingError('invalid');
    return trackingStore.pause(comicId, message.paused);
  }
  const binding = await trackingStore.binding(comicId); if (!binding) throw new TrackingError('invalid');
  const scope = trackingScope(credential.accountId, credential.epoch);
  if (command === 'retry') return trackingStore.retry(scope, binding.mediaId);
  if (command === 'reset-baseline') {
    const job = await trackingStore.job(scope, binding.mediaId);
    if (!job || !['remote-reset', 'remote-deleted'].includes(job.reason ?? '')) throw new TrackingError('invalid');
    const media = await aniListProvider.media(binding.mediaId, credential.token);
    if (media.entry && media.entry.userId !== credential.accountId) throw new TrackingError('identity');
    await trackingStore.resetBaseline(job, media.entry ? {listEntryId: media.entry.id, progress: media.entry.progress} : undefined); return;
  }
  throw new TrackingError('invalid');
}

export function registerTrackingBackground() {
  const coordinator = new TrackingCoordinator(); let running: Promise<void> | undefined;
  const run = () => running ??= (async () => {
    // Arm recovery before I/O, not only in finally: workers can disappear between read and ACK.
    await chrome.alarms.create(TRACKING_ALARM, {when: Date.now() + 120_000});
    const deadline = Date.now() + 25_000;
    for (let count = 0; count < 10 && Date.now() < deadline && await coordinator.runNext(); count++) { /* bounded, serial */ }
  })().catch(() => {}).finally(async () => {
    try {
      const session = await readTrackingSession();
      const next = session.enabled && session.accountId && session.epoch ? await trackingStore.nextRunAt(trackingScope(session.accountId, session.epoch)) : undefined;
      if (next !== undefined) await chrome.alarms.create(TRACKING_ALARM, {when: Math.max(Date.now() + 30_000, next)});
      else await chrome.alarms.clear(TRACKING_ALARM);
    } catch { /* The already-armed alarm recovers local storage failures. */ }
    finally {running = undefined;}
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'NC_TRACKING' || !trustedTrackingSender(sender)) return;
    const task = trackingCommand(message);
    void task.then(value => {respond({ok: true, value}); if (message.command !== 'status' && message.command !== 'search') void run();},
      error => respond({ok: false, error: error instanceof TrackingError ? error.code : 'unavailable'}));
    return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => {if (alarm.name === TRACKING_ALARM) void run();});
  chrome.runtime.onStartup.addListener(() => {void run();});
  chrome.runtime.onInstalled.addListener(() => {void run();});
  void run();
}
