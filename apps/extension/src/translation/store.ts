import type {PageReference} from '../comics/pages/identity';
import type {Entitlements,Job,PlanItem,TranslationOperation,Mode,ReadingPriority} from '../types';
import {openSourceDatabase} from '../storage/database';

export interface LocalOperation {id:string;scope:string;entryId:string;pageId:string;blobKey?:string;pageRef?:PageReference;item:PlanItem;state:'local'|'uncertain'|'accepted'|'deferred'|'blocked';result?:TranslationOperation;error?:string;retryAt?:number;createdAt:number;}
export interface SyncState {id:string;cursor?:string;jobs:Job[];policyRevision?:string;entitlements?:Entitlements;imageLimit?:number;imageRetryAt?:number;controlRetryAt?:number;}
export interface ReadingSession {id:string;sessionId:string;sequence:number;signature?:string;priority:Partial<Record<Mode,ReadingPriority>>;}
let opening:Promise<IDBDatabase>|undefined;
function db(){return opening??=openSourceDatabase('content-operations',{operations:{keyPath:'id',indexes:[{name:'scope',keyPath:'scope'}]},sync:{keyPath:'id'},sessions:{keyPath:'id'}},()=>{opening=undefined;}).catch(error=>{opening=undefined;throw error;});}
async function transaction<T>(name:string,mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction(name,mode);const request=action(tx.objectStore(name));tx.oncomplete=()=>resolve(request.result);tx.onabort=tx.onerror=()=>reject(tx.error);});}
export const translationScope=(origin:string,userId:string)=>JSON.stringify([origin,userId]);
export const readOperations=(scope:string)=>transaction<LocalOperation[]>('operations','readonly',s=>s.index('scope').getAll(scope));
export const readOperation=(id:string)=>transaction<LocalOperation|undefined>('operations','readonly',s=>s.get(id));
export async function saveOperation(value:LocalOperation){await transaction('operations','readwrite',s=>s.put(value));}
export const readSync=(scope:string)=>transaction<SyncState|undefined>('sync','readonly',s=>s.get(scope));
export async function saveSync(value:SyncState){await transaction('sync','readwrite',s=>s.put(value));}
export const readSession=(id:string)=>transaction<ReadingSession|undefined>('sessions','readonly',s=>s.get(id));
export async function saveSession(value:ReadingSession){await transaction('sessions','readwrite',s=>s.put(value));}
export async function withTranslationLock<T>(key:string,action:()=>Promise<T>):Promise<T>{return typeof navigator!=='undefined'&&navigator.locks?await navigator.locks.request('nc-plan:'+key,action):await action();}
