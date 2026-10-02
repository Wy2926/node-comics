import type {PageReference} from '../../../../comics/pages/identity';
import type {Job,TranslationInput,TranslationImage,TranslationSnapshot,Mode} from '../../../../types';
import {openSourceDatabase, type DatabaseSchema} from '../../../../storage/database';
import {mergeJobs} from '../../../../reader/jobs';

export interface LocalOperation {id:string;requestId:string;scope:string;entryId:string;pageId:string;mode:Mode;language:string;image:TranslationImage;sourceSha256?:string;inputProfile?:'short-edge-1800-webp90-v1';inputSize?:{width:number;height:number};blobKey?:string;pageRef?:PageReference;request:TranslationInput;state:'local'|'uncertain'|'accepted'|'deferred'|'blocked';result?:TranslationSnapshot;error?:string;errorCode?:string;retryAt?:number;deniedPolicy?:string;deniedImageLimit?:number;createdAt:number;}
export interface SyncState {id:string;imageRetryAt?:number;controlRetryAt?:number;}
interface StoredJob {scope:string;id:string;sourceSha256?:string;job:Job;}
const storedJob=(scope:string,job:Job):StoredJob=>({scope,id:job.id,sourceSha256:job.source_image_sha256??job.image_sha256,job});
const schema:DatabaseSchema={
  operations:{keyPath:'id',indexes:[{name:'scope',keyPath:'scope'}]},sync:{keyPath:'id'},
  jobs:{keyPath:['scope','id'],indexes:[{name:'scopeImage',keyPath:['scope','sourceSha256']}]},
};
function upgrade(tx:IDBTransaction,oldVersion:number){
  if(oldVersion!==1)throw Error('Unsupported translation database version');
  const jobs=tx.db.createObjectStore('jobs',{keyPath:['scope','id']});
  jobs.createIndex('scopeImage',['scope','sourceSha256']);
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
}
let opening:Promise<IDBDatabase>|undefined;
function db(){return opening??=openSourceDatabase('translation-requests-overlay-v1',schema,()=>{opening=undefined;},undefined,undefined,{version:2,upgrade}).catch(error=>{opening=undefined;throw error;});}
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
  await transaction('operations','readwrite',s=>s.put(value));
}
/** Late state updates must not replace the page's newer request between a read and write. */
export async function updateOperation(value:LocalOperation):Promise<boolean>{
  const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction('operations','readwrite'),store=tx.objectStore('operations'),saved=store.get(value.id);let current=false;
    saved.onsuccess=()=>{current=saved.result?.requestId===value.requestId;if(current)store.put(value);};
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
    const tx=database.transaction(['operations','jobs'],'readwrite'),operations=tx.objectStore('operations'),jobs=tx.objectStore('jobs');
    const saved=operations.get(record.id),previous=jobs.get([record.scope,job.id]);let current=false;
    saved.onsuccess=()=>{current=!saved.result||saved.result.requestId===record.requestId;if(current)operations.put(record);};
    previous.onsuccess=()=>jobs.put(storedJob(record.scope,mergeJobs(previous.result?[(previous.result as StoredJob).job]:[],[job])[0]));
    tx.oncomplete=()=>resolve(current);tx.onabort=tx.onerror=()=>reject(tx.error);
  });
}
export async function withTranslationLock<T>(key:string,action:()=>Promise<T>):Promise<T>{return typeof navigator!=='undefined'&&navigator.locks?await navigator.locks.request('nc-translation:'+key,action):await action();}
