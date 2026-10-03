import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/index-native.js';
import { catalog } from '../src/comics/repositories';
import type { CatalogTable, Comic, Entry, SourceConnection } from '../src/comics/domain';
import type { EpubIndex, RandomAccessSource } from '../src/comics/formats/contracts';
import { openEpubArchive } from '../src/comics/formats/epub/archive';
import { entrySource } from '../src/comics/application/entry-source';
import { openEpubEntry, loadEpubImagePages } from '../src/comics/application/epub-service';
import {saveReaderState, loadEntry} from '../src/comics/application/library-service';
import {RENDER_PROFILE} from '../src/comics/pages/identity';
import {epubImageId} from '../src/comics/domain/epub-images';
import {
  coverReference,
  openSourceCover,
  sourceCoverOwner,
} from '../src/comics/application/cover-access';

const mocks = vi.hoisted(() => ({ openSource: vi.fn(), openDocument: vi.fn() }));
vi.mock('../src/comics/sources/runtime', () => ({ openFileSource: mocks.openSource }));
vi.mock('../src/comics/formats/epub', () => ({ openEpub: mocks.openDocument }));
vi.mock('../src/sources', () => ({ readSourceCover: vi.fn() }));
vi.mock('../src/comics/formats/epub/archive', async (original) => {
  const actual = await original<typeof import('../src/comics/formats/epub/archive')>();
  return {
    ...actual,
    openEpubArchive: vi.fn(async (...args: Parameters<typeof actual.openEpubArchive>) => {
      const archive = await actual.openEpubArchive(...args);
      vi.spyOn(archive, 'read');
      vi.spyOn(archive, 'close');
      return archive;
    }),
  };
});

const document: EpubIndex = {
  kind: 'epub',
  title: 'Retained document',
  chapters: [{ id: 'chapter-1', href: 'OPS/chapter.xhtml', label: 'One' }],
  toc: [],
  cover: { href: 'OPS/cover.png', mediaType: 'image/png' },
};
let bytes: Uint8Array<ArrayBuffer>;
let source: RandomAccessSource;
let closeDocument: ReturnType<typeof vi.fn>;
const fixtures: { comic: Comic; connection: SourceConnection }[] = [];

beforeAll(async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
  for (const [name, value] of Object.entries({
    mimetype: 'application/epub+zip',
    'OPS/cover.png': 'stored package cover',
    'OPS/chapter.xhtml': 'body must not be indexed or rasterized for its cover',
  })) {
    await writer.add(name, new BlobReader(new Blob([value])));
  }
  bytes = await writer.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  source = {
    snapshot: { identity: 'retained-epub', version: '1', size: bytes.length, local: true },
    readAt: vi.fn(async (offset, length, signal) => {
      signal?.throwIfAborted();
      return bytes.subarray(offset, offset + length);
    }),
    validate: vi.fn(async () => 'unchanged' as const),
    close: vi.fn(async () => {}),
  };
  closeDocument = vi.fn(async () => {});
  mocks.openSource.mockReset().mockResolvedValue(source);
  mocks.openDocument.mockReset().mockResolvedValue({
    index: document,
    close: closeDocument,
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Unexpected network request'); }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const { comic, connection } of fixtures.splice(0)) {
    await catalog.deleteComic(comic.id);
    await catalog.remove('connections', connection.id);
  }
});

