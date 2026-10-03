import {openSourceDatabase} from '../../../storage/database';
import type {ImageTransferReceipt} from './types';

let opening: Promise<IDBDatabase> | undefined;
function db() {
  return opening ??= openSourceDatabase('channel-transfers', {receipts: {keyPath: 'id'},tombstones:{keyPath:'id'}}, () => {opening = undefined;},undefined,undefined,{version:2,upgrade(tx,oldVersion){
    if(oldVersion!==1)throw Error('Unsupported channel transfers database version');
    tx.db.createObjectStore('tombstones',{keyPath:'id'});
  }})
    .catch(error => {opening = undefined; throw error;});
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('receipts', mode), request = action(tx.objectStore('receipts'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
export const readTransferReceipt = (id: string) => transaction<ImageTransferReceipt | undefined>('readonly', s => s.get(id));
export async function saveTransferReceipt(receipt: ImageTransferReceipt) {
  const database=await db();return new Promise<void>((resolve,reject)=>{
    const tx=database.transaction(['receipts','tombstones'],'readwrite'),removed=tx.objectStore('tombstones').get(receipt.id);let stale=false;
    removed.onsuccess=()=>{stale=!!removed.result;if(!stale)tx.objectStore('receipts').put(receipt);};
    tx.oncomplete=()=>stale?reject(Error('漫画已移除，请重新打开。')):resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
/** Known UUIDs only; never enumerate unrelated transfer inputs or outputs. */
export async function removeTransferReceipts(ids:readonly string[]):Promise<void>{
  if(!ids.length)return;
  const database=await db();await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction(['receipts','tombstones'],'readwrite');
    for(const id of new Set(ids)){tx.objectStore('tombstones').put({id,deletedAt:Date.now()});tx.objectStore('receipts').delete(id);}
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
/** Successful bytes move into the result cache before this transient copy is released. */
export async function releaseTransferBytes(id: string) {
  const receipt = await readTransferReceipt(id);
  if (receipt) await saveTransferReceipt({...receipt, input: undefined, output: undefined});
}
/** Crash leftovers have a bounded lifetime and budget; they are never replayed. */
export async function trimTransferReceipts() {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('receipts', 'readwrite'), store = tx.objectStore('receipts'), request = store.getAll();
    request.onsuccess = () => {
      const receipts = (request.result as ImageTransferReceipt[]).sort((a, b) => b.updatedAt - a.updatedAt);
      let bytes = 0;
      for (const receipt of receipts) {
        bytes += (receipt.input?.size ?? 0) + (receipt.output?.size ?? 0);
        if (Date.now() - receipt.updatedAt > 24 * 60 * 60 * 1000 || bytes > 256 * 1024 * 1024 && receipt.state !== 'running')
          store.delete(receipt.id);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
