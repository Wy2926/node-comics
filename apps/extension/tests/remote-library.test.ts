import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/comics/repositories';
import { registerSourceDriver } from '../src/comics/sources/registry';
import { openFileSource } from '../src/comics/sources/runtime';
import type {
  RemoteReadingPlan,
  SourceAccount,
  SourceProvider,
} from '../src/comics/sources/contracts';
import {
  browseRemoteLibrary,
  connectRemoteLibrary,
  listRemoteLibraries,
  listRemoteProviders,
  openRegisteredRemoteComic,
  openRemotePublication,
  readRemoteArtwork,
  registerRemoteContainer,
} from '../src/comics/application/remote-library-service';
import { disconnectSource } from '../src/comics/application/source-lifecycle';
import {
  importContainer,
  listContainerReferences,
  releaseContainer,
} from '../src/storage/containers';
import * as containers from '../src/storage/containers';
import { prepareEntryContent } from '../src/comics/application/entry-content';
import {
  coverReference,
  openSourceCover,
  sourceCoverOwner,
} from '../src/comics/application/cover-access';
import { readThumbnail } from '../src/comics/application/image-access';
import { thumbnailCache } from '../src/storage/thumbnails';
import { downloadStore } from '../src/storage/downloads';
import { acquirePage } from '../src/comics/pages/service';
import {
  pageRenderProfile,
  parsePageReference,
  PDF_RENDER_PROFILE,
} from '../src/comics/pages/identity';
import * as pageIdentity from '../src/comics/pages/identity';
import { localSourceDriver } from '../src/comics/sources/local/driver';
import * as formats from '../src/comics/formats';
import type { EpubIndex } from '../src/comics/formats/contracts';
import { loadEntry, saveReaderState } from '../src/comics/application/library-service';

vi.mock('../src/comics/formats', () => ({
  indexFile: async () => ({
    kind: 'images',
    pages: [{ ordinal: 0, name: 'page.png', locator: { entryIndex: 0 } }],
  }),
  openDocument: async () => ({
    index: async () => [{ ordinal: 0, name: 'page.png', locator: { entryIndex: 0 } }],
    materialize: async () => new Blob(['original'], { type: 'image/png' }),
    close: async () => {},
  }),
}));
vi.mock('../src/comics/pages/normalize', () => ({
  prepareComicPage: async ({ blob }: { blob: Blob }) => ({
    blob,
    width: 1,
    height: 1,
    imageSha256: 'a'.repeat(64),
  }),
}));
const stops: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const stop of stops.splice(0)) stop();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(kind: RemoteReadingPlan['kind'] = 'pages') {
  const providerId = 'fixture-' + crypto.randomUUID(),
    connectionId = crypto.randomUUID(),
    publicationId = crypto.randomUUID();
  const account: SourceAccount = {
    id: connectionId,
    provider: providerId,
    displayName: 'Private library',
    status: 'connected',
  };
  const plan: RemoteReadingPlan = {
    publication: { id: publicationId, title: 'Book' },
    kind,
    representationId: 'content-1',
    format: kind === 'pages' ? 'image-sequence' : 'cbz',
    locator: { publicationId, representationId: 'content-1' },
    snapshot: { version: 'v1', representationId: 'content-1' },
  };
  const index = vi.fn(async () => ({
    pages: [
      {
        ordinal: 0,
        name: 'Page 1',
        locator: { sourceId: 'slot-0', contentKey: 'v1:0', ordinal: 0 },
      },
    ],
    complete: true,
    total: 1,
  }));
  const read = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
  const resolve = vi.fn(async () => plan),
    open = vi.fn<NonNullable<SourceProvider['files']>['open']>(async () => {
      throw Error('A retained container should not use network.');
    });
  const provider: SourceProvider = {
    id: providerId,
    label: 'Fixture library',
    cachePages: true,
    cacheRanges: true,
    connection: {
      connect: async () => account,
      list: async () => [account],
      disconnect: async () => {},
    },
    catalog: {
      browse: async () => ({
        title: 'Books',
        location: 'root',
        navigation: [],
        publications: [plan.publication],
      }),
      resolve,
    },
    pages: { index, read },
    files: { open },
  };
  stops.push(registerSourceDriver(provider));
  return {
    provider,
    plan,
    index,
    read,
    resolve,
    open,
    connectionId,
    publicationId,
    connect: (existing = false) =>
      connectRemoteLibrary(providerId, {}, existing ? connectionId : undefined),
  };
}
const comicsFor = (id: string) => catalog.list('comics', { index: 'connectionId', range: id });
function thumbnailEncoder() {
  const encode = vi.fn(async () => new Blob(['thumbnail']));
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 240, height: 360, close() {} })),
  );
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { drawImage() {} };
      }
      convertToBlob() {
        return encode();
      }
    },
  );
  return encode;
}

