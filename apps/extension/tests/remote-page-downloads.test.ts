import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog, openCatalog } from '../src/comics/repositories';
import { registerSourceDriver } from '../src/comics/sources/registry';
import type { RemoteReadingPlan, SourceProvider } from '../src/comics/sources/contracts';
import { openRemotePublication } from '../src/comics/application/remote-library-service';
import {
  invalidateSourceAccess,
  restoreSourceResources,
} from '../src/comics/application/source-access';
import { downloadStore } from '../src/storage/downloads';
import { sourcePageCache } from '../src/storage/source-pages';
import { acquirePage } from '../src/comics/pages/service';
import { pageRenderProfile } from '../src/comics/pages/identity';
import {
  listBookDownloads,
  readComicOfflineCapability,
  runBookDownloadCycle,
  startBookDownload,
} from '../src/comics/acquisition/books';
import { queueDownloads, runDownloads, stopDownloads } from '../src/comics/acquisition';
import * as analytics from '../src/analytics';
// Image decoding itself has separate tests; exercise real page acquisition, authorization and storage here.
vi.mock('../src/comics/pages/normalize', () => ({
  prepareComicPage: async ({ blob }: { blob: Blob }) => ({
    blob,
    width: 10,
    height: 20,
    imageSha256: 'a'.repeat(64),
  }),
}));
const unregister: (() => void)[] = [];
beforeEach(async () => {
  const db = await openCatalog(),
    tables = Array.from(db.objectStoreNames);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(tables, 'readwrite');
    for (const table of tables) tx.objectStore(table).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await downloadStore.clear();
  await sourcePageCache.clear();
});
afterEach(() => {
  stopDownloads();
  for (const release of unregister.splice(0)) release();
  vi.restoreAllMocks();
});
async function fixture(providerId = 'pages-fixture') {
  const connectionId = crypto.randomUUID(),
    publicationId = crypto.randomUUID(),
    now = Date.now();
  const plan: RemoteReadingPlan = {
    publication: { id: publicationId, title: 'Single remote volume' },
    kind: 'pages',
    format: 'image-sequence',
    representationId: 'pages',
    locator: { id: publicationId },
    snapshot: { version: 'v1' },
  };
  const browse = vi.fn(async () => ({
    title: 'Not a chapter tree',
    location: 'root',
    navigation: [],
    publications: [],
  }));
  const read = vi.fn(async () => new Blob(['page'], { type: 'image/png' }));
  const provider: SourceProvider = {
    id: providerId,
    label: 'Page fixture',
    cachePages: true,
    cacheRanges: false,
    catalog: { browse, resolve: async () => plan },
    pages: {
      index: async () => ({
        pages: Array.from({ length: 3 }, (_, ordinal) => ({
          ordinal,
          name: String(ordinal + 1),
          locator: { id: publicationId, page: ordinal },
        })),
        complete: true,
        total: 3,
      }),
      read,
    },
  };
  unregister.push(registerSourceDriver(provider));
  await catalog.put('connections', {
    id: connectionId,
    provider: provider.id,
    displayName: 'Pages',
    generation: 1,
    status: 'connected',
    createdAt: now,
    updatedAt: now,
  });
  const result = await openRemotePublication(connectionId, publicationId);
  if (result.kind !== 'opened') throw Error('fixture');
  return { connectionId, result, browse, read, plan };
}
async function readEntryPage(entryId: string) {
  const entry = (await catalog.get('entries', entryId))!,
    [page] = await catalog.listPages(entry.contentId);
  return acquirePage({
    entryId,
    contentId: entry.contentId,
    pageId: page.pageId,
    renderProfileId: pageRenderProfile(entry.format),
    purpose: 'reading',
  });
}
describe('remote page publication offline plans', () => {
  it.each([
    ['opds', 'opds'],
    ['website', 'website'],
    ['private-provider', 'unknown'],
  ])('reports only the allowlisted terminal category for %s', async (providerId, sourceType) => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {}),
      f = await fixture(providerId);
    await startBookDownload(f.result.comicId);
    await runBookDownloadCycle(new AbortController().signal, 'pages-host');
    await runBookDownloadCycle(new AbortController().signal, 'pages-host');
    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith(
      'offline_download_result',
      expect.objectContaining({ source_type: sourceType, outcome: 'success' }),
      expect.any(Number),
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain(f.connectionId);
    if (sourceType === 'unknown')
      expect(JSON.stringify(track.mock.calls)).not.toContain(providerId);
  });
  it('reuses the verified retained inventory during content preparation', async () => {
    const f = await fixture();
    await queueDownloads([f.result.entryId]);
    const inventory = vi.spyOn(downloadStore, 'inventory');
    await runDownloads();
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledTimes(3);
  });
  it('caches exactly the publication entry without traversing library navigation or changing reading progress', async () => {
    const f = await fixture();
    expect(await readComicOfflineCapability(f.result.comicId)).toBe('pages');
    await startBookDownload(f.result.comicId);
    await runBookDownloadCycle(new AbortController().signal, 'pages-host');
    expect(f.read).toHaveBeenCalledTimes(3);
    expect(f.browse).not.toHaveBeenCalled();
    expect((await listBookDownloads(true))[0]).toMatchObject({
      completed: 1,
      total: 1,
      bytes: 12,
      status: 'complete',
    });
    expect(await catalog.list('positions')).toEqual([]);
    expect((await catalog.get('entries', f.result.entryId))?.readAt).toBeUndefined();
  });
  it('rejects late image persistence after connection revocation', async () => {
    const f = await fixture(),
      ready = Promise.withResolvers<void>(),
      late = Promise.withResolvers<Blob>();
    f.read.mockImplementationOnce(() => {
      ready.resolve();
      return late.promise;
    });
    await startBookDownload(f.result.comicId);
    const run = runBookDownloadCycle(new AbortController().signal, 'pages-host');
    await ready.promise;
    await invalidateSourceAccess({ connectionId: f.connectionId });
    late.resolve(new Blob(['late'], { type: 'image/png' }));
    await run;
    expect((await downloadStore.usage()).count).toBe(0);
    expect((await listBookDownloads())[0].status).not.toBe('complete');
  });
  it('reads retained pages after normal cache clearing and network failure, but requires access again after explicit disconnect', async () => {
    const f = await fixture();
    await startBookDownload(f.result.comicId);
    await runBookDownloadCycle(new AbortController().signal, 'pages-host');
    await sourcePageCache.clear();
    f.read.mockRejectedValue(new TypeError('offline'));
    let lease = await readEntryPage(f.result.entryId);
    expect(await lease.blob.text()).toBe('page');
    lease.release();
    expect(f.read).toHaveBeenCalledTimes(3);
    expect((await downloadStore.usage()).count).toBe(3);
    await invalidateSourceAccess({ connectionId: f.connectionId });
    await expect(readEntryPage(f.result.entryId)).rejects.toThrow('断开');
    expect((await downloadStore.usage()).count).toBe(3);
    await restoreSourceResources((await catalog.get('connections', f.connectionId))!);
    lease = await readEntryPage(f.result.entryId);
    lease.release();
    expect(f.read).toHaveBeenCalledTimes(3);
    expect((await listBookDownloads(true))[0].status).toBe('complete');
  });
  it('isolates page publications with identical remote IDs across two connections and providers', async () => {
    const a = await fixture('pages-one'),
      b = await fixture('pages-two');
    const first = (await catalog.get('connections', a.connectionId))!,
      otherId = crypto.randomUUID();
    await catalog.put('connections', { ...first, id: otherId });
    const other = await openRemotePublication(otherId, a.plan.publication.id);
    if (other.kind !== 'opened') throw Error('fixture');
    for (const comicId of [a.result.comicId, b.result.comicId, other.comicId])
      await startBookDownload(comicId);
    for (let i = 0; i < 3; i++)
      await runBookDownloadCycle(new AbortController().signal, 'pages-host');
    expect((await listBookDownloads(true)).map((view) => view.status)).toEqual([
      'complete',
      'complete',
      'complete',
    ]);
    expect(a.read).toHaveBeenCalledTimes(6);
    expect(b.read).toHaveBeenCalledTimes(3);
    await invalidateSourceAccess({ connectionId: a.connectionId });
    await expect(readEntryPage(a.result.entryId)).rejects.toThrow('断开');
    for (const entryId of [b.result.entryId, other.entryId]) {
      const lease = await readEntryPage(entryId);
      lease.release();
    }
    expect((await downloadStore.usage()).count).toBe(9);
    expect(a.read).toHaveBeenCalledTimes(6);
    expect(b.read).toHaveBeenCalledTimes(3);
  });
});
