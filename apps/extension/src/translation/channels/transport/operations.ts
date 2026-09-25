import {openSourceDatabase} from '../../../storage/database';
import type {Job} from '../../../types';
import type {CacheToken} from '../../../storage/cache';

export interface DirectOperation {
  id: string;
  scope: string;
  entryId: string;
  pageId: string;
  job: Job;
  previousResult?: Job;
  cacheToken?: CacheToken;
}
let opening: Promise<IDBDatabase> | undefined;
function db() {
  return opening ??= openSourceDatabase('channel-operations', {
    operations: {keyPath: 'id', indexes: [{name: 'scope', keyPath: 'scope'}]},
  }, () => {opening = undefined;}).catch(error => {opening = undefined; throw error;});
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('operations', mode), request = action(tx.objectStore('operations'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
export const readDirectOperations = (scope: string) => transaction<DirectOperation[]>('readonly', s => s.index('scope').getAll(scope));
export const readDirectOperation = (id: string) => transaction<DirectOperation | undefined>('readonly', s => s.get(id));
export async function saveDirectOperation(operation: DirectOperation) {await transaction('readwrite', s => s.put(operation));}

/** Atomic attempt check: an old completion cannot overwrite a user-requested new attempt. */
export async function updateDirectOperation(operation: DirectOperation): Promise<DirectOperation> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('operations', 'readwrite'), store = tx.objectStore('operations'), request = store.get(operation.id);
    let result = operation;
    request.onsuccess = () => {
      const saved = request.result as DirectOperation | undefined;
      if (saved && (saved.job.id !== operation.job.id || saved.job.status === 'succeeded' && operation.job.status !== 'succeeded')) result = saved;
      else store.put(operation);
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
