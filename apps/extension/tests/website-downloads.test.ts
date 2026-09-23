import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/comics/repositories';
import type { Entry, PageDescriptor } from '../src/comics/domain';
import type { PageManifest } from '../src/sources/contracts/source';
import { downloadKey, downloadStore } from '../src/storage/downloads';

const mocks = vi.hoisted(() => ({ acquire: vi.fn(), discover: vi.fn(), permissions: vi.fn() }));
vi.mock('../src/comics/pages/service', () => ({ acquirePage: mocks.acquire }));
vi.mock('../src/sources', () => ({ discoverEntry: mocks.discover, requestImagePermissions: mocks.permissions, ImagePermissionsRequired: class ImagePermissionsRequired extends Error {} }));
vi.mock('../src/comics/application/import-service', () => ({
  publishWebsiteManifest: async (document: Entry, manifest: PageManifest) => {
    const { catalog } = await import('../src/comics/repositories');
    await catalog.putPages(document.id, document.contentId, manifest.items.map((item, ordinal) => ({ pageId: `${document.id}:page:${ordinal}`, contentId: document.contentId, ordinal, name: `page${ordinal}`, formatLocator: item.id, locator: { url: item.url } })), document.generation);
    await catalog.patch('entries', document.id, { discoveryComplete: manifest.discoveryComplete, pageCount: manifest.items.length });
  },
}));
import { discoverEntryContent, grantDownloads, listDownloads, pauseDownloads, queueDownloads, runDownloads, stopDownloads } from '../src/comics/acquisition';

beforeEach(async () => {
  stopDownloads(); mocks.acquire.mockReset(); mocks.discover.mockReset(); mocks.permissions.mockReset();
  mocks.permissions.mockResolvedValue(undefined);
  for (const task of await catalog.list('tasks', { limit: 10000 })) await catalog.remove('tasks', task.id);
  mocks.acquire.mockImplementation(async () => ({ blob: new Blob(['image']), release: vi.fn(), identity: {} }));
});
async function fixture(pageCount = 2, complete = true, id: string = crypto.randomUUID()) {
  const contentId = id + ':revision';
  const document: Entry = { id, title: 'Website test', comicId:id+':comic',order:0,sourceUrl:'https://example.org/comic', format: 'website', contentId, generation: 1, indexState: 'ready', discoveryComplete: complete, pageCount, sourceEntryId: id + ':entry', createdAt: 1, updatedAt: 1 };
  await catalog.commit([
    { table: 'entries', value: document },
    {table:'comics',value:{id:id+':comic',title:'Test',sourceName:'Website',sourceKey:id,source:{connectionId:'website:test',providerItemId:id,locator:{catalogId:id+':catalog'},generation:1,status:'active'},createdAt:1,updatedAt:1}},
    { table: 'catalogs', value: { id: id + ':catalog', sourceId: 'test', url: 'https://example.org/comic', title: 'Test', entries: [], groups: [], complete: true } },
  ]);
  const pages: PageDescriptor[] = Array.from({ length: pageCount }, (_, ordinal) => ({ pageId: id + ':page:' + ordinal, contentId, ordinal, name: `page${ordinal}`, formatLocator: 'image:' + ordinal, locator: { url: `https://example.org/${ordinal}.png` } }));
  await catalog.putPages(id, contentId, pages, 1); return { document, pages };
}

