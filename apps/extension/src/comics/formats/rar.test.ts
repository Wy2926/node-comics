import {afterEach, describe, expect, it, vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {openRarDocument} from './rar';
import type {RandomAccessSource} from './contracts';
function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
/** Tiny self-authored RAR4 Store fixture; no external manga or licensed sample. */
function storedRar() {
  const finish = <T extends Uint8Array>(header: T): T => { new DataView(header.buffer).setUint16(0, crc32(header.subarray(2)) & 65535, true); return header; };
  const main = new Uint8Array(13); main[2] = 0x73; new DataView(main.buffer).setUint16(5,13,true);
  const output: Uint8Array<ArrayBuffer>[] = [new Uint8Array([82,97,114,33,26,7,0]), finish(main)];
  for (const name of ['10.png', '2.png']) {
    const image = new TextEncoder().encode(`synthetic image ${name}`), filename = new TextEncoder().encode(name);
    const header = new Uint8Array(32 + filename.length), view = new DataView(header.buffer);
    header[2] = 0x74; view.setUint16(3,0x8000,true); view.setUint16(5,header.length,true);
    view.setUint32(7,image.length,true); view.setUint32(11,image.length,true); header[15] = 2;
    view.setUint32(16,crc32(image),true); header[24] = 20; header[25] = 0x30; view.setUint16(26,filename.length,true); view.setUint32(28,0x20,true);
    header.set(filename,32); output.push(finish(header),image);
  }
  const end = new Uint8Array(7); end[2] = 0x7b; new DataView(end.buffer).setUint16(5,7,true); output.push(finish(end));
  return new Blob(output);
}
afterEach(() => vi.unstubAllGlobals());
describe('bounded local RAR sessions', () => {
  it('uses actual UnRAR WASM to index and retrieve a requested entry repeatedly without exporting all pages', async () => {
    const wasm = await readFile(new URL('../../../node_modules/node-unrar-js/esm/js/unrar.wasm', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    vi.stubGlobal('fetch', async () => new Response(wasm));
    const blob = storedRar();
    const source: RandomAccessSource = {snapshot: {identity: 'rar', version: '1', size: blob.size, local: true},
      async readAt(offset,length) { return new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer()); }, async validate() { return 'unchanged'; }, async close() {}};
    const session = await openRarDocument(source);
    try {
      const pages = await session.index(); expect(pages.map(page => page.name)).toEqual(['2.png','10.png']);
      expect(session.capabilities).toMatchObject({access: 'full-buffer', remote: false, solid: false});
      expect(await (await session.materialize(pages[0])).text()).toBe('synthetic image 2.png');
      expect(await (await session.materialize(pages[1])).text()).toBe('synthetic image 10.png');
      expect(await (await session.materialize(pages[0])).text()).toBe('synthetic image 2.png');
    } finally { await session.close(); }
  });
  it('rejects cloud RAR before any file read', async () => {
    const readAt = vi.fn();
    await expect(openRarDocument({snapshot: {identity: 'remote', version: '1', size: 10, local: false}, readAt, async validate() { return 'unchanged'; }, async close() {}})).rejects.toThrow('云端');
    expect(readAt).not.toHaveBeenCalled();
  });
});
