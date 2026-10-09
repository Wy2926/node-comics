import type { TranslationResult } from '../../../shared/translation-images/types';
import { probeImageMetadata } from '../../../shared/translation-images/image-metadata';
import { TRANSLATION_MAX_DIMENSION } from '../../../shared/translation-images/limits';
export const SOURCE_MAX_DIMENSION = TRANSLATION_MAX_DIMENSION;
export type Mode = 'classic';
export interface Snapshot {
  id: string;
  state:
    | 'needs_input'
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'needs_attention';
  result?: TranslationResult;
  error?: { code: string; message: string };
}
// Server completion is not local completion until the full image is durable.
export function localSnapshotState(snapshot: Snapshot, hasResult: boolean) {
  return snapshot.state === 'succeeded' && !hasResult
    ? 'receiving'
    : snapshot.state;
}
export interface RecordMeta {
  id: string;
  scope: string;
  name: string;
  created: number;
  updated: number;
  state: string;
  mode: Mode;
  language: string;
  requestId?: string;
  /** Frozen with requestId; absence preserves the ordinary format of existing requests. */
  resultFormat?: 'overlay-tiles-v1';
  intent?: { retry_of: string } | { regenerate_of: string };
  width?: number;
  height?: number;
  sha256?: string;
  mime?: string;
  inputBytes?: number;
  bytes: number;
  error?: string;
  snapshot?: Snapshot;
}
export interface RecordData {
  id: string;
  source: Blob;
  input?: Blob;
  result?: Blob;
}
export function recordOrder(a: Pick<RecordMeta, 'created' | 'id'>, b: Pick<RecordMeta, 'created' | 'id'>) {
  return b.created - a.created || a.id.localeCompare(b.id);
}
const BUDGET = 256 * 1024 * 1024;
const MAX_RECORDS = 200;
let opening: Promise<IDBDatabase> | undefined;
function database() {
  return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nc-website-translations-v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const meta = db.createObjectStore('records', { keyPath: 'id' });
      meta.createIndex('scope', 'scope');
      db.createObjectStore('images', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        opening = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      opening = undefined;
      reject(Error('LOCAL_STORAGE_UNAVAILABLE'));
    };
    request.onblocked = () => reject(Error('LOCAL_STORAGE_UNAVAILABLE'));
  }));
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(Error('LOCAL_STORAGE_FULL'));
    transaction.onerror = () => reject(Error('LOCAL_STORAGE_FULL'));
  });
}
export async function listRecords(scopes: string[]) {
  const db = await database(),
    tx = db.transaction('records');
  const rows = await Promise.all(
    scopes.map((scope) =>
      result(
        tx
          .objectStore('records')
          .index('scope')
          .getAll(
            scope === 'guest:*'
              ? IDBKeyRange.bound('guest:', 'guest:\uffff')
              : scope,
          ),
      ),
    ),
  );
  return (rows.flat() as RecordMeta[]).sort(recordOrder);
}
export async function readImages(id: string): Promise<RecordData | undefined> {
  return result(
    (await database()).transaction('images').objectStore('images').get(id),
  );
}
export async function storageBytes() {
  const records = (await result(
    (await database()).transaction('records').objectStore('records').getAll(),
  )) as RecordMeta[];
  return records.reduce((sum, row) => sum + row.bytes, 0);
}
export async function saveRecord(meta: RecordMeta, data?: RecordData) {
  return saveRecords([{ meta, data }]);
}
async function saveRecords(records: { meta: RecordMeta; data?: RecordData }[]) {
  const db = await database();
  const tx = db.transaction(
    records.some(({ data }) => data) ? ['records', 'images'] : ['records'],
    'readwrite',
  );
  const committed = done(tx);
  const store = tx.objectStore('records');
  const all = (await result(store.getAll())) as RecordMeta[];
  const incoming = new Set(records.map(({ meta }) => meta.id));
  const bytes =
    all.reduce((sum, row) => sum + (incoming.has(row.id) ? 0 : row.bytes), 0) +
    records.reduce((sum, { meta }) => sum + meta.bytes, 0);
  const count =
    all.filter((row) => !incoming.has(row.id)).length + incoming.size;
  if (count > MAX_RECORDS || bytes > BUDGET) {
    tx.abort();
    await committed;
  } else {
    for (const { meta, data } of records) {
      store.put(meta);
      if (data) tx.objectStore('images').put(data);
    }
    await committed;
  }
  return bytes;
}
export async function removeRecord(id: string) {
  return removeRecords([id]);
}
/** Delete only the explicitly selected history, atomically with its image blobs. */
export async function removeRecords(ids: string[]) {
  if (!ids.length) return;
  const tx = (await database()).transaction(['records', 'images'], 'readwrite');
  const committed = done(tx);
  for (const id of new Set(ids)) {
    tx.objectStore('records').delete(id);
    tx.objectStore('images').delete(id);
  }
  await committed;
}
export function draftScope() {
  return 'draft:local';
}
export async function importImages(files: File[], scope = draftScope()) {
  if (!files.length || files.length > 10) throw Error('IMAGE_SELECTION_LIMIT');
  for (const file of files) {
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size > 32 * 1024 * 1024
    )
      throw Error('IMAGE_FORMAT_LIMIT');
    const metadata = await probeImageMetadata(file);
    if (!metadata) throw Error('IMAGE_FORMAT_LIMIT');
    if (Math.max(metadata.width, metadata.height) > SOURCE_MAX_DIMENSION)
      throw Error('IMAGE_DIMENSIONS_LIMIT');
  }
  const records = files.map((file) => {
    const id = crypto.randomUUID(),
      at = Date.now();
    return {
      meta: {
        id,
        scope,
        name: file.name || 'image',
        created: at,
        updated: at,
        state: 'draft',
        mode: 'classic' as const,
        language: 'zh-Hans',
        bytes: file.size,
      },
      data: { id, source: file },
    };
  });
  await saveRecords(records);
}
export function blobBytes(data: RecordData) {
  return (
    data.source.size +
    (data.input && data.input !== data.source ? data.input.size : 0) +
    (data.result?.size ?? 0)
  );
}
