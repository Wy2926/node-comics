/** One immutable backend per new library. Never falls back or dual-writes. */
import { openSourceDatabase, sourceDatabaseName, SourceDatabaseSchemaError, type DatabaseSchema } from '../database';
export const BYTE_DATABASE = sourceDatabaseName('container-bytes');
export const CHUNK_SIZE = 1024 * 1024;
export const BYTE_BACKEND = 'chunked-idb-v1';
const schema: DatabaseSchema = {
  objects: {keyPath:'id',indexes:[{name:'state',keyPath:'state'}]},
  chunks: {keyPath:'id',indexes:[{name:'objectId',keyPath:'objectId'}]},
  operations: {keyPath:'id',indexes:[{name:'expiresAt',keyPath:'expiresAt'}]},
  references: {keyPath:'id',indexes:[{name:'containerId',keyPath:'containerId'},{name:'referenceId',keyPath:'referenceId'}]},
  leases: {keyPath:'id',indexes:[{name:'containerId',keyPath:'containerId'}]},
  settings: {keyPath:'id'},
};
let pending: Promise<IDBDatabase> | undefined;
export function byteDatabase(): Promise<IDBDatabase> {
  return pending ??= openSourceDatabase('container-bytes', schema, () => { pending = undefined; }, tx => {
    tx.objectStore('settings').put({id:'backend',value:BYTE_BACKEND});
  }, async database => {
    const backend = await idbRequest(database.transaction('settings').objectStore('settings').get('backend'));
    if (backend?.value !== BYTE_BACKEND) throw new SourceDatabaseSchemaError(database.name, '源文件字节格式不匹配');
  }).catch(error => { pending = undefined; throw error; });
}
export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export async function bytesTransaction<T>(names: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = (await byteDatabase()).transaction(names, mode);
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('源文件存储事务已中止。')); tx.onerror = () => {}; });
  try { const value = await run(tx); await done; return value; }
  catch (error) { try { tx.abort(); } catch { /* Already aborted. */ } await done.catch(() => {}); throw error; }
}
export interface ByteChunk { id: string; objectId: string; ordinal: number; bytes: ArrayBuffer }
export const chunkId = (objectId: string, ordinal: number) => `${objectId}:${ordinal}`;
export async function removeChunks(tx: IDBTransaction, objectId: string) {
  const store = tx.objectStore('chunks');
  const keys = await idbRequest(store.index('objectId').getAllKeys(objectId));
  for (const key of keys) store.delete(key);
}
export async function objectComplete(tx: IDBTransaction, objectId: string, size: number) {
  const store = tx.objectStore('chunks');
  const count = Math.ceil(size / CHUNK_SIZE);
  if (await idbRequest(store.index('objectId').count(objectId)) !== count) return false;
  // Chunk publication is atomic and fixed-size. Inspect endpoints, not all file bytes.
  const first = await idbRequest(store.get(chunkId(objectId, 0))) as ByteChunk | undefined;
  const last = await idbRequest(store.get(chunkId(objectId, count - 1))) as ByteChunk | undefined;
  return first?.bytes.byteLength === Math.min(size, CHUNK_SIZE) && last?.bytes.byteLength === size - (count - 1) * CHUNK_SIZE;
}
