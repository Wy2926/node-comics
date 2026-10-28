import {openSourceDatabase} from '../../../../storage/database';
import type {CacheToken} from '../../../../storage/cache';
import type {Job} from '../../../../types';
import type {ShinobuConfig} from './config';
import type {TextBatch} from './text/protocol';
export interface LocalOperation {
  id:string;scope:string;entryId:string;pageId:string;profileId:string;profileRevision:number;
  fingerprint:string;config:ShinobuConfig;fontId:string;job:Job;previousResult?:Job;cacheToken:CacheToken;
}
export interface TextCheckpoint {id:string;entryId:string;fingerprint:string;plan:TextBatch[];batches:{state:'pending'|'sending'|'succeeded';result?:TextBatch}[];updatedAt:number;bytes:number;}
let database:Promise<IDBDatabase>|undefined;
const db=()=>database??=openSourceDatabase('shinobu-operations',{
  operations:{keyPath:'id',indexes:[{name:'entry',keyPath:['entryId','id']}]},
  inputs:{keyPath:'id'},checkpoints:{keyPath:'id',indexes:[{name:'expires',keyPath:'updatedAt'},{name:'entry',keyPath:'entryId'}]},state:{keyPath:'id'},
},()=>{database=undefined;});
async function tx<T>(table:string,mode:IDBTransactionMode,run:(s:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const database=await db();return new Promise((resolve,reject)=>{const t=database.transaction(table,mode),r=run(t.objectStore(table));t.oncomplete=()=>resolve(r.result);t.onabort=t.onerror=()=>reject(t.error??r.error);});
}
export const readOperation=(id:string)=>tx<LocalOperation|undefined>('operations','readonly',s=>s.get(id));
export const readInput=async(id:string)=>(await tx<{id:string;blob:Blob}|undefined>('inputs','readonly',s=>s.get(id)))?.blob;
export const releaseInput=(id:string)=>tx('inputs','readwrite',s=>s.delete(id));
export const readCheckpoint=(id:string)=>tx<TextCheckpoint|undefined>('checkpoints','readonly',s=>s.get(id));
export async function saveOperation(record:LocalOperation,replace=false,input?:Blob){
  const database=await db();await new Promise<void>((resolve,reject)=>{
    const t=database.transaction(['operations','state','inputs'],'readwrite'),s=t.objectStore('operations'),before=s.get(record.id),deleted=t.objectStore('state').get('entry:'+record.entryId);let stale=false;
    deleted.onsuccess=()=>{
      const old=before.result as LocalOperation|undefined;
      stale=!!deleted.result||!replace&&(!old||old.job.id!==record.job.id||old.job.status!=='running'&&record.job.status!==old.job.status);
      if(stale)return;
      s.put(record);if(input)t.objectStore('inputs').put({id:record.job.id,blob:input});
    };
    t.oncomplete=()=>stale?reject(Error('OPERATION_STALE')):resolve();t.onabort=t.onerror=()=>reject(t.error);
  });
}
export async function saveCheckpoint(record:TextCheckpoint){
  record={...record,updatedAt:Date.now()};record.bytes=new TextEncoder().encode(JSON.stringify(record)).length;
  const database=await db();await new Promise<void>((resolve,reject)=>{
    const t=database.transaction(['checkpoints','state'],'readwrite'),s=t.objectStore('checkpoints'),old=s.get(record.id),usage=t.objectStore('state').get('textBytes'),blocked=t.objectStore('state').get('entry:'+record.entryId);let error='';
    blocked.onsuccess=()=>{
      const bytes=(usage.result?.bytes??0)-(old.result?.bytes??0)+record.bytes;
      if(blocked.result||bytes>64*1024*1024){error=blocked.result?'OPERATION_STALE':'TEXT_STORAGE_FULL';return;}
      s.put(record);t.objectStore('state').put({id:'textBytes',bytes});
    };
    t.oncomplete=()=>error?reject(Error(error)):resolve();t.onabort=t.onerror=()=>reject(t.error);
  });
}
export async function clearCheckpoint(id:string){
  const database=await db();await new Promise<void>((resolve,reject)=>{
    const t=database.transaction(['checkpoints','state'],'readwrite'),s=t.objectStore('checkpoints'),old=s.get(id),usage=t.objectStore('state').get('textBytes');
    usage.onsuccess=()=>{s.delete(id);t.objectStore('state').put({id:'textBytes',bytes:Math.max(0,(usage.result?.bytes??0)-(old.result?.bytes??0))});};
    t.oncomplete=()=>resolve();t.onabort=t.onerror=()=>reject(t.error);
  });
}
export async function expireCheckpoints(){
  for(;;){const records=await tx<TextCheckpoint[]>('checkpoints','readonly',s=>s.index('expires').getAll(IDBKeyRange.upperBound(Date.now()-86400000),100));for(const r of records)await clearCheckpoint(r.id);if(records.length<100)return;}
}
export const entryOperations=(entryId:string,after?:string)=>tx<LocalOperation[]>('operations','readonly',s=>s.index('entry').getAll(IDBKeyRange.bound(after?[entryId,after]:[entryId],[entryId,[]],!!after),100));
export const blockEntry=(entryId:string)=>tx('state','readwrite',s=>s.put({id:'entry:'+entryId}));
export async function removeEntry(entryId:string){
  await blockEntry(entryId);
  for(;;){const records=await entryOperations(entryId);for(const r of records){await releaseInput(r.job.id);await clearCheckpoint(r.job.id);await tx('operations','readwrite',s=>s.delete(r.id));}if(records.length<100)break;}
  for(;;){const records=await tx<TextCheckpoint[]>('checkpoints','readonly',s=>s.index('entry').getAll(entryId,100));for(const r of records)await clearCheckpoint(r.id);if(records.length<100)break;}
}
