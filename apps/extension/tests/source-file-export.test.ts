import 'fake-indexeddb/auto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import type {CatalogTable, Comic, Entry, SourceConnection} from '../src/comics/domain';
import type {RandomAccessSource} from '../src/comics/formats/contracts';
import {MAX_EXPORT_BYTES} from '../src/export/plan';
import {
  exportOriginalFile,
  originalFileInfo,
} from '../src/comics/application/export-service';

const mocks = vi.hoisted(() => ({openContainer: vi.fn()}));
vi.mock('../src/storage/containers', () => ({openContainer: mocks.openContainer}));
vi.mock('../src/comics/pages/service', () => ({
  acquirePage: vi.fn(),
  materializationId: vi.fn(),
}));

const chunkSize = 1024 * 1024;
const fixtures: {comic: Comic; entry: Entry; connection: SourceConnection}[] = [];
let source: RandomAccessSource;

beforeEach(() => {
  source = {
    snapshot: {identity: 'saved-file', version: '1', size: 8, local: true},
    readAt: vi.fn(async (_offset, length, signal) => {
      signal?.throwIfAborted();
      return new Uint8Array(length).fill(7);
    }),
    validate: vi.fn(async () => 'unchanged' as const),
    close: vi.fn(async () => {}),
  };
  mocks.openContainer.mockReset().mockResolvedValue(source);
  vi.stubGlobal('fetch', vi.fn(() => {throw Error('Unexpected network request');}));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const {comic, entry, connection} of fixtures.splice(0)) {
    await catalog.remove('entries', entry.id);
    await catalog.remove('comics', comic.id);
    await catalog.remove('connections', connection.id);
    // The real local provider has one fixed connection ID, reused by these isolated fixtures.
    if (connection.id === 'local') await catalog.remove('tombstones', 'connections:local');
  }
});

