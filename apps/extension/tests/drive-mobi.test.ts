import 'fake-indexeddb/auto';
import {describe, expect, it, vi} from 'vitest';
import {openDocument} from '../src/comics/formats';
import {DriveRangeSource} from '../src/comics/sources/google-drive/range-source';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {openFileSource} from '../src/comics/sources/runtime';
import {importSourceFiles} from '../src/comics/application/import-service';
import {removeComic} from '../src/comics/application/library-service';
import {catalog} from '../src/comics/repositories';
import {sourceRangeCache} from '../src/storage/source-ranges';
import type {SourceSelection} from '../src/comics/sources/contracts';
import type {IndexedPage} from '../src/comics/formats/contracts';

function fixture(textRecords = 1) {
  const header = new Uint8Array(78 + (textRecords + 3) * 8), table = new DataView(header.buffer);
  header.set(new TextEncoder().encode('BOOKMOBI'), 60); table.setUint16(76, textRecords + 3);
  const first = new Uint8Array(248), fields = new DataView(first.buffer);
  fields.setUint16(0, 1); fields.setUint16(8, textRecords);
  first.set(new TextEncoder().encode('MOBI'), 16);
  fields.setUint32(20, 232); fields.setUint32(36, 6); fields.setUint32(108, textRecords + 1);
  const png = new Uint8Array(1024 * 1024); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(png.buffer).setUint32(16, 200); new DataView(png.buffer).setUint32(20, 100);
  const text = new TextEncoder().encode('<img recindex="2"><img recindex="1"><img recindex="2">');
  const records = [first, ...Array.from({length: textRecords}, () => text), png, png];
  let end = header.length;
  for (const [index, record] of records.entries()) { table.setUint32(78 + index * 8, end); end += record.length; }
  const bytes = new Uint8Array(end); bytes.set(header); end = header.length;
  for (const record of records) { bytes.set(record, end); end += record.length; }
  const binding = {accountId: 'account', fileId: 'file', resourceKey: 'key', version: '17', size: bytes.length};
  const reads: {offset: number; length: number}[] = [], onAccessLost = vi.fn();
  const state = {version: '17', denied: false, ignoreRange: false, changeAfterRead: false};
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer fixture-token');
    expect(headers.get('X-Goog-Drive-Resource-Keys')).toBe('file/key');
    if (state.denied) return Response.json({error: {errors: [{reason: 'appNotAuthorizedToFile'}]}}, {status: 403});
    if (!new URL(String(input)).searchParams.has('alt'))
      return Response.json({id: 'file', name: 'book.mobi', mimeType: 'application/octet-stream', size: String(bytes.length), version: state.version, capabilities: {canDownload: true}});
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get('Range') ?? '');
    if (!range) throw Error('Every media request must be bounded');
    const offset = Number(range[1]), length = Number(range[2]) - offset + 1;
    reads.push({offset, length});
    if (state.ignoreRange) return new Response(null, {status: 200});
    if (state.changeAfterRead) state.version = '18';
    return new Response(bytes.slice(offset, offset + length), {status: 206, headers: {
      'Content-Range': `bytes ${offset}-${offset + length - 1}/${bytes.length}`, 'Content-Length': String(length),
    }});
  });
  const createSource = () => new DriveRangeSource(binding, {token: async () => 'fixture-token', fetch: request, onAccessLost});
  return {source: createSource(), createSource, reads, state, request, onAccessLost, binding, imageStart: header.length + first.length + text.length * textRecords};
}

