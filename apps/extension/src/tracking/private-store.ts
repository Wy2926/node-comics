export interface TrackingCredential {accountId: number; name: string; token: string; epoch: string; expiresAt: number}

function credential(value: unknown): TrackingCredential | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<TrackingCredential>;
  return Number.isSafeInteger(raw.accountId) && Number(raw.accountId) > 0 && typeof raw.name === 'string' && Boolean(raw.name)
    && typeof raw.token === 'string' && Boolean(raw.token) && raw.token.length <= 16_384 && !/\s/.test(raw.token)
    && typeof raw.epoch === 'string' && Boolean(raw.epoch) && typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt)
    ? raw as TrackingCredential : undefined;
}

// Extension-origin IndexedDB is not the website origin used by content scripts.
// Do not mirror this store into settings, storage.local/sync, exports or messages.
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('node-comics-tracking-auth', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('auth');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('auth', mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Tracking auth transaction aborted'));
      action(tx.objectStore('auth'), result => {value = result;});
    });
  } finally { db.close(); }
}
export function readPrivateTrackingCredential(): Promise<TrackingCredential | undefined> {
  return transaction('readonly', (store, result) => {
    const request = store.get('credential');
    request.onsuccess = () => result(credential(request.result));
  });
}
export function beginPrivateTrackingAuthorization(attempt: string): Promise<void> {
  return transaction('readwrite', store => {store.put(attempt, 'attempt');});
}
export function endPrivateTrackingAuthorization(attempt: string): Promise<void> {
  return transaction('readwrite', store => {
    const request = store.get('attempt');
    request.onsuccess = () => {if (request.result === attempt) store.delete('attempt');};
  });
}
export function commitPrivateTrackingCredential(attempt: string, value: TrackingCredential): Promise<TrackingCredential | undefined> {
  return transaction('readwrite', (store, result) => {
    const request = store.get('attempt');
    request.onsuccess = () => {
      if (request.result !== attempt) {result(undefined); return;}
      const current = store.get('credential');
      current.onsuccess = () => {
        const previous = credential(current.result);
        const saved = {...value, epoch: previous?.accountId === value.accountId ? previous.epoch : value.epoch};
        store.put(saved, 'credential');
        store.delete('attempt');
        result(saved);
      };
    };
  });
}
export function clearPrivateTrackingCredential(): Promise<void> {
  return transaction('readwrite', store => {store.clear();});
}
