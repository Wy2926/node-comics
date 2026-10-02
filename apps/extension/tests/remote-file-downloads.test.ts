import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/index-native.js';
import { catalog, openCatalog } from '../src/comics/repositories';
import { bytesTransaction, idbRequest, CHUNK_SIZE } from '../src/storage/bytes/database';
import {
  importContainerStream,
  listContainerReferences,
  openContainer,
  retainContainer,
} from '../src/storage/containers';
import * as containers from '../src/storage/containers';
import { registerSourceDriver } from '../src/comics/sources/registry';
import type {
  FileTransfer,
  RemoteReadingPlan,
  SourceProvider,
} from '../src/comics/sources/contracts';
import { openRemotePublication } from '../src/comics/application/remote-library-service';
import * as remoteLibrary from '../src/comics/application/remote-library-service';
import {
  invalidateSourceAccess,
  restoreSourceResources,
} from '../src/comics/application/source-access';
import { removeComic } from '../src/comics/application/library-service';
import { openFileSource } from '../src/comics/sources/runtime';
import {
  clearRemoteFileDownload,
  listRemoteFileDownloads,
  pauseRemoteFileDownload,
  prepareRemoteFileDownload,
  queueRemoteFileDownload,
  readRemoteFileDownload,
  recoverRemoteFileDownloads,
  resumeRemoteFileDownload,
  runRemoteFileDownloadCycle,
  stopRemoteFileDownloads,
} from '../src/comics/acquisition/files';

const unregister: (() => void)[] = [];
const byteTables = ['objects', 'chunks', 'operations', 'references', 'leases', 'settings'];
const rows = (name: string) =>
  bytesTransaction([name], 'readonly', (tx) => idbRequest(tx.objectStore(name).getAll()));
beforeEach(async () => {
  stopRemoteFileDownloads();
  const db = await openCatalog(),
    tables = Array.from(db.objectStoreNames);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(tables, 'readwrite');
    for (const table of tables) tx.objectStore(table).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await bytesTransaction(byteTables, 'readwrite', async (tx) => {
    for (const table of byteTables) tx.objectStore(table).clear();
  });
});
afterEach(() => {
  stopRemoteFileDownloads();
  for (const release of unregister.splice(0)) release();
  vi.restoreAllMocks();
});
async function archive(size = 32) {
  const png = new Uint8Array(size);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(png.buffer).setUint32(16, 200);
  new DataView(png.buffer).setUint32(20, 100);
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
  await zip.add('1.png', new BlobReader(new Blob([png])));
  return zip.close();
}
async function fixture(providerId = 'file-fixture', publicationId = crypto.randomUUID()) {
  const connectionId = 'server:' + crypto.randomUUID(),
    bytes = await archive(),
    now = Date.now();
  const plan: RemoteReadingPlan = {
    publication: { id: publicationId, title: 'Remote archive' },
    kind: 'download-file',
    representationId: 'archive',
    format: 'cbz',
    locator: { id: publicationId },
    snapshot: { version: 'v1' },
    size: bytes.byteLength,
  };
  const download = vi.fn<() => Promise<FileTransfer>>(async () => ({
    name: 'remote.cbz',
    size: bytes.byteLength,
    stream: new Blob([bytes]).stream(),
  }));
  const resolve = vi.fn(async () => plan);
  const provider: SourceProvider = {
    id: providerId,
    label: 'Fixture',
    cachePages: true,
    cacheRanges: true,
    catalog: {
      browse: async () => ({
        title: 'Library',
        location: 'root',
        navigation: [],
        publications: [],
      }),
      resolve,
    },
    files: {
      open: async () => {
        throw Error('range unsupported');
      },
      download,
    },
  };
  unregister.push(registerSourceDriver(provider));
  await catalog.put('connections', {
    id: connectionId,
    provider: provider.id,
    displayName: 'Fixture',
    status: 'connected',
    generation: 1,
    createdAt: now,
    updatedAt: now,
  });
  return { connectionId, plan, bytes, download, resolve };
}
const cycle = () => runRemoteFileDownloadCycle(new AbortController().signal, 'test-host');
async function pausedStream(f: Awaited<ReturnType<typeof fixture>>) {
  const bytes = await archive(CHUNK_SIZE),
    progress = Promise.withResolvers<void>(),
    cancel = vi.fn();
  let delivered = false;
  f.download.mockImplementation(async () => ({
    name: 'remote.cbz',
    size: bytes.byteLength,
    stream: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(bytes.slice(0, CHUNK_SIZE));
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
  }));
  const intent = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
  const unsubscribe = catalog.subscribe((change) => {
    if (change.table === 'metadata' && change.ids.includes(intent.id))
      void readRemoteFileDownload(intent.id).then((current) => {
        if (current?.bytes === CHUNK_SIZE) progress.resolve();
      });
  });
  const run = cycle();
  await progress.promise;
  unsubscribe();
  return { intent, run, cancel };
}
async function retainedSource(
  intent: NonNullable<Awaited<ReturnType<typeof readRemoteFileDownload>>>,
) {
  const comic = (await catalog.get('comics', intent.comicId!))!,
    entry = (await catalog.get('entries', intent.entryId!))!;
  return openFileSource({
    connection: (await catalog.get('connections', comic.source.connectionId))!,
    source: comic.source,
    entryId: entry.id,
    contentId: entry.contentId,
    format: entry.format,
    containerId: entry.containerId,
  });
}

