import {describe, expect, it, vi} from 'vitest';
import {openDocument} from '../src/comics/formats';
import {DriveRangeSource} from '../src/comics/sources/google-drive/range-source';

function fixture() {
  const header = new Uint8Array(110), table = new DataView(header.buffer);
  header.set(new TextEncoder().encode('BOOKMOBI'), 60); table.setUint16(76, 4);
  const first = new Uint8Array(248), fields = new DataView(first.buffer);
  fields.setUint16(0, 1); fields.setUint16(8, 1);
  first.set(new TextEncoder().encode('MOBI'), 16);
  fields.setUint32(20, 232); fields.setUint32(36, 6); fields.setUint32(108, 2);
  const png = new Uint8Array(1024 * 1024); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(png.buffer).setUint32(16, 200); new DataView(png.buffer).setUint32(20, 100);
  const text = new TextEncoder().encode('<img recindex="2"><img recindex="1"><img recindex="2">');
  const records = [first, text, png, png];
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
  const source = new DriveRangeSource(binding, {token: async () => 'fixture-token', fetch: request, onAccessLost});
  return {source, reads, state, request, onAccessLost, binding, imageStart: header.length + first.length + text.length};
}

describe('MOBI over the Drive byte-source contract', () => {
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
