import 'fake-indexeddb/auto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {CHUNK_SIZE, bytesTransaction, chunkId, idbRequest} from '../bytes/database';
import {importContainer, listContainerImports, openContainer, recoverContainerImports, releaseContainer, retainContainer} from './index';

const tables = ['objects', 'chunks', 'operations', 'references', 'leases', 'settings'];
beforeEach(async () => { await bytesTransaction(tables, 'readwrite', async tx => { for (const name of tables) tx.objectStore(name).clear(); }); });
afterEach(()=>vi.unstubAllGlobals());
function file(size = CHUNK_SIZE + 19) {
  const bytes = new Uint8Array(size); bytes.set([80, 75, 3, 4, 0, 0, 0, 0]);
  for (let i = 8; i < size; i++) bytes[i] = i % 251;
  return new File([bytes], 'comic.cbz', {type: 'application/zip'});
}
const rows = (table: string) => bytesTransaction([table], 'readonly', tx => idbRequest(tx.objectStore(table).getAll()));

describe('immutable local containers', () => {
  it('copies one bounded stream, hashes its written bytes, and reads across chunk boundaries after reopening', async () => {
    const input = file();
    const container = await importContainer(input, undefined, undefined, 'revision-a');
    expect(container.sha256).toBe(createHash('sha256').update(new Uint8Array(await input.arrayBuffer())).digest('hex'));
    expect((await rows('chunks')).map(row => row.bytes.byteLength)).toEqual([CHUNK_SIZE, 19]);
    expect(await rows('operations')).toEqual([]);
    let source = await openContainer(container.id); await source.close();
    source = await openContainer(container.id);
    try {
      expect(await source.readAt(CHUNK_SIZE - 7, 26)).toEqual(new Uint8Array(await input.slice(CHUNK_SIZE - 7).arrayBuffer()));
      expect(await source.validate()).toBe('unchanged');
      await expect(source.readAt(-1, 1)).rejects.toThrow('范围');
    } finally { await source.close(); }
  });
  it('deduplicates concurrent complete imports and atomically keeps both revision references', async () => {
    const input = file();
    const [a, b] = await Promise.all([importContainer(input, undefined, undefined, 'a'), importContainer(input, undefined, undefined, 'b')]);
    expect(a.id).toBe(b.id);
    expect(await rows('objects')).toHaveLength(1);
    expect(await rows('chunks')).toHaveLength(2);
    expect(await rows('references')).toHaveLength(2);
    await releaseContainer(a.id, 'a');
    expect(await rows('objects')).toHaveLength(1);
    await releaseContainer(a.id, 'b');
    expect(await rows('objects')).toHaveLength(0);
    expect(await rows('chunks')).toHaveLength(0);
  });
  it('keeps bytes for an existing read lease after the final reference is removed', async () => {
    const container = await importContainer(file(40), undefined, undefined, 'revision');
    const source = await openContainer(container.id);
    try {
      await releaseContainer(container.id, 'revision');
      await expect(openContainer(container.id)).rejects.toThrow('重新导入');
      expect((await source.readAt(0, 4)).length).toBe(4);
      expect(await rows('chunks')).toHaveLength(1);
    } finally { await source.close(); }
    expect(await rows('objects')).toHaveLength(0);
  });
  it('repairs a deduplicated container whose browser bytes disappeared and preserves existing references', async () => {
    const input = file(); const container = await importContainer(input, undefined, undefined, 'old');
    const record = (await rows('objects'))[0];
    await bytesTransaction(['chunks'], 'readwrite', async tx => { tx.objectStore('chunks').delete(chunkId(record.objectId, 0)); });
    await expect(openContainer(container.id)).rejects.toThrow('重新导入');
    const restored = await importContainer(input, undefined, undefined, 'new');
    expect(restored.id).toBe(container.id);
    expect(await rows('objects')).toHaveLength(1);
    expect(await rows('references')).toHaveLength(2);
    const source = await openContainer(restored.id);
    try { expect(await source.readAt(0, 8)).toEqual(new Uint8Array([80, 75, 3, 4, 0, 0, 0, 0])); }
    finally { await source.close(); }
  });
  it('cancellation removes staging and never publishes a partial object or reference', async () => {
    const controller = new AbortController();
    await expect(importContainer(file(), controller.signal, () => controller.abort(), 'cancelled')).rejects.toThrow();
    expect(await rows('chunks')).toEqual([]); expect(await rows('objects')).toEqual([]);
    expect(await rows('references')).toEqual([]); expect(await rows('operations')).toEqual([]);
  });
  it('recovers closed bytes without rereading input and leaves another tab’s active staging intact', async () => {
    const input = file(100); const bytes = await input.arrayBuffer();
    const hash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
    await bytesTransaction(['operations', 'chunks'], 'readwrite', async tx => {
      for (const [id, state, expiresAt] of [['closed', 'bytesClosed', 0], ['abandoned', 'staging', 0], ['active', 'staging', Date.now() + 60_000]] as const) {
        tx.objectStore('operations').add({id, size: 100, written: 100, state, expiresAt, generation: 1, format: 'cbz', sha256: hash, fileName: 'recovered.cbz', referenceId: 'recovered'});
        tx.objectStore('chunks').add({id: chunkId(id, 0), objectId: id, ordinal: 0, bytes});
      }
    });
    const recovered = await recoverContainerImports();
    expect(recovered).toHaveLength(1); expect(recovered[0].fileName).toBe('recovered.cbz');
    expect((await rows('operations')).map(row => row.id)).toEqual(['active']);
    expect(await rows('chunks')).toHaveLength(2);
    await retainContainer(recovered[0].id, 'book');
    expect(await rows('references')).toHaveLength(2);
  });
  it('rejects renamed unsupported content before storage allocation', async () => {
    await expect(importContainer(new File(['not zip'], 'book.cbz'))).rejects.toThrow('请选择');
    expect(await rows('chunks')).toEqual([]); expect(await rows('operations')).toEqual([]);
  });
  it('lists published but not yet catalogued revisions with names and a stable metadata cursor',async()=>{
    const input=file(100);await importContainer(input,undefined,undefined,'revision-a');await importContainer(input,undefined,undefined,'revision-b');
    const first=await listContainerImports(1);expect(first.items).toHaveLength(1);expect(first.next).toBeTruthy();
    const second=await listContainerImports(1,first.next);expect(second.items).toHaveLength(1);expect(second.next).toBeUndefined();
    expect([...first.items,...second.items].map(item=>item.referenceId)).toEqual(['revision-a','revision-b']);
    expect(first.items[0].fileName).toBe('comic.cbz');expect(first.items[0].importId).toBeTruthy();
  });
  it('rejects a low-space reservation before writing chunks',async()=>{
    vi.stubGlobal('navigator',{storage:{estimate:async()=>({quota:1024,usage:0})}});
    await expect(importContainer(file(100))).rejects.toThrow('空间不足');expect(await rows('operations')).toEqual([]);expect(await rows('chunks')).toEqual([]);
  });
  it('finishes deferred deletion after a crashed reader lease expires',async()=>{
    const container=await importContainer(file(100),undefined,undefined,'revision');const source=await openContainer(container.id);
    try{
      await releaseContainer(container.id,'revision');
      await bytesTransaction(['leases'],'readwrite',async tx=>{const leases=await idbRequest(tx.objectStore('leases').getAll());for(const lease of leases)tx.objectStore('leases').put({...lease,expiresAt:0});});
      await recoverContainerImports();expect(await rows('objects')).toEqual([]);expect(await rows('chunks')).toEqual([]);
    }finally{await source.close();}
  });
});