describe('confirmed remote file intents', () => {
  it('requires confirmation and queues once without network, a comic, or page-download tasks', async () => {
    const f = await fixture();
    await expect(
      queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: false } as never),
    ).rejects.toThrow('确认');
    const [first, second] = await Promise.all([
      queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true }),
      queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true }),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.generation).toBe(second.generation);
    expect(f.download).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(await catalog.list('tasks')).toEqual([]);
    expect(await catalog.list('comics')).toEqual([]);
  });
  it('streams, indexes and publishes one remote-backed comic, then clears only its local container', async () => {
    const f = await fixture(),
      intent = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await cycle();
    const done = (await readRemoteFileDownload(intent.id))!;
    expect(done).toMatchObject({
      status: 'complete',
      bytes: f.bytes.byteLength,
      totalBytes: f.bytes.byteLength,
    });
    const comic = (await catalog.get('comics', done.comicId!))!,
      entry = (await catalog.get('entries', done.entryId!))!;
    expect(comic.source.connectionId).toBe(f.connectionId);
    expect(entry.containerId).toBeTruthy();
    expect(await catalog.list('tasks')).toEqual([]);
    expect((await listRemoteFileDownloads())[0].comic?.id).toBe(comic.id);
    const source = await openFileSource({
      connection: (await catalog.get('connections', f.connectionId))!,
      source: comic.source,
      entryId: entry.id,
      contentId: entry.contentId,
      format: entry.format,
      containerId: entry.containerId,
    });
    expect(await source.readAt(0, 2)).toEqual(new Uint8Array([80, 75]));
    await source.close();
    const [page] = await catalog.listPages(entry.contentId);
    await catalog.savePosition({
      id: entry.id,
      comicId: comic.id,
      entryId: entry.id,
      contentId: entry.contentId,
      pageId: page.pageId,
      relativeOffset: 0.4,
      updatedAt: Date.now(),
    });
    const before = await catalog.get('positions', entry.id);
    await clearRemoteFileDownload(intent.id, done.generation);
    expect(await readRemoteFileDownload(intent.id)).toBeUndefined();
    expect((await catalog.get('entries', entry.id))?.containerId).toBeUndefined();
    expect(await catalog.get('positions', entry.id)).toEqual(before);
    expect(await catalog.get('comics', comic.id)).toBeDefined();
    expect(await rows('objects')).toEqual([]);
    expect((await openRemotePublication(f.connectionId, f.plan.publication.id)).kind).toBe(
      'download-required',
    );
  });
  it('pauses a stalled transfer, discards partial chunks and resumes from byte zero explicitly', async () => {
    const f = await fixture(),
      { intent, run, cancel } = await pausedStream(f);
    await pauseRemoteFileDownload(intent.id, intent.generation);
    await run;
    expect(cancel).toHaveBeenCalled();
    expect(await readRemoteFileDownload(intent.id)).toMatchObject({ status: 'paused', bytes: 0 });
    expect(await rows('operations')).toEqual([]);
    expect(await rows('chunks')).toEqual([]);
    expect(await rows('objects')).toEqual([]);
    const paused = (await readRemoteFileDownload(intent.id))!;
    f.download.mockImplementation(async () => ({
      name: 'remote.cbz',
      stream: new Blob([f.bytes]).stream(),
      size: f.bytes.byteLength,
    }));
    await resumeRemoteFileDownload(intent.id, paused.generation);
    expect((await readRemoteFileDownload(intent.id))?.contentId).not.toBe(intent.contentId);
    await cycle();
    expect(f.download).toHaveBeenCalledTimes(2);
    expect((await readRemoteFileDownload(intent.id))?.status).toBe('complete');
  });
  it('revokes an in-flight response before a book can be published', async () => {
    const f = await fixture(),
      { intent, run, cancel } = await pausedStream(f);
    await catalog.patch('connections', f.connectionId, { status: 'disconnected', generation: 2 });
    await run;
    expect(cancel).toHaveBeenCalled();
    expect((await readRemoteFileDownload(intent.id))?.status).toBe('paused');
    expect(await catalog.list('comics')).toEqual([]);
    expect(await rows('chunks')).toEqual([]);
    await expect(resumeRemoteFileDownload(intent.id)).rejects.toThrow('连接');
  });
  it('does not let a late old transfer overwrite a freshly queued generation after clearing', async () => {
    const f = await fixture(),
      { intent, run } = await pausedStream(f);
    await clearRemoteFileDownload(intent.id, intent.generation);
    const next = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await run;
    expect(next.generation).toBeGreaterThan(intent.generation);
    expect(await readRemoteFileDownload(next.id)).toMatchObject({
      status: 'queued',
      generation: next.generation,
      contentId: next.contentId,
    });
    await pauseRemoteFileDownload(next.id, intent.generation);
    expect((await readRemoteFileDownload(next.id))?.status).toBe('queued');
  });
  it('records a failed transfer without private URLs and does not automatically retry it', async () => {
    const f = await fixture();
    f.download.mockRejectedValue(
      new TypeError('network https://private.example/file?secret=value'),
    );
    const intent = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await cycle();
    await cycle();
    expect(await readRemoteFileDownload(intent.id)).toMatchObject({
      status: 'paused',
      reason: 'network',
      bytes: 0,
    });
    expect((await readRemoteFileDownload(intent.id))?.error).not.toContain('secret');
    expect(f.download).toHaveBeenCalledOnce();
  });
  it('pauses old queued intents on page restart, and removes a published but unregistered staging reference', async () => {
    const f = await fixture(),
      intent = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await importContainerStream(new Blob([f.bytes]).stream(), {
      name: 'remote.cbz',
      referenceId: intent.contentId,
    });
    expect(await listContainerReferences(intent.contentId)).toHaveLength(1);
    await recoverRemoteFileDownloads(Date.now() + 1);
    expect(await readRemoteFileDownload(intent.id)).toMatchObject({
      status: 'paused',
      reason: 'interrupted',
      bytes: 0,
    });
    expect(await rows('objects')).toEqual([]);
    expect(f.download).not.toHaveBeenCalled();
  });
  it('retains a successfully attached file across a later stale pause and across restart', async () => {
    const f = await fixture(),
      intent = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await cycle();
    const done = (await readRemoteFileDownload(intent.id))!;
    await pauseRemoteFileDownload(intent.id, intent.generation);
    await recoverRemoteFileDownloads(Date.now() + 1);
    expect((await readRemoteFileDownload(intent.id))?.status).toBe('complete');
    const source = await openContainer(done.containerId!);
    await source.close();
    expect(f.download).toHaveBeenCalledOnce();
  });
  it('cannot move an intent back to paused when publication wins the pause transaction race', async () => {
    const f = await fixture(),
      intent = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    const mutate = catalog.mutate.bind(catalog);
    vi.spyOn(catalog, 'mutate').mockImplementationOnce(async (tables, operation) => {
      await cycle();
      return mutate(tables, operation);
    });
    await pauseRemoteFileDownload(intent.id, intent.generation);
    const done = (await readRemoteFileDownload(intent.id))!;
    expect(done.status).toBe('complete');
    const source = await openContainer(done.containerId!);
    await source.close();
  });
  it('allows confirmed repair after local container bytes go missing, without replacing reading identity', async () => {
    const f = await fixture(),
      intent = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await cycle();
    const done = (await readRemoteFileDownload(intent.id))!;
    await bytesTransaction(['chunks'], 'readwrite', async (tx) => {
      tx.objectStore('chunks').clear();
    });
    expect((await openRemotePublication(f.connectionId, f.plan.publication.id)).kind).toBe(
      'download-required',
    );
    const next = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    expect(next.status).toBe('queued');
    expect(next.generation).toBeGreaterThan(done.generation);
    await cycle();
    const repaired = (await readRemoteFileDownload(intent.id))!;
    expect(repaired.status).toBe('complete');
    expect(repaired.contentId).toBe(done.contentId);
    expect(repaired.comicId).toBe(done.comicId);
    const source = await openContainer(repaired.containerId!);
    await source.close();
    expect(f.download).toHaveBeenCalledTimes(2);
  });
  it('rejects a first queued transfer after another tab registered and deleted the same publication', async () => {
    const f = await fixture(),
      intent = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true }),
      now = Date.now();
    const comicId = crypto.randomUUID();
    await catalog.put('comics', {
      id: comicId,
      sourceKey: JSON.stringify([f.connectionId, f.plan.publication.id]),
      title: 'Other tab',
      sourceName: 'Fixture',
      source: {
        connectionId: f.connectionId,
        providerItemId: f.plan.publication.id,
        locator: f.plan.locator,
        generation: 1,
        status: 'active',
      },
      createdAt: now,
      updatedAt: now,
    });
    await catalog.deleteComic(comicId);
    await cycle();
    expect(await readRemoteFileDownload(intent.id)).toBeUndefined();
    expect(f.download).not.toHaveBeenCalled();
    expect(await catalog.list('comics')).toEqual([]);
    await resumeRemoteFileDownload(intent.id);
    await cycle();
    expect(f.download).not.toHaveBeenCalled();
    const next = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    expect(next.generation).toBeGreaterThan(intent.generation);
    await cycle();
    expect((await readRemoteFileDownload(intent.id))?.status).toBe('complete');
    expect(f.download).toHaveBeenCalledOnce();
  });
  it('prepares a confirmation from metadata only and preserves the existing content identity when re-downloaded', async () => {
    const f = await fixture(),
      intent = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await cycle();
    const done = (await readRemoteFileDownload(intent.id))!,
      oldContent = done.contentId;
    await clearRemoteFileDownload(intent.id);
    const prepared = await prepareRemoteFileDownload(done.comicId!);
    expect(prepared.connectionId).toBe(f.connectionId);
    expect(f.download).toHaveBeenCalledOnce();
    const next = await queueRemoteFileDownload(f.connectionId, prepared.plan, { confirmed: true });
    expect(next.contentId).not.toBe(oldContent);
    await cycle();
    const current = (await readRemoteFileDownload(next.id))!;
    expect(current.status).toBe('complete');
    expect(current.contentId).toBe(oldContent);
    expect(await listContainerReferences(next.contentId)).toEqual([]);
    expect(await listContainerReferences(oldContent)).toHaveLength(1);
    expect(await catalog.list('comics')).toHaveLength(1);
  });
  it('requires explicit retry after disconnect/reconnect and preserves retained bytes behind the access gate', async () => {
    const f = await fixture(),
      { intent, run } = await pausedStream(f);
    await invalidateSourceAccess({ connectionId: f.connectionId });
    await run;
    const paused = (await readRemoteFileDownload(intent.id))!;
    expect(paused.status).toBe('paused');
    await restoreSourceResources((await catalog.get('connections', f.connectionId))!);
    await cycle();
    expect(f.download).toHaveBeenCalledOnce();
    f.download.mockResolvedValue({
      name: 'remote.cbz',
      stream: new Blob([f.bytes]).stream(),
      size: f.bytes.byteLength,
    });
    await resumeRemoteFileDownload(intent.id, paused.generation);
    await cycle();
    const done = (await readRemoteFileDownload(intent.id))!;
    expect(done.status).toBe('complete');
    expect(done.connectionGeneration).toBeGreaterThan(intent.connectionGeneration);
    let source = await retainedSource(done);
    await source.close();
    await invalidateSourceAccess({ connectionId: f.connectionId });
    await expect(retainedSource(done)).rejects.toThrow('断开');
    expect(await listContainerReferences(done.contentId)).toHaveLength(1);
    await restoreSourceResources((await catalog.get('connections', f.connectionId))!);
    source = await retainedSource(done);
    await source.close();
    expect(f.download).toHaveBeenCalledTimes(2);
  });
  it('cleans a deleted publication and its pending transfer without recreating it or leaving a visible intent', async () => {
    const f = await fixture(),
      first = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await cycle();
    const done = (await readRemoteFileDownload(first.id))!;
    await clearRemoteFileDownload(first.id);
    const { intent, run } = await pausedStream(f);
    await removeComic(done.comicId!);
    await run;
    expect(await listRemoteFileDownloads()).toEqual([]);
    await cycle();
    expect(await readRemoteFileDownload(intent.id)).toBeUndefined();
    expect(await catalog.list('comics')).toEqual([]);
    for (const table of ['objects', 'chunks', 'operations', 'references'])
      expect(await rows(table)).toEqual([]);
    f.download.mockResolvedValue({ name: 'remote.cbz', stream: new Blob([f.bytes]).stream() });
    const next = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await cycle();
    const reopened = (await readRemoteFileDownload(next.id))!;
    expect(reopened.status).toBe('complete');
    expect(reopened.comicId).not.toBe(done.comicId);
  });
  it.each(['running', 'paused'] as const)(
    'recovers an unclaimed replacement reference after a crash in %s state without deleting the older claimed file',
    async (status) => {
      const f = await fixture(),
        first = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
      await cycle();
      const done = (await readRemoteFileDownload(first.id))!,
        temporary = crypto.randomUUID();
      const candidate = await importContainerStream(new Blob([await archive(99)]).stream(), {
        name: 'replacement.cbz',
        referenceId: temporary,
      });
      await retainContainer(candidate.id, done.contentId);
      await catalog.put('metadata', {
        ...done,
        status,
        generation: done.generation + 1,
        contentId: temporary,
        importReferenceId: temporary,
        importTargetReferenceId: done.contentId,
        containerId: candidate.id,
        createdAt: 0,
      });
      await recoverRemoteFileDownloads(Date.now() + 1);
      expect(await listContainerReferences(temporary)).toEqual([]);
      expect((await listContainerReferences(done.contentId)).map((item) => item.id)).toEqual([
        done.containerId,
      ]);
      const source = await retainedSource(done);
      await source.close();
      expect(await rows('objects')).toHaveLength(1);
    },
  );
  it('keeps the candidate cleanup journal when releasing an unclaimed target fails', async () => {
    const f = await fixture(),
      first = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await cycle();
    const done = (await readRemoteFileDownload(first.id))!;
    await clearRemoteFileDownload(first.id);
    const next = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    vi.spyOn(remoteLibrary, 'registerRemoteContainer').mockImplementationOnce(
      async (_context, container, _contentId, _signal, guard) => {
        await catalog.patch('metadata', guard!.id, { importTargetReferenceId: done.contentId });
        await retainContainer(container.id, done.contentId);
        throw Error('Publication was interrupted');
      },
    );
    vi.spyOn(containers, 'releaseContainer').mockRejectedValueOnce(
      Error('Temporary storage failure'),
    );
    await cycle();
    const failed = (await readRemoteFileDownload(next.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.containerId).toBeTruthy();
    expect(await listContainerReferences(done.contentId)).toHaveLength(1);
    await recoverRemoteFileDownloads(Date.now() + 1);
    expect(await listContainerReferences(done.contentId)).toEqual([]);
    expect(await listContainerReferences(next.contentId)).toEqual([]);
    expect(await rows('objects')).toEqual([]);
  });
  it('keeps atomic completion when post-publication cleanup needs startup recovery', async () => {
    const f = await fixture(),
      first = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    await cycle();
    const done = (await readRemoteFileDownload(first.id))!;
    await clearRemoteFileDownload(first.id);
    const next = await queueRemoteFileDownload(f.connectionId, f.plan, { confirmed: true });
    vi.spyOn(containers, 'releaseContainer').mockRejectedValueOnce(
      Error('Temporary release failure'),
    );
    vi.spyOn(containers, 'discardContainerImports').mockRejectedValueOnce(
      Error('Temporary cleanup failure'),
    );
    await cycle();
    const published = (await readRemoteFileDownload(next.id))!;
    expect(published).toMatchObject({
      status: 'complete',
      contentId: done.contentId,
      importReferenceId: next.contentId,
    });
    expect(await listContainerReferences(next.contentId)).toHaveLength(1);
    await recoverRemoteFileDownloads(Date.now() + 1);
    expect((await readRemoteFileDownload(next.id))?.status).toBe('complete');
    expect(await listContainerReferences(next.contentId)).toEqual([]);
    expect(await listContainerReferences(done.contentId)).toHaveLength(1);
    const source = await retainedSource(published);
    await source.close();
  });
  it('isolates two providers and repeated remote IDs across three connections, including deduplicated local bytes', async () => {
    const publicationId = crypto.randomUUID(),
      a = await fixture('file-one', publicationId),
      b = await fixture('file-two', publicationId);
    b.download.mockImplementation(async () => ({
      name: 'remote.cbz',
      stream: new Blob([a.bytes]).stream(),
      size: a.bytes.byteLength,
    }));
    const connection = (await catalog.get('connections', a.connectionId))!,
      thirdId = crypto.randomUUID();
    await catalog.put('connections', { ...connection, id: thirdId });
    const first = await queueRemoteFileDownload(a.connectionId, a.plan, { confirmed: true }),
      second = await queueRemoteFileDownload(b.connectionId, b.plan, { confirmed: true }),
      third = await queueRemoteFileDownload(thirdId, a.plan, { confirmed: true });
    for (let i = 0; i < 3; i++) await cycle();
    const done = await Promise.all(
      [first, second, third].map(async (intent) => (await readRemoteFileDownload(intent.id))!),
    );
    expect(new Set(done.map((intent) => intent.comicId)).size).toBe(3);
    expect(new Set(done.map((intent) => intent.containerId)).size).toBe(1);
    await invalidateSourceAccess({ connectionId: a.connectionId });
    await expect(retainedSource(done[0])).rejects.toThrow('断开');
    for (const intent of done.slice(1)) {
      const source = await retainedSource(intent);
      await source.close();
    }
    await clearRemoteFileDownload(first.id);
    expect(await listContainerReferences(done[0].contentId)).toEqual([]);
    expect(await rows('objects')).toHaveLength(1);
    expect(await rows('references')).toHaveLength(2);
    for (const intent of done.slice(1)) {
      const source = await retainedSource(intent);
      await source.close();
    }
  });
});