describe('MOBI over the Drive byte-source contract', () => {
  it('reuses imported index ranges when opening the cover and releases them with the comic', async () => {
    const {createSource, reads, request, binding} = fixture(32);
    const dispose = registerSourceDriver({id: 'mobi-test', label: 'Test', cachePages: true, cacheRanges: true, open: async () => createSource()});
    const selection: SourceSelection = {connection: {id: crypto.randomUUID(), provider: 'mobi-test', displayName: 'Test'},
      files: [{id: binding.fileId, name: 'book.mobi', format: 'mobi', locator: {}, snapshot: {...binding}}]};
    try {
      const result = await importSourceFiles(selection);
      expect(result.failures).toEqual([]);
      expect(request).toHaveBeenCalledTimes(12);
      const entry = (await catalog.get('entries', result.results[0].id))!;
      const comic = (await catalog.get('comics', entry.comicId))!;
      const connection = (await catalog.get('connections', selection.connection.id))!;
      const [page] = await catalog.listPages(entry.contentId);
      request.mockClear(); reads.length = 0;
      const source = await openFileSource({connection, source: comic.source, entryId: entry.id, contentId: entry.contentId,
        sourceSnapshot: entry.sourceSnapshot, format: 'mobi'});
      const session = await openDocument('mobi', source);
      try {
        expect((await session.materialize(page as IndexedPage)).size).toBe(1024 * 1024);
        expect(reads).toEqual([{offset: page.locator.offset, length: page.locator.length}]);
        expect(request).toHaveBeenCalledTimes(3);
      } finally { await session.close(); await source.close(); }
      // Selecting the same snapshot again must retain the original entry and index cache.
      request.mockClear();
      expect((await importSourceFiles(selection)).results[0].id).toBe(entry.id);
      expect(request).not.toHaveBeenCalled();
      await removeComic(comic.id);
      expect(await sourceRangeCache.usage()).toMatchObject({count: 0, bytes: 0});
    } finally { dispose(); await sourceRangeCache.clear(); }
  });
  it('cleans up pending ranges when indexing fails', async () => {
    const {createSource, state, binding} = fixture(32);
    const dispose = registerSourceDriver({id: 'mobi-failure', label: 'Test', cachePages: true, cacheRanges: true,
      open: async () => {
        const source = createSource(), read = source.readAt.bind(source);
        source.readAt = async (offset, length, signal) => {
          if (offset > 78) state.denied = true;
          return read(offset, length, signal);
        };
        return source;
      }});
    try {
      const result = await importSourceFiles({connection: {id: crypto.randomUUID(), provider: 'mobi-failure', displayName: 'Test'},
        files: [{id: binding.fileId, name: 'book.mobi', format: 'mobi', locator: {}, snapshot: {...binding}}]});
      expect(result.results).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(await sourceRangeCache.usage()).toMatchObject({count: 0, bytes: 0});
    } finally { dispose(); await sourceRangeCache.clear(); }
  });
  it('bounds index requests independently of the number of contiguous text records', async () => {
    const {source, reads, request, imageStart} = fixture(32), session = await openDocument('mobi', source);
    try {
      expect(await session.index()).toHaveLength(96);
      expect(reads).toHaveLength(4);
      expect(request).toHaveBeenCalledTimes(12); // Four ranges, each with before/after version validation.
      expect(reads.every(read => read.offset + read.length <= imageStart)).toBe(true);
    } finally { await session.close(); await source.close(); }
  });
  it('indexes without images and fetches only the selected record in body order', async () => {
    const {source, reads, imageStart} = fixture(), session = await openDocument('mobi', source);
    try {
      const pages = await session.index();
      expect(pages.map(page => page.locator.record)).toEqual([3, 2, 3]);
      expect(new Set(pages.map(page => JSON.stringify(page.locator))).size).toBe(3);
      expect(reads.every(read => read.offset + read.length <= imageStart)).toBe(true);
      reads.length = 0;
      expect(await session.materialize(pages[1])).toMatchObject({type: 'image/png', size: 1024 * 1024});
      expect(reads).toEqual([{offset: pages[1].locator.offset, length: pages[1].locator.length}]);
    } finally { await session.close(); await source.close(); }
  });
  it.each([
    ['changeAfterRead', 'source-changed'], ['denied', 'access-revoked'], ['ignoreRange', 'range-unsupported'],
  ] as const)('rejects a page after %s without an unbounded fallback', async (failure, code) => {
    const {source, reads, state, onAccessLost, binding} = fixture(), session = await openDocument('mobi', source);
    try {
      const pages = await session.index(); reads.length = 0; state[failure] = true;
      await expect(session.materialize(pages[0])).rejects.toMatchObject({code});
      expect(reads).toHaveLength(failure === 'denied' ? 0 : 1);
      if (failure === 'denied') expect(onAccessLost).toHaveBeenCalledWith(binding);
      if (failure === 'changeAfterRead') expect(await source.validate()).toBe('changed');
    } finally { await session.close(); await source.close(); }
  });
});