describe('explicit website download intents', () => {
  it('discovers page metadata without silently creating a download task or fetching images', async () => {
    const f = await fixture(0, false);
    const manifest = { id: 'snapshot', title: 'Test', url: 'https://example.org/comic', items: [{ id: 'source-page', url: 'https://example.org/image.png', width: 10, height: 20, order: 0 }], discoveryComplete: true } as PageManifest;
    mocks.discover.mockImplementation(async (_catalog, _entry, _signal, update) => { await update(manifest); return manifest; });
    await discoverEntryContent(f.document.id);
    expect((await catalog.listPages(f.document.contentId)).length).toBe(1);
    expect(mocks.acquire).not.toHaveBeenCalled(); expect(await listDownloads()).toEqual([]);
  });
  it('deduplicates queue submissions and skips already saved pages on retry', async () => {
    const f = await fixture();
    await Promise.all([queueDownloads([f.document.id]), queueDownloads([f.document.id, f.document.id])]);
    expect(await listDownloads()).toHaveLength(1);
    await Promise.all([runDownloads(), runDownloads()]);
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect((await listDownloads())[0]).toMatchObject({ status: 'complete', completed: 2 });
    await queueDownloads([f.document.id]); await runDownloads();
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
  });
  it('preserves directory order when a batch is queued within one clock tick', async () => {
    const first = await fixture(1, true, 'zzz:' + crypto.randomUUID()), second = await fixture(1, true, 'aaa:' + crypto.randomUUID());
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try { await queueDownloads([first.document.id, second.document.id]); } finally { now.mockRestore(); }
    await runDownloads();
    expect(mocks.acquire.mock.calls.map(([request]) => request.entryId)).toEqual([first.document.id, second.document.id]);
  });
  it('fences an in-flight page after pause and resumes explicitly without losing retained pages', async () => {
    const f = await fixture(1); let release!: (value: unknown) => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    mocks.acquire.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
    await queueDownloads([f.document.id]); const run = runDownloads(); await ready;
    await pauseDownloads([f.document.id]); release({ blob: new Blob(['late']), release: vi.fn(), identity: {} }); await run;
    expect((await listDownloads())[0].status).toBe('paused');
    expect(await downloadStore.get(downloadKey(f.document.contentId, f.pages[0].pageId))).toBeUndefined();
    await queueDownloads([f.document.id]); await runDownloads();
    expect((await listDownloads())[0]).toMatchObject({ status: 'complete', completed: 1 });
  });
  it('turns abandoned running work into paused recovery, without automatically downloading it', async () => {
    const f = await fixture();
    await catalog.put('tasks', { id: 'download:' + f.document.id, entryId: f.document.id, status: 'running', generation: 2, entryGeneration: 1, contentId: f.document.contentId, completed: 0, leaseUntil: 0, updatedAt: 0 });
    await runDownloads();
    expect((await listDownloads())[0]).toMatchObject({ status: 'paused', generation: 3 });
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it('stops the download lifetime before starting another queued document', async () => {
    const first = await fixture(1), second = await fixture(1), ready = Promise.withResolvers<void>(), image = Promise.withResolvers<unknown>();
    mocks.acquire.mockImplementationOnce(() => { ready.resolve(); return image.promise; });
    await queueDownloads([first.document.id, second.document.id]); const run = runDownloads(); await ready.promise;
    expect(mocks.acquire.mock.calls[0][0].entryId).toBe(first.document.id);
    stopDownloads(); image.resolve({ blob: new Blob(['late']), release: vi.fn(), identity: {} }); await run;
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    const statuses = new Map((await listDownloads()).map(task => [task.entryId, task.status]));
    expect(statuses.get(first.document.id)).toBe('paused'); expect(statuses.get(second.document.id)).toBe('queued');
    expect(await downloadStore.get(downloadKey(first.document.contentId, first.pages[0].pageId))).toBeUndefined();
    await runDownloads(); expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect((await listDownloads()).find(task => task.entryId === second.document.id)?.status).toBe('complete');
  });
  it('does not restore a retained download cleared while its image was still loading', async () => {
    const f = await fixture(1), ready = Promise.withResolvers<void>(), image = Promise.withResolvers<unknown>();
    mocks.acquire.mockImplementationOnce(() => { ready.resolve(); return image.promise; });
    await queueDownloads([f.document.id]); const run = runDownloads(); await ready.promise;
    await downloadStore.deleteOwner(f.document.id); image.resolve({ blob: new Blob(['late']), release: vi.fn(), identity: {} }); await run;
    expect(await downloadStore.get(downloadKey(f.document.contentId, f.pages[0].pageId))).toBeUndefined();
    expect((await listDownloads())[0].status).toBe('paused');
  });
  it('continues independent pages after a failure and retries only missing bytes', async () => {
    const f = await fixture(3);
    mocks.acquire.mockResolvedValueOnce({ blob: new Blob(['first']), release: vi.fn(), identity: {} }).mockRejectedValueOnce(Error('Temporary source failure'));
    await queueDownloads([f.document.id]); await runDownloads();
    expect((await listDownloads())[0]).toMatchObject({ status: 'failed', completed: 2 });
    await queueDownloads([f.document.id]); await runDownloads();
    expect((await listDownloads())[0]).toMatchObject({ status: 'complete', completed: 3 });
    expect(mocks.acquire).toHaveBeenCalledTimes(4);
  });
  it('requests prepared image origins in the click stack before writing download intent', async () => {
    const f = await fixture(); let resolve!: () => void;
    mocks.permissions.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const granted = grantDownloads([f.document.id], ['https://cdn.example/*']);
    expect(mocks.permissions).toHaveBeenCalledWith(['https://cdn.example/*']);
    expect(await listDownloads()).toEqual([]); resolve(); await granted;
    expect((await listDownloads())[0].status).toBe('queued');
  });
});
