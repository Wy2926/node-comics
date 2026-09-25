import {describe, expect, it} from 'vitest';
import {BlobReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js/index-native.js';
import {openZipDocument} from './zip';
import {openDocument, detectFormat} from './index';
import {checkRange, type RandomAccessSource} from './contracts';

function sourceFor(bytes: Uint8Array, local = true) {
  const reads: {offset: number; length: number}[] = [];
  const source: RandomAccessSource = {snapshot: {identity: 'fixture', version: 'v1', size: bytes.length, local},
    async readAt(offset, length, signal) { signal?.throwIfAborted(); checkRange(source, offset, length); reads.push({offset, length}); return bytes.slice(offset, offset + length); },
    async validate() { return 'unchanged'; }, async close() {},
  };
  return {source, reads};
}
const png = (size = 1024 * 1024) => { const bytes = new Uint8Array(size); bytes.set([137,80,78,71,13,10,26,10]); const view = new DataView(bytes.buffer); view.setUint32(16,200); view.setUint32(20,100); return bytes; };
async function zip() {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {useWebWorkers: false, level: 0});
  await writer.add('10.png', new BlobReader(new Blob([png()]))); await writer.add('2.png', new BlobReader(new Blob([png()])));
  return writer.close();
}
function mobi(refs = [2,1,2], encrypted = false) {
  const header = new Uint8Array(110); header.set(new TextEncoder().encode('BOOKMOBI'), 60);
  const h = new DataView(header.buffer); h.setUint16(76,4);
  const first = new Uint8Array(248), view = new DataView(first.buffer); view.setUint16(0,1); view.setUint16(8,1); view.setUint16(12,encrypted ? 1 : 0);
  first.set(new TextEncoder().encode('MOBI'),16); view.setUint32(20,232); view.setUint32(36,6); view.setUint32(108,2);
  const records = [first, new TextEncoder().encode(refs.map(value => `<img recindex="${value}">`).join('')), png(), png()];
  let offset = header.length; records.forEach((record,index) => { h.setUint32(78 + index * 8, offset); offset += record.length; });
  const bytes = new Uint8Array(offset); bytes.set(header); offset = header.length;
  for (const record of records) { bytes.set(record,offset); offset += record.length; }
  return {bytes, imageStart: header.length + first.length + records[1].length};
}

describe('page indexes separate from materialization', () => {
  it('indexes ZIP using small metadata ranges, sorts numeric paths, and extracts only the requested page', async () => {
    const {source, reads} = sourceFor(await zip()), session = openZipDocument(source);
    try {
      const pages = await session.index(); expect(pages.map(page => page.name)).toEqual(['2.png','10.png']);
      expect(reads.reduce((sum,read) => sum + read.length,0)).toBeLessThan(100_000);
      expect(pages.every(page => !('blob' in page))).toBe(true);
      reads.length = 0;
      const page = await session.materialize(pages[0]); expect(page.type).toBe('image/png'); expect(page.size).toBe(1024 * 1024);
      expect(reads.reduce((sum,read) => sum + read.length,0)).toBeLessThan(1100_000);
      await expect(session.materialize({...pages[0], locator: {entry: 'foreign.png'}})).rejects.toThrow('不属于');
    } finally { await session.close(); }
  });
  it.each([true, false])('MOBI indexes repeated body references without reading any image bytes (local=%s)', async local => {
    const fixture = mobi(), {source, reads} = sourceFor(fixture.bytes, local), session = await openDocument('mobi', source);
    try {
      expect(session.capabilities).toMatchObject({access: 'random', remote: true});
      const pages = await session.index(); expect(pages.map(page => page.locator.record)).toEqual([3,2,3]);
      expect(pages.map(page => page.ordinal)).toEqual([0,1,2]);
      expect(new Set(pages.map(page=>JSON.stringify(page.locator))).size).toBe(3);
      expect(reads.every(read => read.offset + read.length <= fixture.imageStart)).toBe(true);
      reads.length = 0;
      expect((await session.materialize(pages[2])).type).toBe('image/png');
      expect(reads).toEqual([{offset: pages[2].locator.offset, length: pages[2].locator.length}]);
    } finally { await session.close(); }
  });
  it.each([true, false])('rejects DRM and malformed image references during indexing (local=%s)', async local => {
    for (const [fixture, reason] of [[mobi([1],true), 'DRM'], [mobi([99]), '不存在']] as const) {
      const session = await openDocument('mobi', sourceFor(fixture.bytes, local).source);
      try { await expect(session.index()).rejects.toThrow(reason); } finally { await session.close(); }
    }
  });
  it.each([
    [0, 17480, 'HUFF/CDIC'], [36, 8, 'KF8'], [4, 16 * 1024 * 1024 + 1, '安全限制'],
  ])('rejects unsupported or oversized remote MOBI before reading images (field=%s)', async (field, value, reason) => {
    const fixture = mobi(), view = new DataView(fixture.bytes.buffer);
    if (field === 0) view.setUint16(110 + field, value); else view.setUint32(110 + field, value);
    const {source, reads} = sourceFor(fixture.bytes, false), session = await openDocument('mobi', source);
    try {
      await expect(session.index()).rejects.toThrow(reason);
      expect(reads.every(read => read.offset + read.length <= fixture.imageStart)).toBe(true);
    } finally { await session.close(); }
  });
  it('cancels remote MOBI page reads and refuses foreign locators', async () => {
    const {source, reads} = sourceFor(mobi().bytes, false), session = await openDocument('mobi', source);
    try {
      const pages = await session.index(); reads.length = 0;
      const controller = new AbortController(); controller.abort();
      await expect(session.materialize(pages[0], controller.signal)).rejects.toMatchObject({name: 'AbortError'});
      await expect(session.materialize({...pages[0], locator: {...pages[0].locator, offset: 0}})).rejects.toThrow('不属于');
      expect(reads).toHaveLength(0);
    } finally { await session.close(); }
  });
  it('rejects an oversized contiguous text span before fetching it', async () => {
    const fixture = mobi(), fields = new DataView(fixture.bytes.buffer);
    const textStart = fields.getUint32(86), imageStart = textStart + 16 * 1024 * 1024;
    fields.setUint32(94, imageStart); fields.setUint32(102, imageStart + 1024 * 1024);
    const {source, reads} = sourceFor(fixture.bytes, false);
    source.snapshot.size = imageStart + 2 * 1024 * 1024;
    const session = await openDocument('mobi', source);
    try {
      await expect(session.index()).rejects.toThrow('安全预算');
      expect(reads).toHaveLength(3);
      expect(reads.every(read => read.offset + read.length <= textStart)).toBe(true);
    } finally { await session.close(); }
  });
  it.each(['pdf', 'cbr', 'image'])('keeps unsupported remote formats closed (%s)', async format => {
    const {source, reads} = sourceFor(png(100), false);
    await expect(openDocument(format, source)).rejects.toThrow('云端范围读取');
    expect(reads).toHaveLength(0);
  });
  it('rejects standalone images and respects cancellation before file reads',async()=>{
    const {source,reads}=sourceFor(png(100));await expect(openDocument('image',source)).rejects.toThrow('不支持');expect(detectFormat('a.png',png(100))).toBeUndefined();expect(detectFormat('a.cbz',png(100))).toBeUndefined();
    const controller=new AbortController();controller.abort();await expect(openDocument('cbz',source,controller.signal)).rejects.toThrow();expect(reads).toHaveLength(0);
  });
});
