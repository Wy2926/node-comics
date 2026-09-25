import type {PageReference} from '../../../../comics/pages/identity';
import type {Job,TranslationInput,TranslationImage,TranslationSnapshot,Mode} from '../../../../types';
import {openSourceDatabase} from '../../../../storage/database';

export interface LocalOperation {id:string;requestId:string;scope:string;entryId:string;pageId:string;mode:Mode;language:string;image:TranslationImage;blobKey?:string;pageRef?:PageReference;request:TranslationInput;priority?:'current'|'prefetch';state:'local'|'uncertain'|'accepted'|'deferred'|'blocked';result?:TranslationSnapshot;error?:string;errorCode?:string;retryAt?:number;createdAt:number;}
export interface SyncState {id:string;jobs:Job[];imageRetryAt?:number;controlRetryAt?:number;}
let opening:Promise<IDBDatabase>|undefined;
function db(){return opening??=openSourceDatabase('translation-requests',{operations:{keyPath:'id',indexes:[{name:'scope',keyPath:'scope'}]},sync:{keyPath:'id'}},()=>{opening=undefined;}).catch(error=>{opening=undefined;throw error;});}
async function transaction<T>(name:string,mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction(name,mode);const request=action(tx.objectStore(name));tx.oncomplete=()=>resolve(request.result);tx.onabort=tx.onerror=()=>reject(tx.error);});}
export const translationScope=(origin:string,userId:string)=>JSON.stringify([origin,userId]);
export const readOperations=(scope:string)=>transaction<LocalOperation[]>('operations','readonly',s=>s.index('scope').getAll(scope));
export const readOperation=(id:string)=>transaction<LocalOperation|undefined>('operations','readonly',s=>s.get(id));
export async function saveOperation(value:LocalOperation){
  const result=value.result?{...value.result,result:value.result.result?{...value.result.result,download_url:undefined,download_expires_at:undefined}:value.result.result}:undefined;
  await transaction('operations','readwrite',s=>s.put({...value,result}));
}
export const readSync=(scope:string)=>transaction<SyncState|undefined>('sync','readonly',s=>s.get(scope));
export async function saveSync(value:SyncState){await transaction('sync','readwrite',s=>s.put(value));}
export async function withTranslationLock<T>(key:string,action:()=>Promise<T>):Promise<T>{return typeof navigator!=='undefined'&&navigator.locks?await navigator.locks.request('nc-translation:'+key,action):await action();}