async function fixture(provider = 'opds') {
  const id = crypto.randomUUID();
  const connection: SourceConnection = {
    id: provider === 'local' ? 'local' : 'connection:' + id,
    provider,
    displayName: 'Saved source',
    status: 'connected',
    generation: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const comic: Comic = {
    id,
    title: 'Saved book',
    sourceKey: id,
    sourceName: connection.displayName,
    source: {
      connectionId: connection.id,
      providerItemId: id,
      locator: {name: 'Original.epub'},
      status: 'active',
      generation: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const entry: Entry = {
    id: 'entry:' + id,
    comicId: id,
    title: comic.title,
    format: 'epub',
    contentId: 'content:' + id,
    containerId: 'container:' + id,
    generation: 1,
    order: 0,
    indexState: 'ready',
    pageCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  await catalog.commit([
    {table: 'connections', value: connection},
    {table: 'comics', value: comic},
    {table: 'entries', value: entry},
  ]);
  const result = {comic, entry, connection};
  fixtures.push(result);
  return result;
}

function destination() {
  const write = vi.fn();
  const close = vi.fn();
  const abort = vi.fn();
  const stream = new WritableStream<Uint8Array>({write, close, abort});
  return {stream, write, close, abort};
}

describe('saved source file export', () => {
  it.each(['local', 'opds'])('copies %s saved bytes without a provider request', async (provider) => {
    const {entry} = await fixture(provider);
    expect(await originalFileInfo(entry.id)).toEqual({name: 'Original.epub'});
    expect(mocks.openContainer).not.toHaveBeenCalled();

    const result = await exportOriginalFile(entry.id, {signal: new AbortController().signal});
    expect(result.name).toBe('Original.epub');
    expect(new Uint8Array(await result.blob!.arrayBuffer())).toEqual(new Uint8Array(8).fill(7));
    expect(mocks.openContainer).toHaveBeenCalledExactlyOnceWith(entry.containerId);
    expect(source.close).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses an authorized metadata fallback name without opening or downloading the source', async () => {
    const {comic, entry} = await fixture();
    await catalog.patch('comics', comic.id, {source: {...comic.source, locator: {}}});
    expect(await originalFileInfo(entry.id)).toEqual({name: 'Saved book.epub'});
    await catalog.patch('entries', entry.id, {containerId: undefined});
    expect(await originalFileInfo(entry.id)).toBeUndefined();
    await expect(exportOriginalFile(entry.id, {
      signal: new AbortController().signal,
    })).rejects.toThrow('没有本地源文件');
    expect(mocks.openContainer).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['local', 'opds'])('rejects a missing %s connection instead of bypassing access', async (provider) => {
    const {connection, entry} = await fixture(provider);
    await catalog.remove('connections', connection.id);
    await expect(originalFileInfo(entry.id)).rejects.toThrow('已移除或变化');
    await expect(exportOriginalFile(entry.id, {
      signal: new AbortController().signal,
    })).rejects.toThrow('已移除或变化');
    expect(mocks.openContainer).not.toHaveBeenCalled();
  });

  it.each(['source-disconnected', 'source-revoked', 'connection-disconnected', 'connection-revoked'])(
    'rejects %s before opening saved bytes',
    async (state) => {
      const {comic, connection, entry} = await fixture();
      const status = state.endsWith('revoked') ? 'revoked' : 'disconnected';
      if (state.startsWith('source-')) {
        await catalog.patch('comics', comic.id, {source: {...comic.source, status}});
      } else {
        await catalog.patch('connections', connection.id, {status});
      }
      await expect(originalFileInfo(entry.id)).rejects.toThrow('已断开');
      await expect(exportOriginalFile(entry.id, {
        signal: new AbortController().signal,
      })).rejects.toThrow('已断开');
      expect(mocks.openContainer).not.toHaveBeenCalled();
    },
  );

  it('rejects file information captured across a connection generation change', async () => {
    const {connection, entry} = await fixture();
    const get = catalog.get.bind(catalog);
    let captured = false;
    vi.spyOn(catalog, 'get').mockImplementation(async <T extends CatalogTable>(
      table: T,
      id: IDBValidKey,
    ) => {
      const value = await get(table, id);
      if (!captured && table === 'connections' && id === connection.id) {
        captured = true;
        await catalog.patch('connections', connection.id, {generation: 2});
      }
      return value;
    });
    await expect(originalFileInfo(entry.id)).rejects.toMatchObject({name: 'AbortError'});
    expect(mocks.openContainer).not.toHaveBeenCalled();
  });

  it('revalidates after container opening and before the first read', async () => {
    const {connection, entry} = await fixture();
    const target = destination();
    mocks.openContainer.mockImplementation(async () => {
      await catalog.patch('connections', connection.id, {generation: 2});
      return source;
    });
    await expect(exportOriginalFile(entry.id, {
      signal: new AbortController().signal,
      destination: target.stream,
    })).rejects.toMatchObject({name: 'AbortError'});
    expect(source.readAt).not.toHaveBeenCalled();
    expect(target.write).not.toHaveBeenCalled();
    expect(target.abort).toHaveBeenCalledOnce();
    expect(target.close).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });

  const changes: [string, (value: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>][] = [
    ['content replaced', ({entry}) => catalog.patch('entries', entry.id, {contentId: 'new-content'})],
    ['entry generation', ({entry}) => catalog.patch('entries', entry.id, {generation: 2})],
    ['source generation', ({comic}) => catalog.patch('comics', comic.id, {
      source: {...comic.source, generation: 2},
    })],
    ['source revoked', ({comic}) => catalog.patch('comics', comic.id, {
      source: {...comic.source, status: 'revoked'},
    })],
    ['connection generation', ({connection}) => catalog.patch('connections', connection.id, {
      generation: 2,
    })],
    ['connection disconnected', ({connection}) => catalog.patch('connections', connection.id, {
      status: 'disconnected',
    })],
    ['entry deleted', ({entry}) => catalog.remove('entries', entry.id)],
    ['comic deleted', ({comic}) => catalog.remove('comics', comic.id)],
    ['connection deleted', ({connection}) => catalog.remove('connections', connection.id)],
  ];
  it.each(changes)('discards the current read when %s before writing it', async (_name, mutate) => {
    const data = await fixture();
    const target = destination();
    vi.mocked(source.readAt).mockImplementation(async () => {
      await mutate(data);
      return new Uint8Array(8);
    });
    await expect(exportOriginalFile(data.entry.id, {
      signal: new AbortController().signal,
      destination: target.stream,
    })).rejects.toMatchObject({name: 'AbortError'});
    expect(target.write).not.toHaveBeenCalled();
    expect(target.close).not.toHaveBeenCalled();
    expect(target.abort).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
    expect(target.stream.locked).toBe(false);
  });

  it('rejects a buffered result when the final progress callback invalidates its source', async () => {
    const {entry} = await fixture();
    const controller = new AbortController();
    await expect(exportOriginalFile(entry.id, {
      signal: controller.signal,
      progress: () => controller.abort(),
    })).rejects.toMatchObject({name: 'AbortError'});
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('rejects cancellation during a read before exposing its bytes', async () => {
    const {entry} = await fixture();
    const controller = new AbortController();
    const target = destination();
    vi.mocked(source.readAt).mockImplementation(async () => {
      controller.abort();
      return new Uint8Array(8);
    });
    await expect(exportOriginalFile(entry.id, {
      signal: controller.signal,
      destination: target.stream,
    })).rejects.toMatchObject({name: 'AbortError'});
    expect(target.write).not.toHaveBeenCalled();
    expect(target.close).not.toHaveBeenCalled();
    expect(target.abort).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('checks again after the final write before closing the destination', async () => {
    const {connection, entry} = await fixture();
    const target = destination();
    target.write.mockImplementation(async () => {
      await catalog.patch('connections', connection.id, {status: 'disconnected'});
    });
    await expect(exportOriginalFile(entry.id, {
      signal: new AbortController().signal,
      destination: target.stream,
    })).rejects.toMatchObject({name: 'AbortError'});
    expect(target.write).toHaveBeenCalledOnce();
    expect(target.abort).toHaveBeenCalledOnce();
    expect(target.close).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('checks each read only once and keeps its buffer bounded to one MiB', async () => {
    const {entry} = await fixture();
    const target = destination();
    source.snapshot.size = 2 * chunkSize + 17;
    const get = vi.spyOn(catalog, 'get');
    const result = await exportOriginalFile(entry.id, {
      signal: new AbortController().signal,
      destination: target.stream,
    });
    expect(result).toEqual({name: 'Original.epub', bytes: source.snapshot.size});
    expect(vi.mocked(source.readAt).mock.calls.map(([offset, length]) => [offset, length])).toEqual([
      [0, chunkSize], [chunkSize, chunkSize], [2 * chunkSize, 17],
    ]);
    // One capture, one before reading, one after each of three chunks, one before close.
    for (const table of ['entries', 'comics', 'connections']) {
      expect(get.mock.calls.filter(([name]) => name === table)).toHaveLength(6);
    }
    expect(target.write).toHaveBeenCalledTimes(3);
    expect(target.close).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('still rejects oversized buffered exports before reading any bytes', async () => {
    const {entry} = await fixture();
    source.snapshot.size = MAX_EXPORT_BYTES + 1;
    await expect(exportOriginalFile(entry.id, {
      signal: new AbortController().signal,
    })).rejects.toThrow('128 MiB');
    expect(source.readAt).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('closes the source if the destination is already locked', async () => {
    const {entry} = await fixture();
    const target = destination();
    const writer = target.stream.getWriter();
    try {
      await expect(exportOriginalFile(entry.id, {
        signal: new AbortController().signal,
        destination: target.stream,
      })).rejects.toThrow();
      expect(source.readAt).not.toHaveBeenCalled();
      expect(source.close).toHaveBeenCalledOnce();
    } finally {
      writer.releaseLock();
    }
  });
});
