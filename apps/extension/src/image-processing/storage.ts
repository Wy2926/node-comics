import {ByteCache, type CacheToken} from '../storage/cache';
import {openSourceDatabase} from '../storage/database';
import {readProcessingSettings, subscribeProcessingSettings, updateProcessingSettings} from './settings';
import {readTransferReceipt, removeTransferReceipts, releaseTransferBytes} from '../image-transfer/receipts';
import {registerTransferFinalizer, type ImageTransferReceipt} from '../image-transfer/types';

export const processingCache = new ByteCache({name: 'image-processing-results', budgetBytes: 512 * 1024 * 1024});
export interface ProcessingRecord {
  id: string; lookupKey: string; owner: string; profileId: string; requestId: string;
  state: 'running' | 'succeeded' | 'failed'; errorCode?: string; token: CacheToken;
}
interface ServiceLane {id: string; requestId: string; settled?: boolean;}
let opening: Promise<IDBDatabase> | undefined, ready: Promise<void> | undefined;
const recordSchema = {keyPath: 'id', indexes: ['owner', 'profileId', 'lookupKey', 'requestId'].map(name => ({name, keyPath: name}))};
const db = () => opening ??= openSourceDatabase('image-processing-requests', {
  records: recordSchema,
  lanes: {keyPath: 'id'},
  tombstones: {keyPath: 'id'},
}, () => {opening = undefined;}, undefined, undefined, {version: 2, upgrade(tx) {
  // Discard old request identities. No legacy lookup or cache migration is supported.
  tx.db.deleteObjectStore('records');
  const records = tx.db.createObjectStore('records', {keyPath: recordSchema.keyPath});
  for (const index of recordSchema.indexes) records.createIndex(index.name, index.keyPath);
}}).catch(error => {opening = undefined; throw error;});
async function transaction<T>(store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, mode), request = run(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result); tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export const findProcessingRecord = (lookupKey: string) => transaction<ProcessingRecord | undefined>('records', 'readonly', store => store.index('lookupKey').get(lookupKey));
export async function saveProcessingRecord(record: ProcessingRecord) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['records', 'tombstones'], 'readwrite');
    let blocked = false, pending = 2;
    for (const id of ['owner:' + record.owner, 'profile:' + record.profileId]) {
      const check = tx.objectStore('tombstones').get(id);
      check.onsuccess = () => {
        blocked ||= !!check.result;
        if (--pending === 0 && !blocked) {
          const records = tx.objectStore('records'), previous = records.index('lookupKey').getKey(record.lookupKey);
          previous.onsuccess = () => {
            if (previous.result && previous.result !== record.id) records.delete(previous.result);
            records.put(record);
          };
        }
      };
    }
    tx.oncomplete = () => blocked ? reject(new DOMException('Enhancement removed', 'AbortError')) : resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export const blockProcessingOwner = (owner: string) => transaction('tombstones', 'readwrite', store => store.put({id: 'owner:' + owner}));
export const readServiceLane = (id: string) => transaction<ServiceLane | undefined>('lanes', 'readonly', store => store.get(id));
export const saveServiceLane = (lane: ServiceLane) => transaction('lanes', 'readwrite', store => store.put(lane));
/** Preserve a known terminal outcome before deleting its receipt, without overwriting a newer request. */
export async function settleServiceLane(receipt?: ImageTransferReceipt) {
  if (!receipt || !['succeeded', 'failed'].includes(receipt.state) || receipt.errorCode === 'INTERRUPTED'
    || !receipt.scope.startsWith('enhancement:')) return;
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('lanes', 'readwrite'), store = tx.objectStore('lanes');
    const request = store.get(receipt.scope.slice('enhancement:'.length));
    request.onsuccess = () => {
      const lane = request.result as ServiceLane | undefined;
      if (lane?.requestId === receipt.id && !lane.settled) store.put({...lane, settled: true});
    };
    tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export async function initializeProcessingCache() {
  return ready ??= (async () => {
    const refresh = async () => processingCache.setBudget((await readProcessingSettings()).cacheLimitMb * 1024 * 1024);
    await refresh(); subscribeProcessingSettings(() => {void refresh().catch(() => {});});
  })().catch(error => {ready = undefined; throw error;});
}
export async function processingTokenCurrent(record: ProcessingRecord) {
  const current = await processingCache.token(record.owner, record.id);
  return current.epoch === record.token.epoch && current.ownerGeneration === record.token.ownerGeneration
    && (current.keyGeneration ?? 0) <= (record.token.keyEpoch ?? 0);
}
/** Idempotent across host completion and reader recovery; does not need parent pixels. */
export async function finalizeProcessingReceipt(receipt: ImageTransferReceipt) {
  if (!receipt.scope.startsWith('enhancement:') || !['succeeded', 'failed'].includes(receipt.state)) return;
  const run = async () => {
    await settleServiceLane(receipt);
    const record = await transaction<ProcessingRecord | undefined>('records', 'readonly', store => store.index('requestId').get(receipt.id));
    if (!record || record.state !== 'running') return;
    await initializeProcessingCache();
    const blob = receipt.output;
    let errorCode = receipt.errorCode, persisted = false;
    if (receipt.state === 'succeeded') {
      if (!blob || !await processingTokenCurrent(record)) errorCode = 'RESULT_MISSING';
      else persisted = await processingCache.put(record.id, blob, {owner: record.owner, connectionId: record.profileId, token: record.token});
    } else errorCode ??= 'INTERRUPTED';
    await saveProcessingRecord({...record, state: errorCode ? 'failed' : 'succeeded', errorCode});
    // If disk admission fails, the bounded transfer receipt still delivers the image once.
    // It is not a second enhancement cache: the display reader consumes those bytes.
    if (persisted || errorCode) await releaseTransferBytes(receipt.id);
  };
  if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request('nc-enhancement-result:' + receipt.id, run);
  else await run();
}
registerTransferFinalizer(finalizeProcessingReceipt);
export async function clearProcessingCache() {
  await processingCache.clear();
  // Keep receipts: losing cached bytes must never silently rerun an image service.
  await updateProcessingSettings(value => ({...value, cacheRevision: crypto.randomUUID()}));
}
async function removeRecords(index: 'owner' | 'profileId', value: string) {
  for (;;) {
    const records = await transaction<ProcessingRecord[]>('records', 'readonly', store => store.index(index).getAll(value, 100));
    if (!records.length) return;
    for (const record of records) {
      if (record.state === 'running') await settleServiceLane(await readTransferReceipt(record.requestId));
      // A connection-wide ByteCache clear fences every writer. Only this profile's keys may be invalidated.
      if (index === 'profileId') await processingCache.delete(record.id);
    }
    await removeTransferReceipts(records.map(record => record.requestId));
    await transaction('records', 'readwrite', store => {
      for (const record of records.slice(0, -1)) store.delete(record.id);
      return store.delete(records[records.length - 1].id);
    });
  }
}
export async function removeProcessingOwner(owner: string) {
  await blockProcessingOwner(owner);
  await processingCache.deleteOwner(owner, true); await removeRecords('owner', owner);
}
export async function removeProcessingProfile(id: string) {
  await transaction('tombstones', 'readwrite', store => store.put({id: 'profile:' + id}));
  await updateProcessingSettings(value => ({...value, enabled: value.activeId === id ? false : value.enabled,
    activeId: value.activeId === id ? '' : value.activeId, profiles: value.profiles.filter(profile => profile.id !== id)}));
  await removeRecords('profileId', id);
}