describe('remote library capability integration', () => {
  it('connects and browses without importing the remote catalog', async () => {
    const f = fixture();
    await f.connect();
    const page = await browseRemoteLibrary(f.connectionId);
    expect(page.publications).toHaveLength(1);
    expect(await comicsFor(f.connectionId)).toEqual([]);
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it('isolates equal publication and artwork IDs across multiple providers and connections', async () => {
    const connectionIds: string[] = [],
      providerIds: string[] = [],
      publicationId = 'shared-publication',
      artwork = { id: 'shared-artwork', locator: { asset: 'cover' } };
    const fileOnlyList = vi.fn(async () => {
      throw Error('File-only account initialization must not run.');
    });
    stops.push(
      registerSourceDriver({
        id: 'file-only-' + crypto.randomUUID(),
        label: 'File only',
        cachePages: false,
        cacheRanges: false,
        connection: { list: fileOnlyList },
      }),
    );
    for (let index = 0; index < 2; index++) {
      const id = 'remote-' + crypto.randomUUID(),
        accounts: SourceAccount[] = [0, 1].map((n) => ({
          id: id + ':' + n,
          provider: id,
          displayName: 'Library ' + n,
          status: 'connected',
        }));
      const plan: RemoteReadingPlan = {
        publication: { id: publicationId, title: 'Same book', artwork },
        kind: 'pages',
        format: 'image-sequence',
        representationId: 'shared-representation',
        locator: { publicationId },
        snapshot: { version: 'same-version' },
      };
      const provider: SourceProvider = {
        id,
        label: 'Remote ' + index,
        cachePages: true,
        cacheRanges: false,
        connection: {
          connect: async (values) => accounts.find((account) => account.id === values.id)!,
          list: async () => accounts,
          disconnect: async () => {},
        },
        catalog: {
          browse: async ({ connection }) => ({
            title: connection.id,
            location: 'root',
            navigation: [],
            publications: [plan.publication],
          }),
          resolve: async () => plan,
        },
        pages: {
          index: async () => ({
            complete: true,
            total: 1,
            pages: [
              {
                ordinal: 0,
                name: 'Page',
                locator: { sourceId: 'page', contentKey: 'shared-page' },
              },
            ],
          }),
          read: async (context) => new Blob([context.connection.id], { type: 'image/png' }),
        },
        artwork: { read: async (connection) => new Blob([connection.id], { type: 'image/png' }) },
      };
      stops.push(registerSourceDriver(provider));
      providerIds.push(id);
      for (const account of accounts) {
        await connectRemoteLibrary(id, { id: account.id });
        connectionIds.push(account.id);
      }
    }
    expect(listRemoteProviders().map((provider) => provider.id)).toEqual(
      expect.arrayContaining(providerIds),
    );
    const libraries = await listRemoteLibraries();
    expect(
      libraries.connections.filter((connection) => connectionIds.includes(connection.id)),
    ).toHaveLength(4);
    expect(fileOnlyList).not.toHaveBeenCalled();
    expect(libraries.errors).toEqual([]);
    const comicIds: string[] = [],
      entryIds: string[] = [],
      covers: string[] = [];
    for (const connectionId of connectionIds) {
      expect((await browseRemoteLibrary(connectionId)).title).toBe(connectionId);
      expect(await (await readRemoteArtwork(connectionId, artwork)).text()).toBe(connectionId);
      const result = await openRemotePublication(connectionId, publicationId);
      if (result.kind !== 'opened') throw Error('Expected a reading entry.');
      const entry = (await catalog.get('entries', result.entryId))!,
        comic = (await catalog.get('comics', result.comicId))!,
        page = (await catalog.listPages(entry.contentId))[0];
      comicIds.push(comic.id);
      entryIds.push(entry.id);
      covers.push(coverReference(comic)!);
      const cover = (await openSourceCover(covers.at(-1)!))!;
      await cover.validate();
      expect(await (await cover.read()).text()).toBe(connectionId);
      const lease = await acquirePage({
        entryId: entry.id,
        contentId: entry.contentId,
        pageId: page.pageId,
        renderProfileId: pageRenderProfile(entry.format),
      });
      try {
        expect(await lease.blob.text()).toBe(connectionId);
      } finally {
        lease.release();
      }
    }
    expect(new Set(comicIds).size).toBe(4);
    expect(new Set(entryIds).size).toBe(4);
    expect(new Set(covers).size).toBe(4);
    await disconnectSource(connectionIds[0]);
    await expect(openSourceCover(covers[0])).rejects.toThrow('变化');
    expect(await (await readRemoteArtwork(connectionIds[1], artwork)).text()).toBe(
      connectionIds[1],
    );
  });

  it('shares preparation, registers once, and resumes the same local reading position', async () => {
    const f = fixture();
    await f.connect();
    const [one, two] = await Promise.all([
      openRemotePublication(f.connectionId, f.publicationId),
      openRemotePublication(f.connectionId, f.publicationId),
    ]);
    expect(one.kind).toBe('opened');
    expect(two).toEqual(one);
    expect(f.index).toHaveBeenCalledOnce();
    if (one.kind !== 'opened') throw Error('Expected a reading entry.');
    const entry = (await catalog.get('entries', one.entryId))!,
      pages = await catalog.listPages(entry.contentId);
    await catalog.savePosition({
      id: entry.id,
      comicId: entry.comicId,
      entryId: entry.id,
      contentId: entry.contentId,
      pageId: pages[0].pageId,
      relativeOffset: 0.4,
      updatedAt: 100,
    });
    const reopened = await openRemotePublication(f.connectionId, f.publicationId);
    expect(reopened).toEqual({
      kind: 'opened',
      comicId: one.comicId,
      entryId: one.entryId,
      created: false,
    });
    expect((await catalog.get('positions', entry.id))?.relativeOffset).toBe(0.4);
    expect(f.index).toHaveBeenCalledOnce();
    await prepareEntryContent(entry.id);
    expect(f.index).toHaveBeenCalledOnce();
  });

  it('cancels one caller without cancelling another subscriber', async () => {
    const f = fixture(),
      gate = deferred<void>();
    await f.connect();
    const original = f.index.getMockImplementation()!;
    f.index.mockImplementation(async () => {
      await gate.promise;
      return original();
    });
    const controller = new AbortController(),
      first = openRemotePublication(f.connectionId, f.publicationId, controller.signal);
    const second = openRemotePublication(f.connectionId, f.publicationId);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve();
    expect((await second).kind).toBe('opened');
    expect(await comicsFor(f.connectionId)).toHaveLength(1);
  });

  it('reuses retained inventory only for the current complete content', async () => {
    const f = fixture();
    await f.connect();
    const result = await openRemotePublication(f.connectionId, f.publicationId);
    if (result.kind !== 'opened') throw Error('Expected a reading entry.');
    const entry = (await catalog.get('entries', result.entryId))!;
    await catalog.patch('entries', entry.id, { sourceRemoved: true });
    const inventory = vi.spyOn(downloadStore, 'inventory');
    try {
      const retainedPages = { contentId: entry.contentId, count: 1 };
      await prepareEntryContent(entry.id, undefined, { refreshResources: true, retainedPages });
      expect(inventory).not.toHaveBeenCalled();
      await catalog.patch('entries', entry.id, { knownTotal: 2 });
      await expect(
        prepareEntryContent(entry.id, undefined, { refreshResources: true, retainedPages }),
      ).rejects.toThrow('暂不可读');
      expect(inventory).not.toHaveBeenCalled();
      await catalog.patch('entries', entry.id, { knownTotal: 1 });
      await expect(
        prepareEntryContent(entry.id, undefined, {
          refreshResources: true,
          retainedPages: { contentId: 'older-content', count: 1 },
        }),
      ).rejects.toThrow('暂不可读');
      expect(inventory).toHaveBeenCalledOnce();
    } finally {
      inventory.mockRestore();
    }
  });

  it('rejects a late index after disconnect and leaves no empty comic', async () => {
    const f = fixture(),
      gate = deferred<void>(),
      started = deferred<void>();
    await f.connect();
    const original = f.index.getMockImplementation()!;
    f.index.mockImplementation(async () => {
      started.resolve();
      await gate.promise;
      return original();
    });
    const opening = openRemotePublication(f.connectionId, f.publicationId);
    await started.promise;
    await disconnectSource(f.connectionId);
    gate.resolve();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(await comicsFor(f.connectionId)).toEqual([]);
  });

  it('rejects cross-tab preparation begun before deletion but permits a new explicit open', async () => {
    const f = fixture(),
      gate = deferred<void>(),
      started = deferred<void>();
    await f.connect();
    const original = f.index.getMockImplementation()!;
    f.index.mockImplementation(async () => {
      started.resolve();
      await gate.promise;
      return original();
    });
    const opening = openRemotePublication(f.connectionId, f.publicationId);
    await started.promise;
    // Another tab finished first, then the user deleted that newly opened book.
    const id = crypto.randomUUID(),
      now = Date.now();
    await catalog.put('comics', {
      id,
      sourceKey: JSON.stringify([f.connectionId, f.publicationId]),
      title: 'Book',
      sourceName: 'Fixture',
      createdAt: now,
      updatedAt: now,
      source: {
        connectionId: f.connectionId,
        providerItemId: f.publicationId,
        locator: f.plan.locator,
        status: 'active',
        generation: 1,
      },
    });
    await catalog.deleteComic(id);
    gate.resolve();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(await comicsFor(f.connectionId)).toEqual([]);
    const fresh = await openRemotePublication(f.connectionId, f.publicationId);
    expect(fresh.kind).toBe('opened');
    expect(await comicsFor(f.connectionId)).toHaveLength(1);
  });

  it('reconnects the same library without recreating a book or its saved position', async () => {
    const f = fixture();
    await f.connect();
    const first = await openRemotePublication(f.connectionId, f.publicationId);
    if (first.kind !== 'opened') throw Error('Expected a reading entry.');
    const entry = (await catalog.get('entries', first.entryId))!,
      page = (await catalog.listPages(entry.contentId))[0];
    await catalog.savePosition({
      id: entry.id,
      comicId: entry.comicId,
      entryId: entry.id,
      contentId: entry.contentId,
      pageId: page.pageId,
      relativeOffset: 0.6,
      updatedAt: 100,
    });
    await disconnectSource(f.connectionId);
    await expect(openRemotePublication(f.connectionId, f.publicationId)).rejects.toThrow('断开');
    await f.connect(true);
    expect(await openRemotePublication(f.connectionId, f.publicationId)).toEqual({
      kind: 'opened',
      comicId: first.comicId,
      entryId: first.entryId,
      created: false,
    });
    expect((await catalog.get('positions', entry.id))?.relativeOffset).toBe(0.6);
    expect(f.index).toHaveBeenCalledOnce();
  });

  it('does not let a late reconnect override a newer disconnect', async () => {
    const f = fixture(),
      connection = await f.connect(),
      started = deferred<void>(),
      gate = deferred<void>();
    const connect = f.provider.connection!.connect!;
    f.provider.connection!.connect = async (...args) => {
      started.resolve();
      await gate.promise;
      return connect(...args);
    };
    const reconnect = f.connect(true);
    await started.promise;
    await disconnectSource(connection.id);
    gate.resolve();
    await expect(reconnect).rejects.toMatchObject({ name: 'AbortError' });
    expect((await catalog.get('connections', connection.id))?.status).toBe('disconnected');
  });

  it('atomically reloads pages and starts fresh even when a feed keeps its old page identities', async () => {
    const f = fixture();
    await f.connect();
    const opened = await openRemotePublication(f.connectionId, f.publicationId);
    if (opened.kind !== 'opened') throw Error('Expected a reading entry.');
    const previous = (await catalog.get('entries', opened.entryId))!,
      page = (await catalog.listPages(previous.contentId))[0];
    await catalog.savePosition({
      id: previous.id,
      comicId: previous.comicId,
      entryId: previous.id,
      contentId: previous.contentId,
      pageId: page.pageId,
      relativeOffset: 0.6,
      updatedAt: 100,
    });
    const nextPlan: RemoteReadingPlan = {
      ...f.plan,
      representationId: 'content-2',
      locator: { publicationId: f.publicationId, representationId: 'content-2' },
      snapshot: { version: 'v2', representationId: 'content-2' },
    };
    f.resolve.mockResolvedValue(nextPlan);
    f.index.mockResolvedValue({
      complete: true,
      total: 2,
      pages: [0, 1].map((ordinal) => ({
        ordinal,
        name: 'Page ' + ordinal,
        locator: { sourceId: 'slot-' + ordinal, contentKey: 'v2:' + ordinal, ordinal },
      })),
    });
    await prepareEntryContent(previous.id, undefined, { reload: true });
    const refreshed = (await catalog.get('entries', previous.id))!,
      comic = (await catalog.get('comics', previous.comicId))!,
      pages = await catalog.listPages(refreshed.contentId);
    expect(refreshed.contentId).not.toBe(previous.contentId);
    expect(refreshed.sourceSnapshot).toEqual(nextPlan.snapshot);
    expect(refreshed.acquisition?.representationId).toBe('content-2');
    expect(comic.source.locator).toEqual(nextPlan.locator);
    expect(pages).toHaveLength(2);
    expect(await catalog.listPages(previous.contentId)).toEqual([]);
    expect(await catalog.get('positions', previous.id)).toMatchObject({
      contentId: refreshed.contentId,
      pageId: pages[0].pageId,
      relativeOffset: 0,
    });
    await catalog.savePosition({
      id: previous.id,
      comicId: previous.comicId,
      entryId: previous.id,
      contentId: refreshed.contentId,
      pageId: pages[1].pageId,
      relativeOffset: 0.8,
      updatedAt: 200,
    });
    await prepareEntryContent(previous.id, undefined, { reload: true });
    const reloaded = (await catalog.get('entries', previous.id))!;
    expect(reloaded.contentId).not.toBe(refreshed.contentId);
    expect(await catalog.listPages(refreshed.contentId)).toEqual([]);
    expect(await catalog.get('positions', previous.id)).toMatchObject({
      contentId: reloaded.contentId,
      pageId: pages[0].pageId,
      relativeOffset: 0,
    });
    expect(f.resolve).toHaveBeenCalledTimes(3);
  });

  it.each(['pages', 'range-file'] as const)(
    'refreshes a %s cover with an unchanged artwork ID and evicts its old dedicated thumbnail',
    async (kind) => {
      const f = fixture(kind),
        encode = thumbnailEncoder(),
        read = vi.fn(async () => new Blob(['source cover']));
      f.open.mockImplementation(async (context) => ({
        snapshot: {
          identity: f.publicationId,
          version: String(context.sourceSnapshot?.version),
          size: 100,
          local: false,
        },
        readAt: async (_offset, length) => new Uint8Array(length),
        validate: async () => 'unchanged',
        close: async () => {},
      }));
      f.plan.publication.artwork = { id: 'unchanged-artwork', locator: { resourceId: 'same' } };
      f.provider.artwork = { read };
      encode
        .mockResolvedValueOnce(new Blob(['old thumbnail']))
        .mockResolvedValueOnce(new Blob(['new thumbnail']));
      await f.connect();
      const opened = await openRemotePublication(f.connectionId, f.publicationId);
      if (opened.kind !== 'opened') throw Error('Expected a reading entry.');
      const comic = (await catalog.get('comics', opened.comicId))!,
        key = coverReference(comic)!;
      expect(await (await readThumbnail(key)).text()).toBe('old thumbnail');
      await readThumbnail(key);
      expect(read).toHaveBeenCalledTimes(1);
      expect(await thumbnailCache.get(key)).toBeInstanceOf(Blob);
      await prepareEntryContent(opened.entryId, undefined, { reload: true });
      const refreshed = (await catalog.get('comics', comic.id))!,
        nextKey = coverReference(refreshed)!;
      expect(refreshed.sourceArtwork?.id).toBe(comic.sourceArtwork?.id);
      expect(nextKey).not.toBe(key);
      expect(await thumbnailCache.get(key)).toBeUndefined();
      expect(await thumbnailCache.inventory([sourceCoverOwner(comic.id)])).toEqual([]);
      await expect(readThumbnail(key)).rejects.toThrow('来源已变化');
      expect(await (await readThumbnail(nextKey)).text()).toBe('new thumbnail');
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  it('rejects a provider thumbnail encoding completed after the source generation was reloaded', async () => {
    const f = fixture(),
      encode = thumbnailEncoder(),
      started = deferred<void>(),
      encoded = deferred<Blob>();
    f.plan.publication.artwork = { id: 'unchanged-artwork', locator: { resourceId: 'same' } };
    f.provider.artwork = { read: async () => new Blob(['old source cover']) };
    encode.mockImplementationOnce(() => {
      started.resolve();
      return encoded.promise;
    });
    await f.connect();
    const opened = await openRemotePublication(f.connectionId, f.publicationId);
    if (opened.kind !== 'opened') throw Error('Expected a reading entry.');
    const key = coverReference((await catalog.get('comics', opened.comicId))!)!;
    const loading = readThumbnail(key);
    void loading.catch(() => {});
    await started.promise;
    await prepareEntryContent(opened.entryId, undefined, { reload: true });
    encoded.resolve(new Blob(['late old thumbnail']));
    await expect(loading).rejects.toThrow('来源已变化');
    expect(await thumbnailCache.get(key)).toBeUndefined();
    const nextKey = coverReference((await catalog.get('comics', opened.comicId))!)!;
    expect(nextKey).not.toBe(key);
    expect(await thumbnailCache.get(nextKey)).toBeUndefined();
    await expect(readThumbnail(nextKey)).resolves.toBeInstanceOf(Blob);
  });

  it('reloads Range-file metadata without silently downloading a whole-file representation', async () => {
    const f = fixture('range-file');
    f.open.mockImplementation(async (context) => ({
      snapshot: {
        identity: f.publicationId,
        version: String(context.sourceSnapshot?.version),
        size: 100,
        local: false,
      },
      readAt: async (_offset, length) => new Uint8Array(length),
      validate: async () => 'unchanged',
      close: async () => {},
    }));
    await f.connect();
    const opened = await openRemotePublication(f.connectionId, f.publicationId);
    if (opened.kind !== 'opened') throw Error('Expected a reading entry.');
    const entry = (await catalog.get('entries', opened.entryId))!,
      changed: RemoteReadingPlan = {
        ...f.plan,
        representationId: 'range-v2',
        locator: { publicationId: f.publicationId, representationId: 'range-v2' },
        snapshot: { version: 'range-v2' },
      };
    const page = (await catalog.listPages(entry.contentId))[0];
    await catalog.savePosition({
      id: entry.id,
      comicId: entry.comicId,
      entryId: entry.id,
      contentId: entry.contentId,
      pageId: page.pageId,
      relativeOffset: 0.5,
      updatedAt: 100,
    });
    await prepareEntryContent(entry.id, undefined, { reload: true });
    expect((await catalog.get('entries', entry.id))?.contentId).toBe(entry.contentId);
    expect((await catalog.get('positions', entry.id))?.relativeOffset).toBe(0.5);
    f.resolve.mockResolvedValue(changed);
    await prepareEntryContent(entry.id, undefined, { reload: true });
    expect((await catalog.get('entries', entry.id))?.sourceSnapshot).toEqual(changed.snapshot);
    expect(f.open).toHaveBeenCalledTimes(3);
    f.resolve.mockResolvedValue({
      ...changed,
      kind: 'download-file',
      representationId: 'file-v3',
      snapshot: { version: 'file-v3' },
    });
    await expect(prepareEntryContent(entry.id, undefined, { reload: true })).rejects.toMatchObject({
      kind: 'download-required',
      reason: 'source-changed',
    });
    expect((await catalog.get('entries', entry.id))?.sourceSnapshot).toEqual(changed.snapshot);
    expect(f.open).toHaveBeenCalledTimes(3);
  });

  it.each(['abort', 'delete', 'disconnect'] as const)(
    'does not publish a reload after %s',
    async (action) => {
      const f = fixture();
      await f.connect();
      const opened = await openRemotePublication(f.connectionId, f.publicationId);
      if (opened.kind !== 'opened') throw Error('Expected a reading entry.');
      const before = (await catalog.get('entries', opened.entryId))!,
        gate = deferred<void>(),
        started = deferred<void>(),
        controller = new AbortController(),
        index = f.index.getMockImplementation()!;
      f.resolve.mockResolvedValue({
        ...f.plan,
        representationId: 'new',
        snapshot: { version: 'new' },
      });
      f.index.mockImplementation(async () => {
        started.resolve();
        await gate.promise;
        return index();
      });
      const reloading = prepareEntryContent(before.id, controller.signal, { reload: true });
      await started.promise;
      if (action === 'abort') controller.abort();
      else if (action === 'delete') await catalog.deleteComic(before.comicId);
      else await disconnectSource(f.connectionId);
      gate.resolve();
      await expect(reloading).rejects.toMatchObject({ name: 'AbortError' });
      const after = await catalog.get('entries', before.id);
      if (action === 'delete') expect(after).toBeUndefined();
      else expect(after?.contentId).toBe(before.contentId);
    },
  );

  it.each([1, 1501])('keeps a %i-chapter EPUB and its saved position under its remote source identity', async (chapterCount) => {
    const f = fixture('download-file');
    f.plan.format = 'epub';
    const connection = await f.connect();
    const document: EpubIndex = {
      kind: 'epub',
      title: 'Remote document',
      chapters: Array.from({ length: chapterCount }, (_, index) => ({
        id: `chapter-${index + 1}`,
        href: index === 0 ? '/OPS/chapter.xhtml' : `/OPS/chapter-${index + 1}.xhtml`,
        label: `Chapter ${index + 1}`,
      })),
      toc: [{ href: '/OPS/chapter.xhtml', label: 'Chapter One' }],
    };
    let sourceClose: ReturnType<typeof vi.fn> | undefined;
    const index = vi.spyOn(formats, 'indexFile').mockImplementation(async (format, source) => {
      expect(format).toBe('epub');
      expect(source.snapshot.local).toBe(true);
      sourceClose = vi.spyOn(source, 'close');
      return document;
    });
    try {
      expect((await openRemotePublication(f.connectionId, f.publicationId)).kind).toBe(
        'download-required',
      );
      expect(await comicsFor(f.connectionId)).toEqual([]);
      const contentId = crypto.randomUUID();
      const container = await importContainer(
        new File(['PK', crypto.randomUUID()], 'book.epub'),
        undefined,
        undefined,
        contentId,
      );
      const imported = await registerRemoteContainer(
        { connection, plan: f.plan },
        container,
        contentId,
      );
      expect(index).toHaveBeenCalledOnce();
      expect(sourceClose).toHaveBeenCalledOnce();
      const comic = (await catalog.get('comics', imported.comicId))!;
      const entry = (await catalog.get('entries', imported.entryId))!;
      expect(comic.source).toMatchObject({
        connectionId: f.connectionId,
        providerItemId: f.publicationId,
      });
      expect(comic.cover).toBeUndefined();
      expect(entry).toMatchObject({
        format: 'epub',
        document,
        containerId: container.id,
        pageCount: 0,
      });
      expect(await catalog.listPages(contentId)).toEqual([]);
      const copy = await loadEntry(entry.id);
      const documentLocation = {
        cfi: 'epubcfi(/6/2!/4/2/1:24)',
        href: '/OPS/chapter.xhtml',
        progression: 0.45,
        totalProgression: 0.45,
      };
      await saveReaderState({ ...copy, documentLocation, lastReadAt: 300 });
      f.resolve.mockClear();
      await disconnectSource(f.connectionId);
      await f.connect(true);
      const reopened = await openRegisteredRemoteComic(comic.id);
      expect(reopened).toMatchObject({ kind: 'opened', entryId: entry.id, created: false });
      expect(await loadEntry(entry.id)).toMatchObject({
        document,
        documentLocation,
        pageId: '',
        pages: [],
      });
      expect(await catalog.get('positions', entry.id)).toMatchObject({
        contentId,
        documentLocation,
        pageId: '',
        relativeOffset: 0,
      });
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
      expect(index).toHaveBeenCalledOnce();
    } finally {
      index.mockRestore();
    }
  });

  it('keeps source identity while publishing a retained archive and an atomic completed intent', async () => {
    const f = fixture('download-file'),
      connection = await f.connect();
    expect((await openRemotePublication(f.connectionId, f.publicationId)).kind).toBe(
      'download-required',
    );
    expect(await comicsFor(f.connectionId)).toEqual([]);
    const contentId = crypto.randomUUID(),
      id = 'file-download:' + crypto.randomUUID(),
      container = await importContainer(
        new File(['PK', crypto.randomUUID()], 'book.cbz'),
        undefined,
        undefined,
        contentId,
      );
    await catalog.put('metadata', {
      id,
      status: 'running',
      generation: 1,
      connectionGeneration: connection.generation,
      contentId,
      importReferenceId: contentId,
    });
    const result = await registerRemoteContainer(
      { connection, plan: f.plan },
      container,
      contentId,
      undefined,
      { id, generation: 1 },
    );
    const comic = (await catalog.get('comics', result.comicId))!,
      entry = (await catalog.get('entries', result.entryId))!;
    expect(comic.source.connectionId).toBe(f.connectionId);
    expect(comic.source.providerItemId).toBe(f.publicationId);
    expect(entry.containerId).toBe(container.id);
    expect(await catalog.get('metadata', id)).toMatchObject({
      status: 'complete',
      comicId: comic.id,
      entryId: entry.id,
      contentId: entry.contentId,
      containerId: container.id,
      importReferenceId: contentId,
    });
    const source = await openFileSource({
      connection,
      source: comic.source,
      entryId: entry.id,
      contentId: entry.contentId,
      sourceSnapshot: entry.sourceSnapshot,
      format: entry.format,
      containerId: entry.containerId,
    });
    try {
      expect(source.snapshot.local).toBe(true);
      expect(new TextDecoder().decode(await source.readAt(0, 2))).toBe('PK');
    } finally {
      await source.close();
    }
    expect(f.open).not.toHaveBeenCalled();
    const resolvedBefore = f.resolve.mock.calls.length;
    expect(await openRegisteredRemoteComic(comic.id)).toEqual({
      kind: 'opened',
      comicId: comic.id,
      entryId: entry.id,
      created: false,
    });
    expect(f.resolve).toHaveBeenCalledTimes(resolvedBefore);
    await catalog.patch('entries', entry.id, { containerId: undefined });
    await releaseContainer(container.id, entry.contentId);
    expect((await openRegisteredRemoteComic(comic.id))?.kind).toBe('download-required');
    expect((await comicsFor(f.connectionId))[0].id).toBe(comic.id);
  });

  it('uses the current PDF render profile for an opaque remote file without dedicated artwork', async () => {
    const f = fixture('download-file');
    f.plan.format = 'pdf';
    const connection = await f.connect();
    const contentId = crypto.randomUUID();
    const container = await importContainer(
      new File(['%PDF-', crypto.randomUUID()], 'book.pdf'),
      undefined,
      undefined,
      contentId,
    );
    const result = await registerRemoteContainer(
      { connection, plan: f.plan },
      container,
      contentId,
    );
    const comic = (await catalog.get('comics', result.comicId))!;
    expect(comic.sourceArtwork).toBeUndefined();
    expect(comic.source.locator.name).toBeUndefined();
    expect(comic.cover).toMatchObject({ format: 'pdf' });
    expect(comic.cover).not.toHaveProperty('renderProfileId');
    const reference = parsePageReference(coverReference(comic)!)!;
    expect(reference.renderProfileId).toBe(PDF_RENDER_PROFILE);
    const page = await acquirePage(reference);
    try {
      expect(await page.blob.text()).toBe('original');
    } finally {
      page.release();
    }
    await prepareEntryContent(result.entryId, undefined, { reload: true });
    const refreshed = (await catalog.get('comics', comic.id))!;
    expect(refreshed.cover?.format).toBe('pdf');
    const changedProfile = pageIdentity.RENDER_PROFILE;
    const currentProfile = vi
      .spyOn(pageIdentity, 'pageRenderProfile')
      .mockReturnValue(changedProfile);
    try {
      expect(parsePageReference(coverReference(refreshed)!)?.renderProfileId).toBe(changedProfile);
    } finally {
      currentProfile.mockRestore();
    }
  });

  it('never rolls back a published container reference when temporary-reference cleanup fails', async () => {
    const f = fixture('download-file');
    const connection = await f.connect();
    const input = new File(['PK', crypto.randomUUID()], 'book.cbz');
    const originalContentId = crypto.randomUUID();
    const originalContainer = await importContainer(input, undefined, undefined, originalContentId);
    const original = await registerRemoteContainer(
      { connection, plan: f.plan },
      originalContainer,
      originalContentId,
    );
    const temporaryContentId = crypto.randomUUID();
    const candidate = await importContainer(input, undefined, undefined, temporaryContentId);
    const id = 'file-download:' + crypto.randomUUID();
    await catalog.put('metadata', {
      id,
      status: 'running',
      generation: 1,
      connectionGeneration: connection.generation,
      contentId: temporaryContentId,
      importReferenceId: temporaryContentId,
    });
    const release = vi
      .spyOn(containers, 'releaseContainer')
      .mockRejectedValueOnce(Error('Temporary cleanup failed'));
    try {
      await expect(
        registerRemoteContainer(
          { connection, plan: f.plan },
          candidate,
          temporaryContentId,
          undefined,
          { id, generation: 1 },
        ),
      ).rejects.toThrow('Temporary cleanup failed');
      expect(release).toHaveBeenCalledTimes(1);
      expect(await catalog.get('metadata', id)).toMatchObject({
        status: 'complete',
        contentId: original.contentId,
      });
      expect((await catalog.get('entries', original.entryId))?.containerId).toBe(candidate.id);
      expect(await listContainerReferences(original.contentId)).toHaveLength(1);
    } finally {
      release.mockRestore();
    }
    // Simulate completed-intent recovery releasing the remaining temporary owner.
    await releaseContainer(candidate.id, temporaryContentId);
    expect(await listContainerReferences(original.contentId)).toHaveLength(1);
    const retained = await containers.openContainer(candidate.id);
    await retained.close();
  });

  it('serializes final container ownership without blocking another preparation index', async () => {
    const f = fixture('download-file');
    const connection = await f.connect();
    const input = new File(['PK', crypto.randomUUID()], 'book.cbz');
    const firstContentId = crypto.randomUUID();
    const secondContentId = crypto.randomUUID();
    const first = await importContainer(input, undefined, undefined, firstContentId);
    const second = await importContainer(input, undefined, undefined, secondContentId);
    const retaining = deferred<void>();
    const proceed = deferred<void>();
    const indexed = deferred<void>();
    const retainContainer = containers.retainContainer;
    const indexFile = formats.indexFile;
    let indexes = 0;
    const index = vi.spyOn(formats, 'indexFile').mockImplementation(async (...args) => {
      const result = await indexFile(...args);
      if (++indexes === 2) indexed.resolve();
      return result;
    });
    const retain = vi.spyOn(containers, 'retainContainer').mockImplementation(async (id, owner) => {
      if (owner === firstContentId) {
        retaining.resolve();
        await proceed.promise;
      }
      await retainContainer(id, owner);
    });
    const one = registerRemoteContainer({ connection, plan: f.plan }, first, firstContentId);
    let two: typeof one | undefined;
    try {
      await retaining.promise;
      two = registerRemoteContainer({ connection, plan: f.plan }, second, secondContentId);
      await indexed.promise;
      // The expensive index is finished, but it cannot choose an owner before the first publish.
      expect(retain).toHaveBeenCalledTimes(1);
      proceed.resolve();
      const [created, reused] = await Promise.all([one, two]);
      expect(reused.entryId).toBe(created.entryId);
      expect(reused.contentId).toBe(firstContentId);
      expect(retain.mock.calls.map(([, owner]) => owner)).toEqual([firstContentId, firstContentId]);
      expect(await comicsFor(f.connectionId)).toHaveLength(1);
      expect(await listContainerReferences(firstContentId)).toHaveLength(1);
      expect(await listContainerReferences(secondContentId)).toEqual([]);
    } finally {
      proceed.resolve();
      await Promise.allSettled(two ? [one, two] : [one]);
      retain.mockRestore();
      index.mockRestore();
    }
  });

  it.each(['abort', 'delete', 'disconnect'] as const)(
    'releases an uncommitted final owner after %s during retain',
    async (action) => {
      const f = fixture('download-file');
      const connection = await f.connect();
      const originalContentId = crypto.randomUUID();
      const originalContainer = await importContainer(
        new File(['PK', crypto.randomUUID()], 'book.cbz'),
        undefined,
        undefined,
        originalContentId,
      );
      const original = await registerRemoteContainer(
        { connection, plan: f.plan },
        originalContainer,
        originalContentId,
      );
      const temporaryContentId = crypto.randomUUID();
      const candidate = await importContainer(
        new File(['PK', crypto.randomUUID()], 'book.cbz'),
        undefined,
        undefined,
        temporaryContentId,
      );
      const controller = new AbortController();
      const id = 'file-download:' + crypto.randomUUID();
      await catalog.put('metadata', {
        id,
        status: 'running',
        generation: 1,
        connectionGeneration: connection.generation,
        contentId: temporaryContentId,
        importReferenceId: temporaryContentId,
        comicId: original.comicId,
        sourceGeneration: 1,
      });
      const retainContainer = containers.retainContainer;
      const retain = vi
        .spyOn(containers, 'retainContainer')
        .mockImplementationOnce(async (...args) => {
          await retainContainer(...args);
          if (action === 'abort') controller.abort();
          else if (action === 'delete') await catalog.deleteComic(original.comicId);
          else await disconnectSource(connection.id);
        });
      try {
        await expect(
          registerRemoteContainer(
            { connection, plan: f.plan },
            candidate,
            temporaryContentId,
            controller.signal,
            { id, generation: 1 },
          ),
        ).rejects.toMatchObject({ name: 'AbortError' });
        const references = await listContainerReferences(original.contentId);
        expect(references.some((reference) => reference.id === candidate.id)).toBe(false);
        expect(await listContainerReferences(temporaryContentId)).toHaveLength(1);
        expect((await catalog.get('metadata', id))?.status).not.toBe('complete');
        if (action !== 'delete')
          expect((await catalog.get('entries', original.entryId))?.containerId).toBe(
            originalContainer.id,
          );
      } finally {
        retain.mockRestore();
        await releaseContainer(candidate.id, temporaryContentId);
      }
    },
  );

  it('leaves registered local files on their ordinary shelf opening path', async () => {
    stops.push(registerSourceDriver(localSourceDriver));
    const id = crypto.randomUUID(),
      now = Date.now();
    await catalog.put('connections', {
      id: 'local',
      provider: 'local',
      displayName: 'Local files',
      status: 'connected',
      generation: 1,
      createdAt: now,
      updatedAt: now,
    });
    await catalog.put('comics', {
      id,
      sourceKey: JSON.stringify(['local', id]),
      source: {
        connectionId: 'local',
        providerItemId: id,
        locator: {},
        generation: 1,
        status: 'active',
      },
      title: 'Local book',
      sourceName: 'Local files',
      createdAt: now,
      updatedAt: now,
    });
    expect(await openRegisteredRemoteComic(id)).toBeUndefined();
  });

  it('does not publish a file after its intent was cancelled', async () => {
    const f = fixture('download-file'),
      connection = await f.connect(),
      contentId = crypto.randomUUID(),
      id = 'cancelled:' + crypto.randomUUID();
    const container = await importContainer(
      new File(['PK', crypto.randomUUID()], 'book.cbz'),
      undefined,
      undefined,
      contentId,
    );
    await catalog.put('metadata', {
      id,
      status: 'paused',
      generation: 2,
      connectionGeneration: connection.generation,
      contentId,
    });
    await expect(
      registerRemoteContainer({ connection, plan: f.plan }, container, contentId, undefined, {
        id,
        generation: 1,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await comicsFor(f.connectionId)).toEqual([]);
    await releaseContainer(container.id, contentId);
  });

  it('preserves an existing entry identity and transfers the temporary archive reference', async () => {
    const f = fixture('download-file'),
      connection = await f.connect();
    const bytes = new File(['PK', crypto.randomUUID()], 'book.cbz'),
      firstContent = crypto.randomUUID();
    const first = await importContainer(bytes, undefined, undefined, firstContent),
      one = await registerRemoteContainer({ connection, plan: f.plan }, first, firstContent);
    const entry = (await catalog.get('entries', one.entryId))!,
      page = (await catalog.listPages(entry.contentId))[0];
    await catalog.savePosition({
      id: entry.id,
      comicId: entry.comicId,
      entryId: entry.id,
      contentId: entry.contentId,
      pageId: page.pageId,
      relativeOffset: 0.7,
      updatedAt: 100,
    });
    const temporary = crypto.randomUUID(),
      second = await importContainer(bytes, undefined, undefined, temporary);
    const result = await registerRemoteContainer({ connection, plan: f.plan }, second, temporary);
    expect(result.entryId).toBe(entry.id);
    expect(result.contentId).toBe(entry.contentId);
    expect((await catalog.get('positions', entry.id))?.relativeOffset).toBe(0.7);
    expect(await listContainerReferences(temporary)).toEqual([]);
    expect(await listContainerReferences(entry.contentId)).toHaveLength(1);
  });
});
