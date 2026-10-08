import 'fake-indexeddb/auto';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {catalog, openCatalog} from '../src/comics/repositories';
import {seedComic} from './comic-fixture';
import {chapterProgress, TRACKING_SESSION, trackingScope} from '../src/tracking/model';
import {readTrackingSession, trackingStore, writeTrackingSession} from '../src/tracking/store';
import {TrackingCoordinator} from '../src/tracking/coordinator';
import {TrackingError} from '../src/tracking/anilist';
import type {TrackingMedia, TrackingRemoteEntry} from '../src/tracking/anilist';

let epoch: string, scope: string;
const now = 10_000;
const remote = (progress: number, status: TrackingRemoteEntry['status'] = 'CURRENT'): TrackingRemoteEntry => ({id: 50, mediaId: 100, userId: 10, progress, status});
const medium = (entry: TrackingRemoteEntry | null = null, chapters: number | null = null): TrackingMedia => ({id: 100, title: 'Confirmed manga', chapters, entry});
const identity = (entry: {contentId: string; generation: number}) => ({contentId: entry.contentId, generation: entry.generation});
async function source(chapterNumber = '12') {
  const result = await seedComic({chapterNumber, format: 'website', pageCount: 2, knownTotal: 2, discoveryComplete: true});
  await trackingStore.bind(result.comic.id, medium(), 0); return result;
}
const job = () => trackingStore.job(scope, 100);
async function complete(entry: {id: string; contentId: string; generation: number}) {await trackingStore.complete(entry.id, identity(entry), now);}
function sender(media = vi.fn(async () => medium()), save = vi.fn(async (value: {progress: number}) => remote(value.progress))) {
  const credential = vi.fn(async () => ({accountId: 10, name: 'Reader', epoch, token: 'private-token', expiresAt: now + 1_000_000}));
  return {coordinator: new TrackingCoordinator({media, save}, credential, () => now), media, save, credential};
}
beforeEach(async () => {
  epoch = crypto.randomUUID(); scope = trackingScope(10, epoch);
  await writeTrackingSession({id: TRACKING_SESSION, enabled: true, accountId: 10, name: 'Reader', epoch});
});
describe('tracking completion and durable source-bound intents', () => {
  it('keeps discovery candidates separate from confirmed bindings and deletes them with the source', async () => {
    const {comic} = await seedComic(); await trackingStore.suggest(comic.id, 123);
    expect(await trackingStore.suggestedMediaId(comic.id)).toBe(123);
    expect(await trackingStore.binding(comic.id)).toBeUndefined(); expect(await job()).toBeUndefined();
    await trackingStore.bind(comic.id, medium(), 0); await trackingStore.suggest(comic.id, 456);
    expect((await trackingStore.binding(comic.id))?.mediaId).toBe(100);
    await catalog.deleteComic(comic.id); expect(await trackingStore.suggestedMediaId(comic.id)).toBeUndefined();
  });
  it('prefers exact source AniList evidence to a discovery search seed without auto-binding', async () => {
    const {comic} = await seedComic(); await trackingStore.suggest(comic.id, 123);
    await catalog.put('catalogs', {id: crypto.randomUUID(), comicId: comic.id, externalIds: {anilist: 456, myAnimeList: 789}});
    expect(await trackingStore.suggestedMediaId(comic.id)).toBe(456); expect(await trackingStore.binding(comic.id)).toBeUndefined();
  });
  it('uses an explicit additive v2 catalog upgrade and a dedicated indexed queue', async () => {
    const db = await openCatalog(); expect(db.version).toBe(2);
    expect([...db.transaction('trackingJobs').objectStore('trackingJobs').indexNames]).toEqual(['blocked', 'due', 'scope']);
  });
  it.each(['12.5', '12a', 'Special', '', '0', '-1', '1e2', 'Infinity', '9007199254740992'])('never guesses or truncates %s', label => expect(chapterProgress(label, 0)).toBeUndefined());
  it('allows only positive integer results and a confirmed integer offset', () => {
    expect(chapterProgress('012', 2)).toBe(14); expect(chapterProgress('12', -12)).toBeUndefined();
    expect(chapterProgress('12', .5)).toBeUndefined(); expect(chapterProgress('2147483647', 1)).toBeUndefined();
  });
  it('atomically saves local completion and queues it, without scanning historical readAt', async () => {
    const {entry} = await source(); expect(await job()).toBeUndefined(); await complete(entry);
    expect((await catalog.get('entries', entry.id))?.readAt).toBe(now);
    expect(await job()).toMatchObject({scope, accountId: 10, progress: 12, status: 'pending', revision: 1});
    expect(JSON.stringify(await job())).not.toContain('private-token');
    await complete(entry); expect((await job())?.revision).toBe(1);
  });
  it('can track a genuine reread after tracking was enabled', async () => {
    const {entry} = await source(); await catalog.patch('entries', entry.id, {readAt: 1}); await complete(entry);
    expect((await job())?.progress).toBe(12); expect((await catalog.get('entries', entry.id))?.readAt).toBe(1);
  });
  it('ignores stale content/generation, incomplete, failed and removed source entries', async () => {
    const {entry} = await source();
    await trackingStore.complete(entry.id, {...identity(entry), generation: 2}, now);
    await trackingStore.complete(entry.id, {...identity(entry), contentId: 'changed'}, now);
    for (const changed of [{discoveryComplete: false}, {error: 'failed'}, {sourceRemoved: true}, {pageCount: 1}, {indexState: 'pending' as const}]) {
      await catalog.put('entries', {...entry, ...changed}); await complete(entry);
      expect((await catalog.get('entries', entry.id))?.readAt).toBeUndefined();
    }
    expect(await job()).toBeUndefined();
  });
  it('keeps local completion while disabled or unbound, and does not retroactively enqueue it', async () => {
    const {entry} = await source(); await writeTrackingSession({...await readTrackingSession(), enabled: false}); await complete(entry);
    expect((await catalog.get('entries', entry.id))?.readAt).toBe(now); expect(await job()).toBeUndefined();
    await writeTrackingSession({...await readTrackingSession(), enabled: true}); expect(await job()).toBeUndefined();
  });
  it('does not make a special chapter block another valid source for the same manga', async () => {
    const a = await source('12.5'), b = await source('12'); await complete(a.entry); await complete(b.entry);
    expect((await trackingStore.binding(a.comic.id))?.issue).toBe('chapter-mapping'); expect((await job())?.progress).toBe(12);
  });
  it('coalesces cross-site/cross-tab completions without adding duplicates', async () => {
    const a = await source('12'), b = await source('12'), c = await source('15');
    await Promise.all([complete(a.entry), complete(b.entry), complete(c.entry)]);
    expect(await job()).toMatchObject({progress: 15, contributions: expect.any(Array)}); expect((await job())?.contributions).toHaveLength(3);
    expect(await catalog.count('tasks')).toBe(0);
  });
  it('prunes removed and rebound contributions before sending the captured maximum', async () => {
    const a = await source('12'), b = await source('15'); await complete(a.entry); await complete(b.entry);
    const captured = await trackingStore.next(scope, now); await catalog.deleteComic(b.comic.id);
    expect(await trackingStore.current(captured!)).toBe(false); expect((await job())?.progress).toBe(12);
    await trackingStore.bind(a.comic.id, {...medium(), id: 101}, 0);
    expect((await job())?.contributions).toEqual([]);
  });
  it('survives reopening the catalog and uses a due lease to recover interrupted workers', async () => {
    const {entry} = await source(); await complete(entry); const selected = await trackingStore.next(scope, now);
    expect(await trackingStore.next(scope, now + 1)).toBeUndefined();
    const reclaimed = await trackingStore.next(scope, now + 90_000);
    expect(reclaimed?.id).toBe(selected?.id); expect(reclaimed?.revision).toBeGreaterThan(selected!.revision);
    expect(await trackingStore.current(selected!)).toBe(false);
    await trackingStore.acknowledge(reclaimed!, {listEntryId: 50, progress: 20});
    await trackingStore.acknowledge(selected!, {listEntryId: 50, progress: 12});
    expect((await job())?.baseline?.progress).toBe(20);
  });
  it('does not clear a newer revision on an old receipt', async () => {
    const a = await source('12'); await complete(a.entry); const selected = await trackingStore.next(scope, now);
    const b = await source('15'); await complete(b.entry);
    await trackingStore.acknowledge(selected!, {listEntryId: 50, progress: 12});
    expect(await job()).toMatchObject({progress: 15, status: 'pending', baseline: {progress: 12}});
  });
  it('late receipts cannot regress a newer ACK or undo an explicitly accepted reset', async () => {
    const a = await source('12'); await complete(a.entry); const first = (await job())!;
    const b = await source('15'); await complete(b.entry); const second = (await job())!;
    await trackingStore.acknowledge(second, {listEntryId: 50, progress: 15});
    await trackingStore.acknowledge(first, {listEntryId: 50, progress: 12});
    expect((await job())?.baseline?.progress).toBe(15);
    await trackingStore.resetBaseline((await job())!, {listEntryId: 50, progress: 2});
    await trackingStore.acknowledge(second, {listEntryId: 50, progress: 15});
    expect((await job())?.baseline?.progress).toBe(2);
  });
});
describe('AniList coordinator safeguards', () => {
  it('creates CURRENT using one fresh read and one minimal progress mutation, including unknown total', async () => {
    const {entry} = await source(); await complete(entry); const {coordinator, media, save} = sender();
    await coordinator.runNext(); expect(media).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledWith({mediaId: 100, listEntryId: undefined, progress: 12, status: 'CURRENT'}, 'private-token');
    expect(await job()).toMatchObject({status: 'synced', baseline: {listEntryId: 50, progress: 12}});
    await coordinator.runNext(); expect(save).toHaveBeenCalledOnce();
  });
  it('reads back a higher remote value without mutating it', async () => {
    const {entry} = await source(); await complete(entry); const {coordinator, save} = sender(vi.fn(async () => medium(remote(20))));
    await coordinator.runNext(); expect(save).not.toHaveBeenCalled(); expect((await job())?.baseline?.progress).toBe(20);
  });
  it('CURRENT progress updates omit every status/unrelated list field', async () => {
    const {entry} = await source(); await complete(entry); const {coordinator, save} = sender(vi.fn(async () => medium(remote(10))));
    await coordinator.runNext(); expect(save.mock.calls[0][0]).toEqual({mediaId: 100, listEntryId: 50, progress: 12});
  });
  it.each(['PAUSED', 'DROPPED', 'COMPLETED', 'REPEATING'] as const)('preserves protected %s', async status => {
    const {entry} = await source(); await complete(entry); const {coordinator, save} = sender(vi.fn(async () => medium(remote(0, status))));
    await coordinator.runNext(); expect(save).not.toHaveBeenCalled(); expect(await job()).toMatchObject({status: 'blocked', reason: 'protected-state'});
  });
  it.each(['remote-reset', 'remote-deleted', 'total-mismatch', 'identity'])('blocks %s before a write', async reason => {
    const {entry} = await source(); await complete(entry);
    if (reason.startsWith('remote')) await catalog.put('trackingJobs', {...(await job())!, baseline: {listEntryId: 50, progress: 10}});
    const value = reason === 'remote-reset' ? medium(remote(5)) : reason === 'remote-deleted' ? medium() : reason === 'total-mismatch' ? medium(null, 11) : medium({...remote(0), userId: 11});
    const {coordinator, save} = sender(vi.fn(async () => value)); await coordinator.runNext();
    expect(save).not.toHaveBeenCalled(); expect((await job())?.reason).toBe(reason);
  });
  it('serializes sends and rechecks account switch while remote read was inflight', async () => {
    const {entry} = await source(); await complete(entry);
    let release!: (value: TrackingMedia) => void;
    const {coordinator, media, save} = sender(vi.fn(() => new Promise<TrackingMedia>(resolve => {release = resolve;})));
    const first = coordinator.runNext(), second = coordinator.runNext(); expect(second).toBe(first);
    await vi.waitFor(() => expect(media).toHaveBeenCalledOnce());
    await writeTrackingSession({id: TRACKING_SESSION, accountId: 11, epoch: 'other', enabled: true}); release(medium()); await first;
    expect(save).not.toHaveBeenCalled();
  });
  it('bounds unavailable retries and honors a longer rate-limit cooldown', async () => {
    const {entry} = await source(); await complete(entry);
    const {coordinator} = sender(vi.fn(async () => {throw new TrackingError('rate-limit', now + 200_000);}));
    await coordinator.runNext(); expect(await job()).toMatchObject({status: 'pending', nextRunAt: now + 200_000, attempts: 1});
    await catalog.put('trackingJobs', {...(await job())!, attempts: 5, nextRunAt: now}); await coordinator.runNext();
    expect(await job()).toMatchObject({status: 'blocked', reason: 'retry-exhausted'});
  });
  it('unknown mutation results retry by reading current remote state before considering another write', async () => {
    const {entry} = await source(); await complete(entry);
    const media = vi.fn(async () => medium()), save = vi.fn(async (): Promise<TrackingRemoteEntry> => {throw new TrackingError('unavailable');});
    const {coordinator} = sender(media, save); await coordinator.runNext(); expect((await job())?.status).toBe('pending');
    await catalog.put('trackingJobs', {...(await job())!, nextRunAt: now}); media.mockImplementation(async () => medium(remote(12)));
    await coordinator.runNext(); expect(save).toHaveBeenCalledOnce(); expect((await job())?.status).toBe('synced');
  });
  it('auth renewal resumes only auth-paused work and retains its account/target/revision baseline', async () => {
    const {entry} = await source(); await complete(entry); const selected = (await job())!;
    await trackingStore.fail(selected, 'auth'); await trackingStore.resumeAuthorization(scope);
    expect(await job()).toMatchObject({status: 'pending', scope, progress: 12});
    await trackingStore.fail((await job())!, 'remote-reset'); await trackingStore.resumeAuthorization(scope);
    expect((await job())?.reason).toBe('remote-reset');
  });
  it('explicit reset drops the old high water contribution without deleting the remote item', async () => {
    const {entry} = await source(); await complete(entry); const selected = (await job())!;
    await trackingStore.resetBaseline(selected, {listEntryId: 50, progress: 2});
    expect(await job()).toMatchObject({status: 'synced', contributions: [], baseline: {progress: 2}});
  });
});
