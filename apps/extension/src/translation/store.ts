import type {Job,Mode,QuotaKind,SubmissionImage,SubmissionInput} from '../types';

export interface UploadItem {id:string;copyId:string;pageId:string;blobKey?:string;image:SubmissionImage;state:'local'|'uploading'|'verifying'|'accepted'|'failed';job?:Job;error?:string;}
export interface UploadManifest {automatic?:boolean;errorCode?:string;rightsVersion?:string;id:string;scope:string;title:string;mode:Mode;language:string;quotaKind:QuotaKind;maxQuotaPages:number;regenerate:boolean;rerunJobId?:string;acknowledgeUnknownCost?:boolean;readingSessionId?:string;continuous:boolean;paused:boolean;createdAt:number;items:UploadItem[];pending?:{key:string;body:SubmissionInput;submissionId?:string};error?:string;retryAt?:number;}
export interface SyncState {id:string;cursor?:string;jobs:Job[];}
let opening:Promise<IDBDatabase>;
function db(){return opening??=new Promise((resolve,reject)=>{const request=indexedDB.open('node-comics-translations',1);request.onupgradeneeded=()=>{request.result.createObjectStore('manifests',{keyPath:'id'}).createIndex('scope','scope');request.result.createObjectStore('sync',{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function operation<T>(name:string,mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction(name,mode);const request=action(tx.objectStore(name));tx.oncomplete=()=>resolve(request.result);tx.onabort=tx.onerror=()=>reject(tx.error);});}
export const translationScope=(origin:string,userId:string)=>JSON.stringify([origin,userId]);
export const readManifests=(scope:string)=>operation<UploadManifest[]>('manifests','readonly',s=>s.index('scope').getAll(scope));
export async function saveManifest(value:UploadManifest){await operation('manifests','readwrite',s=>s.put(value));}
export async function readManifest(id:string){return operation<UploadManifest|undefined>('manifests','readonly',s=>s.get(id));}
export const readSync=(scope:string)=>operation<SyncState|undefined>('sync','readonly',s=>s.get(scope));
export async function saveSync(value:SyncState){await operation('sync','readwrite',s=>s.put(value));}
export async function withManifestLock<T>(id:string,action:()=>Promise<T>):Promise<T|undefined>{
  if(typeof navigator!=='undefined'&&navigator.locks)return navigator.locks.request('nc-translation:'+id,{ifAvailable:true},lock=>lock?action():Promise.resolve(undefined));
  return action();
}
/** Local priority never modifies the frozen body of an uncertain server submission. */
export function orderLocalItems(items:UploadItem[],readingPageIds:string[]){const rank=new Map(readingPageIds.map((id,n)=>[id,n]));return [...items].sort((a,b)=>(rank.get(a.pageId)??Infinity)-(rank.get(b.pageId)??Infinity));}
/** Each chunk is atomic on the server; earlier accepted chunks survive later rejection. */
export function prepareChunk(manifest:UploadManifest,available:number,readingPageIds:string[]):UploadManifest {
  if(manifest.pending||manifest.paused)return manifest;
  const local=orderLocalItems(manifest.items.filter(i=>i.state==='local'),readingPageIds);
  if(!manifest.continuous&&local.length>available)return {...manifest,paused:true,error:`服务器当前仅有 ${available} 个空位，请缩小范围或确认持续补充。`};
  const selected=local.slice(0,Math.max(0,Math.min(manifest.continuous?32:500,available,manifest.automatic?1:manifest.maxQuotaPages)));
  if(!selected.length)return manifest;
  return {...manifest,error:undefined,pending:{key:crypto.randomUUID(),body:{mode:manifest.mode,target_language:manifest.language,max_quota_pages:Math.min(selected.length,manifest.maxQuotaPages),expected_kind:manifest.quotaKind,regenerate:manifest.regenerate,...(manifest.readingSessionId?{reading_session_id:manifest.readingSessionId}:{}),...(manifest.acknowledgeUnknownCost?{acknowledge_unknown_cost:true}:{}),...(manifest.rerunJobId?{rerun_job_id:manifest.rerunJobId}:{}),items:selected.map(i=>i.image)}}};
}