async function fixture(index: EpubIndex = document) {
  const id = crypto.randomUUID();
  const connection: SourceConnection = {
    id: 'connection:' + id,
    provider: 'fixture',
    displayName: 'Document source',
    status: 'connected',
    generation: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const entry: Entry = {
    id: 'entry:' + id,
    comicId: id,
    title: index.title,
    order: 0,
    format: 'epub',
    document: index,
    containerId: 'container:' + id,
    contentId: 'content:' + id,
    generation: 1,
    indexState: 'ready',
    pageCount: 0,
    knownTotal: 0,
    discoveryComplete: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const comic: Comic = {
    id,
    title: index.title,
    sourceName: 'Document source',
    sourceKey: id,
    source: {
      connectionId: connection.id,
      providerItemId: 'publication:' + id,
      locator: {},
      generation: 1,
      status: 'active',
    },
    documentCover: { entryId: entry.id, contentId: entry.contentId },
    createdAt: 1,
    updatedAt: 1,
  };
  await catalog.put('connections', connection);
  await catalog.put('comics', comic);
  await catalog.put('entries', entry);
  fixtures.push({ comic, connection });
  return { comic, connection, entry };
}

/** Hold one completed database read to exercise cancellation across its await boundary. */
function pauseRead(table: CatalogTable, id: string, occurrence = 1) {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const get = catalog.get.bind(catalog);
  let matches = 0;
  vi.spyOn(catalog, 'get').mockImplementation(
    async <T extends CatalogTable>(name: T, key: IDBValidKey) => {
      const value = await get(name, key);
      if (name === table && key === id && ++matches === occurrence) {
        started.resolve();
        await released.promise;
      }
      return value;
    },
  );
  return { started: started.promise, release: () => released.resolve() };
}

describe('retained EPUB package covers', () => {
  it('reads the stored cover locator without indexing or fabricating image pages', async () => {
    const { comic, connection, entry } = await fixture();
    const cover = (await openSourceCover(coverReference(comic)!))!;
    expect(cover).toMatchObject({ owner: sourceCoverOwner(comic.id), connectionId: connection.id });
    expect(await (await cover.read())!.text()).toBe('stored package cover');
    const archive = await vi.mocked(openEpubArchive).mock.results[0].value;
    expect(archive.read).toHaveBeenCalledExactlyOnceWith('OPS/cover.png', 'image/png', undefined);
    expect(archive.close).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
    expect(mocks.openSource).toHaveBeenCalledWith(expect.objectContaining({
      entryId: entry.id,
      contentId: entry.contentId,
      containerId: entry.containerId,
    }));
    expect(mocks.openDocument).not.toHaveBeenCalled();
    expect(await catalog.listPages(entry.contentId)).toEqual([]);
    const materializations = await catalog.list('materializations', {
      index: 'contentId',
      range: entry.contentId,
    });
    expect(materializations).toEqual([]);
    expect((await catalog.get('comics', comic.id))?.cover).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['missing', 'svg'] as const)('does not open an unsupported %s cover', async (kind) => {
    const { comic } = await fixture({
      ...document,
      cover: kind === 'missing' ? undefined : { href: 'OPS/cover.svg', mediaType: 'image/svg+xml' },
    });
    expect(await openSourceCover(coverReference(comic)!)).toBeUndefined();
    expect(mocks.openSource).not.toHaveBeenCalled();
    expect(openEpubArchive).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://outside.test/cover.png',
    'file:///private/cover.png',
    'data:image/png,external',
  ])('never fetches an external cover locator %s', async (href) => {
    const { comic } = await fixture({ ...document, cover: { href, mediaType: 'image/png' } });
    const cover = (await openSourceCover(coverReference(comic)!))!;
    await expect(cover.read()).rejects.toThrow('缺少包内资源');
    const archive = await vi.mocked(openEpubArchive).mock.results[0].value;
    expect(archive.close).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'content', 'entry-generation', 'source-generation', 'connection-generation',
    'disconnect', 'revoke',
  ] as const)('rejects an already opened cover after %s changes', async (change) => {
    const { comic, connection, entry } = await fixture();
    const cover = (await openSourceCover(coverReference(comic)!))!;
    if (change === 'content') {
      await catalog.patch('entries', entry.id, { contentId: 'replacement' });
    }
    if (change === 'entry-generation') {
      await catalog.patch('entries', entry.id, { generation: 2 });
    }
    if (change === 'source-generation') {
      await catalog.patch('comics', comic.id, { source: { ...comic.source, generation: 2 } });
    }
    if (change === 'connection-generation') {
      await catalog.patch('connections', connection.id, { generation: 2 });
    }
    if (change === 'disconnect') {
      await catalog.patch('connections', connection.id, { status: 'disconnected' });
    }
    if (change === 'revoke') {
      await catalog.patch('comics', comic.id, { source: { ...comic.source, status: 'revoked' } });
    }
    await expect(cover.validate()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(cover.read()).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.openSource).not.toHaveBeenCalled();
  });

  it('rejects stale references before opening a source', async () => {
    const { comic, connection, entry } = await fixture();
    const key = coverReference(comic)!;
    await catalog.patch('comics', comic.id, { source: { ...comic.source, generation: 2 } });
    await expect(openSourceCover(key)).rejects.toThrow('封面来源已变化');
    await catalog.patch('comics', comic.id, {
      source: comic.source,
      documentCover: { entryId: entry.id, contentId: 'replacement' },
    });
    await expect(openSourceCover(key)).rejects.toThrow('封面来源已变化');
    await catalog.put('comics', comic);
    await catalog.patch('connections', connection.id, { status: 'disconnected' });
    await expect(openSourceCover(key)).rejects.toThrow('来源访问已断开');
    expect(mocks.openSource).not.toHaveBeenCalled();
  });

  it('discards a late cover after disconnect and still closes its source and archive', async () => {
    const { comic, connection } = await fixture();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<Blob>();
    const open = vi.mocked(openEpubArchive).getMockImplementation()!;
    vi.mocked(openEpubArchive).mockImplementationOnce(async (...args) => {
      const archive = await open(...args);
      vi.mocked(archive.read).mockImplementationOnce(() => {
        started.resolve();
        return released.promise;
      });
      return archive;
    });
    const cover = (await openSourceCover(coverReference(comic)!))!;
    const loading = cover.read();
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    await catalog.patch('connections', connection.id, { status: 'disconnected' });
    released.resolve(new Blob(['late cover']));
    await rejected;
    const archive = await vi.mocked(openEpubArchive).mock.results[0].value;
    expect(archive.close).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
  });
});

describe('EPUB source and document lifetime', () => {
  it('enriches old document indexes with image metadata without changing their identity or reading position', async () => {
    const {entry} = await fixture();
    await catalog.savePosition({id:entry.id,entryId:entry.id,comicId:entry.comicId,contentId:entry.contentId,pageId:'',relativeOffset:0,documentLocation:{href:'OPS/chapter.xhtml',progression:.4,totalProgression:.4},updatedAt:10});
    mocks.openDocument.mockResolvedValueOnce({index:{...document,images:[{href:'OPS/cover.png',mediaType:'image/png'}]},close:closeDocument});
    const session = await openEpubEntry(entry.id, entry.contentId);
    expect(await catalog.get('entries',entry.id)).toMatchObject({contentId:entry.contentId,generation:entry.generation,document:{images:[{href:'OPS/cover.png',mediaType:'image/png'}]}});
    expect((await loadEntry(entry.id)).documentLocation?.progression).toBe(.4);
    await session.close();
  });

  it('recovers scoped artwork jobs in a four-image window while persisting only the document location', async () => {
    const images = Array.from({length:6},(_,i)=>({href:`OPS/${i}.png`,mediaType:'image/png'}));
    const {entry} = await fixture({...document,images});
    const pageId = epubImageId(images[0].href), id = JSON.stringify([entry.contentId,pageId,RENDER_PROFILE]);
    expect(await catalog.putMaterialization({id,pageId,contentId:entry.contentId,renderProfileId:RENDER_PROFILE,imageSha256:'a'.repeat(64),width:240,height:360,byteSize:30,mime:'image/png',updatedAt:1},entry.generation)).toBe(true);
    expect(await catalog.putMaterialization({id:'forged',pageId:epubImageId('OPS/chapter.xhtml'),contentId:entry.contentId,renderProfileId:RENDER_PROFILE,imageSha256:'b'.repeat(64),width:240,height:360,byteSize:30,mime:'image/png',updatedAt:1},entry.generation)).toBe(false);
    const pages = await loadEpubImagePages(entry.id,entry.contentId,images.map(image=>image.href),'account-a');
    expect(pages).toHaveLength(4);
    expect(pages[0]).toMatchObject({id:pageId,imageSha256:'a'.repeat(64)});
    const job = {id:'artwork-job',mode:'classic' as const,target_language:'en',status:'succeeded' as const,phase:'done',quota_pages:0,created_at:'2026-01-01',version:1,cache_hit:false};
    const copy = {...await loadEntry(entry.id),pages:[{...pages[0],translationScope:'account-a',jobs:[job]}],documentLocation:{href:'OPS/chapter.xhtml',progression:.6,totalProgression:.6},lastReadAt:20};
    await saveReaderState(copy);
    const recovered = await loadEpubImagePages(entry.id,entry.contentId,[images[0].href],'account-a');
    expect(recovered[0].jobs).toEqual([job]);
    expect((await loadEpubImagePages(entry.id,entry.contentId,[images[0].href],'account-b'))[0].jobs).toEqual([]);
    expect(await catalog.listPages(entry.contentId)).toEqual([]);
    const resumed = await loadEntry(entry.id);
    expect(resumed.pages).toEqual([]);
    expect(resumed.documentLocation?.progression).toBe(.6);
    await catalog.remove('translationBindings',JSON.stringify(['account-a','a'.repeat(64)]));
  });
  it('rejects cancellation while capturing the initial source binding', async () => {
    const { connection, entry } = await fixture();
    const pause = pauseRead('connections', connection.id);
    const controller = new AbortController();
    const pending = entrySource(entry.id, entry.contentId, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await pause.started;
    controller.abort();
    pause.release();
    await rejected;
    expect(mocks.openSource).not.toHaveBeenCalled();
  });

  it('rejects cancellation during a source-generation recheck', async () => {
    const { entry } = await fixture();
    const controller = new AbortController();
    const binding = await entrySource(entry.id, entry.contentId, controller.signal);
    const pause = pauseRead('entries', entry.id);
    const rejected = expect(binding.assertCurrent()).rejects.toMatchObject({ name: 'AbortError' });
    await pause.started;
    controller.abort();
    pause.release();
    await rejected;
  });

  it('closes the source once when document preparation is cancelled', async () => {
    const { entry } = await fixture();
    const started = Promise.withResolvers<void>();
    mocks.openDocument.mockImplementationOnce(
      (_source, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started.resolve();
      }),
    );
    const controller = new AbortController();
    const opening = openEpubEntry(entry.id, entry.contentId, controller.signal);
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    controller.abort();
    await rejected;
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('rejects a cancelled session during the final database check', async () => {
    const { entry } = await fixture();
    // Initial binding, first validation, then final validation after subscribing.
    const pause = pauseRead('entries', entry.id, 3);
    const controller = new AbortController();
    const opening = openEpubEntry(entry.id, entry.contentId, controller.signal);
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await pause.started;
    controller.abort();
    pause.release();
    await rejected;
    expect(closeDocument).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('closes an active session on revocation and makes repeated close calls harmless', async () => {
    const { connection, entry } = await fixture();
    const session = await openEpubEntry(entry.id, entry.contentId);
    expect(session.signal.aborted).toBe(false);
    await catalog.patch('connections', connection.id, { status: 'revoked' });
    await vi.waitFor(() => expect(session.signal.aborted).toBe(true));
    await session.close();
    await session.close();
    expect(closeDocument).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
  });
});
