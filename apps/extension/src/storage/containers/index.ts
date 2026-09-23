import {Sha256} from '../../importers/hash';
import {detectFormat} from '../../comics/formats/identify';
import {checkRange, throwIfAborted, type ComicFormat, type RandomAccessSource} from '../../comics/formats/contracts';
import {BYTE_BACKEND, CHUNK_SIZE, bytesTransaction, chunkId, idbRequest, objectComplete, removeChunks, type ByteChunk} from '../bytes/database';

export interface ManagedContainer { id: string; sha256: string; size: number; format: ComicFormat; fileName?: string; importId?: string; referenceId?: string }
interface ContainerRecord extends ManagedContainer { objectId: string; generation: number; state: 'ready' | 'deleting'; availability: 'present' | 'missing'; backend: string }
interface ImportOperation { id: string; size: number; written: number; format: ComicFormat; fileName: string; referenceId?: string; expiresAt: number; generation: number; state: 'staging' | 'bytesClosed'; sha256?: string }
interface Lease {id: string; containerId: string; generation: number; expiresAt: number}
const LEASE_MS = 120_000;
const IMPORT_MS = 300_000;
const ALL = ['objects', 'chunks', 'operations', 'references', 'leases'];
const missing = () => new Error('本地源文件已移除，请重新导入。');

async function reserve(file: File, format: ComicFormat, referenceId?: string): Promise<ImportOperation> {
  const estimate = await globalThis.navigator?.storage?.estimate?.();
  return bytesTransaction(['operations'], 'readwrite', async tx => {
    const store = tx.objectStore('operations');
    const pending = await idbRequest(store.getAll()) as ImportOperation[];
    const reserved = pending.reduce((sum, item) => sum + Math.max(0, item.size - item.written), 0);
    if (estimate?.quota && estimate.quota - (estimate.usage ?? 0) < reserved + file.size + CHUNK_SIZE)
      throw new Error('本地空间不足，无法保存完整源文件。请管理本地资料后重试。');
    const operation: ImportOperation = {id: crypto.randomUUID(), format, fileName: file.name, referenceId, size: file.size, written: 0, expiresAt: Date.now() + IMPORT_MS, generation: 1, state: 'staging'};
    store.add(operation);
    return operation;
  });
}

async function publish(operationId: string, signal?: AbortSignal): Promise<ManagedContainer> {
  return bytesTransaction(ALL, 'readwrite', async tx => {
    throwIfAborted(signal);
    const operations = tx.objectStore('operations');
    const op = await idbRequest(operations.get(operationId)) as ImportOperation | undefined;
    if (!op || op.state !== 'bytesClosed' || !op.sha256 || !await objectComplete(tx, op.id, op.size))
      throw new Error('源文件尚未完整保存。');
    const id = `${op.sha256}:${op.size}`;
    const objects = tx.objectStore('objects');
    const existing = await idbRequest(objects.get(id)) as ContainerRecord | undefined;
    if (op.referenceId) tx.objectStore('references').put({id: JSON.stringify([id, op.referenceId]), containerId: id, referenceId: op.referenceId, importId: op.id, fileName: op.fileName});
    // The same write transaction fences deletion, deduplication and missing-byte repair.
    if (existing && await objectComplete(tx, existing.objectId, existing.size)) {
      objects.put({...existing, state: 'ready', availability: 'present'});
      await removeChunks(tx, op.id);
      operations.delete(op.id);
      return {id, sha256: op.sha256, size: op.size, format: op.format, fileName: op.fileName, importId: op.id, referenceId: op.referenceId};
    }
    if (existing) await removeChunks(tx, existing.objectId);
    const record: ContainerRecord = {id, sha256: op.sha256, size: op.size, format: op.format, objectId: op.id,
      generation: (existing?.generation ?? 0) + 1, state: 'ready', availability: 'present', backend: BYTE_BACKEND, fileName: op.fileName, importId: op.id, referenceId: op.referenceId};
    objects.put(record);
    operations.delete(op.id);
    throwIfAborted(signal);
    return {id, sha256: record.sha256, size: record.size, format: record.format, fileName: op.fileName, importId: op.id, referenceId: op.referenceId};
  });
}

