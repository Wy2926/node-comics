import type {PageReference} from '../../../../comics/pages/identity';
import type {Job,TranslationInput,TranslationImage,TranslationSnapshot,Mode} from '../../../../types';
import type {InputProfile} from '../../../input/limits';
import {openSourceDatabase, type DatabaseSchema} from '../../../../storage/database';
import {mergeJobs} from '../../../../reader/jobs';

export interface LocalOperation {id:string;requestId:string;scope:string;entryId:string;pageId:string;mode:Mode;language:string;image:TranslationImage;sourceSha256?:string;inputProfile?:InputProfile;inputSize?:{width:number;height:number};blobKey?:string;pageRef?:PageReference;request:TranslationInput;state:'local'|'uncertain'|'accepted'|'deferred'|'blocked';result?:TranslationSnapshot;error?:string;errorCode?:string;retryAt?:number;deniedPolicy?:string;deniedImageLimit?:number;createdAt:number;}
export interface SyncState {id:string;imageRetryAt?:number;controlRetryAt?:number;}
interface StoredJob {scope:string;id:string;sourceSha256?:string;job:Job;}
const storedJob=(scope:string,job:Job):StoredJob=>({scope,id:job.id,sourceSha256:job.source_image_sha256??job.image_sha256,job});
const schema:DatabaseSchema={
  operations:{keyPath:'id',indexes:[{name:'scope',keyPath:'scope'},{name:'entryId',keyPath:['entryId','id']}]},sync:{keyPath:'id'},
  jobs:{keyPath:['scope','id'],indexes:[{name:'scopeImage',keyPath:['scope','sourceSha256']},{name:'scopeImageJob',keyPath:['scope','sourceSha256','id']}]},
  tombstones:{keyPath:'id'},
};
function upgrade(tx:IDBTransaction,oldVersion:number){
  if(oldVersion!==1&&oldVersion!==2)throw Error('Unsupported translation database version');
  tx.objectStore('operations').createIndex('entryId',['entryId','id']);
  tx.db.createObjectStore('tombstones',{keyPath:'id'});
  if(oldVersion===1){
    const jobs=tx.db.createObjectStore('jobs',{keyPath:['scope','id']});
    jobs.createIndex('scopeImage',['scope','sourceSha256']);
    jobs.createIndex('scopeImageJob',['scope','sourceSha256','id']);
    const cursor=tx.objectStore('sync').openCursor();
    cursor.onsuccess=()=>{
      const row=cursor.result;if(!row)return;
      try{
        const value=row.value as SyncState&{jobs?:Job[]};
        if(Array.isArray(value.jobs)){
          for(const job of value.jobs)jobs.put(storedJob(value.id,job));
          const control={...value};delete control.jobs;row.update(control);
        }
        row.continue();
      }catch{tx.abort();}
    };
  }else tx.objectStore('jobs').createIndex('scopeImageJob',['scope','sourceSha256','id']);
}
let opening:Promise<IDBDatabase>|undefined;
function db(){return opening??=openSourceDatabase('translation-requests-overlay-v1',schema,()=>{opening=undefined;},undefined,undefined,{version:3,upgrade}).catch(error=>{opening=undefined;throw error;});}
async function transaction<T>(name:string,mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction(name,mode);const request=action(tx.objectStore(name));tx.oncomplete=()=>resolve(request.result);tx.onabort=tx.onerror=()=>reject(tx.error);});}
export const translationScope=(origin:string,userId:string)=>JSON.stringify([origin,userId,'overlay-v1']);
export async function readOperations(ids:readonly string[]):Promise<LocalOperation[]>{
  if(!ids.length)return [];
  const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction('operations'),store=tx.objectStore('operations'),requests=[...new Set(ids)].map(id=>store.get(id));
    tx.oncomplete=()=>resolve(requests.flatMap(request=>request.result?[request.result as LocalOperation]:[]));tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
export const readOperation=(id:string)=>transaction<LocalOperation|undefined>('operations','readonly',s=>s.get(id));
export async function saveOperation(value:LocalOperation){
  const database=await db();return new Promise<void>((resolve,reject)=>{
    const tx=database.transaction(['operations','tombstones'],'readwrite'),removed=tx.objectStore('tombstones').get(value.entryId);let stale=false;
    removed.onsuccess=()=>{stale=!!removed.result;if(!stale)tx.objectStore('operations').put(value);};
    tx.oncomplete=()=>stale?reject(Error('漫画已移除，请重新打开。')):resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
/** Late state updates must not replace the page's newer request between a read and write. */
export async function updateOperation(value:LocalOperation):Promise<boolean>{
  const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction(['operations','tombstones'],'readwrite'),store=tx.objectStore('operations'),saved=store.get(value.id),removed=tx.objectStore('tombstones').get(value.entryId);let current=false;
    removed.onsuccess=()=>{current=!removed.result&&saved.result?.requestId===value.requestId;if(current)store.put(value);};
    tx.oncomplete=()=>resolve(current);tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
export const readSync=(scope:string)=>transaction<SyncState|undefined>('sync','readonly',s=>s.get(scope));
export async function saveSync(value:SyncState){await transaction('sync','readwrite',s=>s.put(value));}
/** Only current images/known UUIDs are read; old UUIDs remain durable and account-scoped. */
export async function readJobs(scope:string,hashes:readonly string[],ids:readonly string[]=[]):Promise<Job[]>{
  if(!hashes.length&&!ids.length)return [];
  const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction('jobs'),store=tx.objectStore('jobs');
    const groups=[...new Set(hashes)].map(sha=>store.index('scopeImage').getAll([scope,sha]));
    const singles=[...new Set(ids)].map(id=>store.get([scope,id]));
    tx.oncomplete=()=>resolve(mergeJobs([],groups.flatMap(request=>(request.result as StoredJob[]).map(row=>row.job)).concat(singles.flatMap(request=>request.result?[(request.result as StoredJob).job]:[]))));
    tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
/** Receipt and its display history commit together; late receipts cannot replace a newer intent. */
export async function saveReceipt(record:LocalOperation,job:Job):Promise<boolean>{
  const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction(['operations','jobs','tombstones'],'readwrite'),operations=tx.objectStore('operations'),jobs=tx.objectStore('jobs');
    const saved=operations.get(record.id),previous=jobs.get([record.scope,job.id]),removed=tx.objectStore('tombstones').get(record.entryId);let current=false,stale=false;
    removed.onsuccess=()=>{
      stale=!!removed.result;if(stale)return;
      current=!saved.result||saved.result.requestId===record.requestId;if(current)operations.put(record);
      jobs.put(storedJob(record.scope,mergeJobs(previous.result?[(previous.result as StoredJob).job]:[],[job])[0]));
    };
    // A removed page must not publish its new job to a reader that could start another download.
    tx.oncomplete=()=>stale?reject(Error('漫画已移除，请重新打开。')):resolve(current);tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
/** Entry-local cursor pages never read another book's requests or frozen input metadata. */
export async function readEntryOperations(entryId:string,after?:string):Promise<LocalOperation[]>{
  return transaction<LocalOperation[]>('operations','readonly',store=>store.index('entryId').getAll(IDBKeyRange.bound(after?[entryId,after]:[entryId],[entryId,[]],!!after),100));
}
/** Source cleanup visits one image's account-local history in bounded keyset pages. */
export async function readImageJobsPage(scope:string,imageSha256:string,after?:string):Promise<Job[]>{
  const rows=await transaction<StoredJob[]>('jobs','readonly',store=>store.index('scopeImageJob').getAll(IDBKeyRange.bound(after?[scope,imageSha256,after]:[scope,imageSha256],[scope,imageSha256,[]],!!after),100));
  return rows.map(row=>row.job);
}
/** The fence and each bounded deletion page commit together; repeated cleanup is safe. */
export async function blockEntryOperations(entryId:string):Promise<void>{
  const database=await db();await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction('tombstones','readwrite');tx.objectStore('tombstones').put({id:entryId,deletedAt:Date.now()});
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
export async function removeEntryOperations(entryId:string):Promise<void>{
  const database=await db();let count:number;
  do{count=await new Promise<number>((resolve,reject)=>{
    const tx=database.transaction(['operations','tombstones'],'readwrite'),store=tx.objectStore('operations');
    tx.objectStore('tombstones').put({id:entryId,deletedAt:Date.now()});
    const rows=store.index('entryId').getAll(IDBKeyRange.bound([entryId],[entryId,[]]),100);
    rows.onsuccess=()=>{for(const row of rows.result as LocalOperation[])store.delete(row.id);};
    tx.oncomplete=()=>resolve(rows.result.length);tx.onabort=tx.onerror=()=>reject(tx.error);
  });}while(count===100);
}
export async function withTranslationLock<T>(key:string,action:()=>Promise<T>):Promise<T>{return typeof navigator!=='undefined'&&navigator.locks?await navigator.locks.request('nc-translation:'+key,action):await action();}
