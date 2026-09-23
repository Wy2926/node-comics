import {describe, it, expect} from 'vitest';
import {ZipWriter, BlobWriter, TextReader} from '@zip.js/zip.js/index-native.js';
import {validateEntries, comparePaths, MAX_PAGE, MiB} from './limits';
import {openZipDocument} from './zip';
import {decompressPalmDoc} from './mobi';
import type {RandomAccessSource} from './contracts';
async function zip(names: string[], options: object = {}) {
  const writer = new ZipWriter(new BlobWriter(), {useWebWorkers: false, ...options});
  for (const name of names) await writer.add(name, new TextReader('image fixture bytes'), {level: 6});
  return writer.close();
}
const source = (blob: Blob): RandomAccessSource => ({snapshot: {identity: 'fixture', version: '1', size: blob.size, local: true},
  async readAt(offset, length, signal) { signal?.throwIfAborted(); return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); }, async validate() { return 'unchanged'; }, async close() {}});
describe('archive resource limits and integrity', () => {
  it('reads actual Deflate entries in natural order while excluding metadata paths', async () => {
    const session = openZipDocument(source(await zip(['10.png','__MACOSX/._01.png','2.png','.hidden.png','readme.txt','01.png'])));
    try {
      const pages = await session.index(); expect(pages.map(page => page.name)).toEqual(['01.png','2.png','10.png']);
      expect(await (await session.materialize(pages[0])).text()).toBe('image fixture bytes');
    } finally { await session.close(); }
  });
  it('rejects encrypted archives and indexes without images', async () => {
    for (const [blob, error] of [[await zip(['1.png'],{password: 'test', zipCrypto: true}), '加密'], [await zip(['metadata.txt']), '没有']] as const) {
      const session = openZipDocument(source(blob));
      try { await expect(session.index()).rejects.toThrow(error); } finally { await session.close(); }
    }
  });
  it('rejects CRC corruption only when the requested entry is materialized', async () => {
    const writer = new ZipWriter(new BlobWriter(), {useWebWorkers: false});
    await writer.add('1.png', new TextReader('unique-pixel-bytes'), {level: 0});
    const bytes = new Uint8Array(await (await writer.close()).arrayBuffer());
    const offset = Buffer.from(bytes).indexOf('unique-pixel-bytes'); expect(offset).toBeGreaterThanOrEqual(0); bytes[offset] ^= 1;
    const session = openZipDocument(source(new Blob([bytes])));
    try { const pages = await session.index(); await expect(session.materialize(pages[0])).rejects.toThrow(); }
    finally { await session.close(); }
  });
  it('bounds declared expansion, page count and ambiguous paths', () => {
    expect(() => validateEntries([{name:'1.png',size:MAX_PAGE+1}])).toThrow('32 MB');
    expect(() => validateEntries(Array.from({length:1501},(_,i)=>({name:`${i}.png`,size:1})))).toThrow('1500');
    expect(() => validateEntries([{name:'a.png',size:20*MiB},{name:'b.png',size:20*MiB}],32*MiB)).toThrow('展开');
    expect(() => validateEntries([{name:'a.png',size:1},{name:'a.png',size:1}])).toThrow('重名');
    expect([{name:'2.png'},{name:'02.png'},{name:'A/1.png'},{name:'a/1.png'}].sort(comparePaths).map(e=>e.name)).toEqual(['02.png','2.png','A/1.png','a/1.png']);
  });
  it('bounds PalmDOC expansion and rejects invalid backward references', () => {
    expect(() => decompressPalmDoc(Uint8Array.from([128,24]))).toThrow('回溯');
    expect(() => decompressPalmDoc(Uint8Array.from([97,98,99]), 2)).toThrow('安全限制');
    expect(new TextDecoder().decode(decompressPalmDoc(Uint8Array.from([97,98,99,128,25,225])))).toBe('abcabca a');
  });
});