/** Copy in bounded chunks, hashing exactly the bytes written during that one copy. */
export async function importContainer(file: File, signal?: AbortSignal, onProgress?: (done: number, total: number) => void, referenceId?: string): Promise<ManagedContainer> {
  throwIfAborted(signal);
  if (!file.size || file.size > 512 * CHUNK_SIZE) throw new Error('本地源文件需为 1 字节至 512 MB。');
  const prefix = new Uint8Array(await file.slice(0, 80).arrayBuffer());
  const format = detectFormat(file.name, prefix);
  if (!format) throw new Error('请选择 CBZ/ZIP、CBR/RAR、PDF 或未加密 MOBI 漫画文件，不支持散图。');
  if (format === 'cbr' && file.size > 128 * CHUNK_SIZE) throw new Error('CBR 解码会话最多支持 128 MB，请转换为 CBZ。');
  const op = await reserve(file, format, referenceId);
  try {
    const hash = new Sha256();
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      throwIfAborted(signal);
      const bytes = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      hash.update(new Uint8Array(bytes));
      await bytesTransaction(['operations', 'chunks'], 'readwrite', async tx => {
        throwIfAborted(signal);
        const operations = tx.objectStore('operations');
        const current = await idbRequest(operations.get(op.id)) as ImportOperation | undefined;
        if (!current || current.generation !== op.generation || current.written !== offset) throw new Error('源文件复制已中断。');
        tx.objectStore('chunks').add({id: chunkId(op.id, offset / CHUNK_SIZE), objectId: op.id, ordinal: offset / CHUNK_SIZE, bytes});
        operations.put({...current, written: offset + bytes.byteLength, expiresAt: Date.now() + IMPORT_MS});
      });
      onProgress?.(Math.min(file.size, offset + CHUNK_SIZE), file.size);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const sha256 = hash.digest();
    await bytesTransaction(['operations'], 'readwrite', async tx => {
      throwIfAborted(signal);
      const store = tx.objectStore('operations');
      const current = await idbRequest(store.get(op.id)) as ImportOperation | undefined;
      if (!current || current.written !== file.size) throw new Error('源文件复制不完整。');
      store.put({...current, sha256, state: 'bytesClosed'});
    });
    return await publish(op.id, signal);
  } catch (error) {
    await bytesTransaction(['operations', 'chunks'], 'readwrite', async tx => {
      tx.objectStore('operations').delete(op.id);
      await removeChunks(tx, op.id);
    }).catch(() => {});
    throw error;
  }
}

export async function retainContainer(id: string, referenceId: string) {
  await bytesTransaction(['objects', 'references'], 'readwrite', async tx => {
    const record = await idbRequest(tx.objectStore('objects').get(id)) as ContainerRecord | undefined;
    if (!record || record.state !== 'ready') throw missing();
    const key = JSON.stringify([id, referenceId]);
    if (!await idbRequest(tx.objectStore('references').get(key)))
      tx.objectStore('references').put({id: key, containerId: id, referenceId, fileName: record.fileName, importId: record.importId});
  });
}

/** Enumerate reference metadata for startup reconciliation; never scans chunk bytes. */
export async function listContainerImports(limit = 100, after?: string): Promise<{items: (ManagedContainer & {referenceId: string})[]; next?: string}> {
  limit = Math.min(500, Math.max(1, Math.floor(limit)));
  return bytesTransaction(['references', 'objects'], 'readonly', async tx => {
    const refs = await idbRequest(tx.objectStore('references').getAll(after ? IDBKeyRange.lowerBound(after, true) : undefined, limit + 1)) as {id: string; containerId: string; referenceId: string; fileName?: string; importId?: string}[];
    const more = refs.length > limit;
    if (more) refs.pop();
    const items: (ManagedContainer & {referenceId: string})[] = [];
    for (const reference of refs) {
      const object = await idbRequest(tx.objectStore('objects').get(reference.containerId)) as ContainerRecord | undefined;
      if (object?.state === 'ready') items.push({id: object.id, sha256: object.sha256, size: object.size, format: object.format,
        fileName: reference.fileName ?? object.fileName, importId: reference.importId, referenceId: reference.referenceId});
    }
    return {items, next: more ? refs.at(-1)?.id : undefined};
  });
}

/** Point lookup for one persisted import journal / current content. */
export async function listContainerReferences(referenceId: string): Promise<(ManagedContainer & {referenceId: string})[]> {
  return bytesTransaction(['references','objects'],'readonly',async tx=>{
    const references=await idbRequest(tx.objectStore('references').index('referenceId').getAll(referenceId)) as {containerId:string;fileName?:string;importId?:string}[];
    const items:(ManagedContainer & {referenceId:string})[]=[];
    for(const reference of references){
      const object=await idbRequest(tx.objectStore('objects').get(reference.containerId)) as ContainerRecord|undefined;
      if(object?.state==='ready')items.push({id:object.id,sha256:object.sha256,size:object.size,format:object.format,referenceId,fileName:reference.fileName??object.fileName,importId:reference.importId});
    }
    return items;
  });
}
async function collect(tx: IDBTransaction, id: string) {
  const objects = tx.objectStore('objects');
  const record = await idbRequest(objects.get(id)) as ContainerRecord | undefined;
  if (!record || await idbRequest(tx.objectStore('references').index('containerId').count(id))) return;
  const leases = await idbRequest(tx.objectStore('leases').index('containerId').getAll(id)) as Lease[];
  for (const lease of leases) if (lease.expiresAt <= Date.now()) tx.objectStore('leases').delete(lease.id);
  objects.put({...record, state: 'deleting'});
  if (leases.some(lease => lease.expiresAt > Date.now())) return;
  await removeChunks(tx, record.objectId);
  objects.delete(id);
}
export async function releaseContainer(id: string, referenceId: string) {
  await bytesTransaction(ALL, 'readwrite', async tx => {
    tx.objectStore('references').delete(JSON.stringify([id, referenceId]));
    await collect(tx, id);
  });
}

