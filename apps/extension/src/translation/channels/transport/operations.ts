import {openSourceDatabase, type DatabaseSchema} from '../../../storage/database';
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
export type DirectOperationOwner = Pick<DirectOperation, 'entryId' | 'pageId'>;
let opening: Promise<IDBDatabase> | undefined;
const schema:DatabaseSchema={
  operations:{keyPath:'id',indexes:[{name:'scope',keyPath:'scope'},{name:'entryId',keyPath:['entryId','id']}]},
  tombstones:{keyPath:'id'},
};
function db() {
  return opening ??= openSourceDatabase('channel-operations',schema, () => {opening = undefined;},undefined,undefined,{version:2,upgrade(tx,oldVersion){
    if(oldVersion!==1)throw Error('Unsupported channel operations database version');
    tx.objectStore('operations').createIndex('entryId',['entryId','id']);tx.db.createObjectStore('tombstones',{keyPath:'id'});
  }}).catch(error => {opening = undefined; throw error;});
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
export async function saveDirectOperation(operation: DirectOperation) {
  const database=await db();return new Promise<void>((resolve,reject)=>{
    const tx=database.transaction(['operations','tombstones'],'readwrite'),removed=tx.objectStore('tombstones').get(operation.entryId);let stale=false;
    removed.onsuccess=()=>{stale=!!removed.result;if(!stale)tx.objectStore('operations').put(operation);};
    tx.oncomplete=()=>stale?reject(Error('漫画已移除，请重新打开。')):resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}

/** Atomic attempt check: an old completion cannot overwrite a user-requested new attempt. */
export async function updateDirectOperation(operation: DirectOperation): Promise<DirectOperation> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['operations','tombstones'], 'readwrite'), store = tx.objectStore('operations'), request = store.get(operation.id);
    let result = operation,stale=false;
    request.onsuccess = () => {
      const saved = request.result as DirectOperation | undefined;
      const removed=tx.objectStore('tombstones').get(saved?.entryId??operation.entryId);
      removed.onsuccess=()=>{
        stale=!!removed.result;if(stale)return;
        const handedOff=!!saved&&saved.entryId!==operation.entryId;
        if(saved&&(saved.job.id!==operation.job.id||saved.job.status==='succeeded'&&operation.job.status!=='succeeded'
          ||handedOff&&(operation.job.status==='failed'||operation.job.status==='running'&&saved.job.status!=='running'))){result=saved;return;}
        // A late observer may settle the shared UUID, but cannot reclaim its deleted owner.
        result=saved?{...operation,entryId:saved.entryId,pageId:saved.pageId}:operation;
        store.put(result);
      };
    };
    tx.oncomplete = () => stale?reject(Error('漫画已移除，请重新打开。')):resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
/** Keep the same attempt and receipt while moving its sole local owner to another reading entry. */
export async function transferDirectOperation(operation:DirectOperation,owner:DirectOperationOwner):Promise<boolean>{
  if(owner.entryId===operation.entryId)return false;
  const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction(['operations','tombstones'],'readwrite'),store=tx.objectStore('operations');
    const current=store.get(operation.id),removed=tx.objectStore('tombstones').get(owner.entryId);let transferred=false;
    removed.onsuccess=()=>{
      const saved=current.result as DirectOperation|undefined;
      if(removed.result||!saved||saved.entryId!==operation.entryId||saved.job.id!==operation.job.id)return;
      store.put({...saved,...owner});transferred=true;
    };
    tx.oncomplete=()=>resolve(transferred);tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
export const readEntryDirectOperations=(entryId:string,after?:string)=>transaction<DirectOperation[]>('readonly',store=>store.index('entryId').getAll(IDBKeyRange.bound(after?[entryId,after]:[entryId],[entryId,[]],!!after),100));
/** Mark before collecting receipts: the host may finish while local deletion is recovering. */
export async function blockEntryDirectOperations(entryId:string):Promise<void>{
  const database=await db();await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction('tombstones','readwrite');tx.objectStore('tombstones').put({id:entryId,deletedAt:Date.now()});
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
export async function removeEntryDirectOperations(entryId:string):Promise<void>{
  await blockEntryDirectOperations(entryId);
  let count:number;
  do{count=(await transaction<DirectOperation[]>('readwrite',store=>{
    const rows=store.index('entryId').getAll(IDBKeyRange.bound([entryId],[entryId,[]]),100);
    rows.onsuccess=()=>{for(const row of rows.result as DirectOperation[])store.delete(row.id);};
    return rows;
  })).length;}while(count===100);
}