/** Opening a source holds a renewable read lease until close(). */
export async function openContainer(id: string): Promise<RandomAccessSource> {
  const leaseId = crypto.randomUUID();
  const record = await bytesTransaction(['objects', 'chunks', 'leases'], 'readwrite', async tx => {
    const objects = tx.objectStore('objects');
    const value = await idbRequest(objects.get(id)) as ContainerRecord | undefined;
    if (!value || value.state !== 'ready') return undefined;
    if (!await objectComplete(tx, value.objectId, value.size)) { objects.put({...value, availability: 'missing'}); return undefined; }
    tx.objectStore('leases').put({id: leaseId, containerId: id, generation: value.generation, expiresAt: Date.now() + LEASE_MS});
    return value;
  });
  if (!record) throw missing();
  let closed = false;
  const renew = async () => bytesTransaction(['leases', 'objects'], 'readwrite', async tx => {
    if (closed) return;
    const current = await idbRequest(tx.objectStore('objects').get(id)) as ContainerRecord | undefined;
    if (current?.generation === record.generation) tx.objectStore('leases').put({id: leaseId, containerId: id, generation: record.generation, expiresAt: Date.now() + LEASE_MS});
  });
  const timer = setInterval(() => { void renew().catch(() => {}); }, LEASE_MS / 3);
  const source: RandomAccessSource = {
    snapshot: {identity: id, version: record.sha256, size: record.size, local: true},
    async readAt(offset, length, signal) {
      throwIfAborted(signal); checkRange(source, offset, length);
      if (closed) throw new Error('源文件读取会话已关闭。');
      return bytesTransaction(['objects', 'chunks', 'leases'], 'readwrite', async tx => {
        const current = await idbRequest(tx.objectStore('objects').get(id)) as ContainerRecord | undefined;
        if (!current || current.generation !== record.generation) throw missing();
        tx.objectStore('leases').put({id: leaseId, containerId: id, generation: record.generation, expiresAt: Date.now() + LEASE_MS});
        const output = new Uint8Array(length);
        for (let cursor = offset; cursor < offset + length;) {
          throwIfAborted(signal);
          const chunk = await idbRequest(tx.objectStore('chunks').get(chunkId(record.objectId, Math.floor(cursor / CHUNK_SIZE)))) as ByteChunk | undefined;
          if (!chunk) throw missing();
          const start = cursor % CHUNK_SIZE, take = Math.min(chunk.bytes.byteLength - start, offset + length - cursor);
          if (take <= 0) throw missing();
          output.set(new Uint8Array(chunk.bytes, start, take), cursor - offset); cursor += take;
        }
        throwIfAborted(signal); return output;
      });
    },
    async validate(signal) {
      throwIfAborted(signal);
      if (closed) return 'unavailable';
      return bytesTransaction(['objects', 'chunks'], 'readonly', async tx => {
        const current = await idbRequest(tx.objectStore('objects').get(id)) as ContainerRecord | undefined;
        return current?.generation === record.generation && await objectComplete(tx, record.objectId, record.size) ? 'unchanged' : 'unavailable';
      });
    },
    async close() {
      if (closed) return; closed = true; clearInterval(timer);
      await bytesTransaction(ALL, 'readwrite', async tx => {
        tx.objectStore('leases').delete(leaseId);
        const current = await idbRequest(tx.objectStore('objects').get(id)) as ContainerRecord | undefined;
        if (current?.state === 'deleting') await collect(tx, id);
      });
    },
  };
  return source;
}

/** Bounded recovery visits registered stale operations only, never scans file bytes. */
export async function recoverContainerImports(limit = 20) {
  const operations = await bytesTransaction(['operations'], 'readonly', async tx =>
    idbRequest(tx.objectStore('operations').index('expiresAt').getAll(IDBKeyRange.upperBound(Date.now()), limit)) as Promise<ImportOperation[]>);
  const recovered: ManagedContainer[] = [];
  for (const op of operations) {
    if (op.state === 'bytesClosed') { try { recovered.push(await publish(op.id)); continue; } catch { /* Remove incomplete bytes below. */ } }
    await bytesTransaction(['operations', 'chunks'], 'readwrite', async tx => {
      const current = await idbRequest(tx.objectStore('operations').get(op.id)) as ImportOperation | undefined;
      if (!current || current.expiresAt > Date.now()) return;
      tx.objectStore('operations').delete(op.id); await removeChunks(tx, op.id);
    });
  }
  await bytesTransaction(ALL, 'readwrite', async tx => {
    const deleting = await idbRequest(tx.objectStore('objects').index('state').getAll('deleting', limit)) as ContainerRecord[];
    for (const record of deleting) await collect(tx, record.id);
  });
  return recovered;
}
