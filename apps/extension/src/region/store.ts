import {openSourceDatabase} from '../storage/database';
import {idbRequest} from '../storage/bytes/database';
import type {Page} from '../types';
import type {RegionRect} from './protocol';

export const REGION_BUDGET_BYTES=128*1024*1024;
export const REGION_MAX_RECORDS=32;
export interface RegionRecord {
  id:string;tabId:number;navigationId:string;generation:number;
  rect:RegionRect;width:number;height:number;sourceSha256:string;
  bytes:number;submitted:boolean;page?:Page;scope?:string;channelKey?:string;language?:string;inputIsSource?:boolean;
}
let opening:Promise<IDBDatabase>|undefined;
const open=()=>opening??=openSourceDatabase('region-inputs-v1',{
  records:{keyPath:'id',indexes:[{name:'tab',keyPath:'tabId',unique:true}]},
  blobs:{keyPath:null},state:{keyPath:'id'},
},()=>{opening=undefined;}).catch(error=>{opening=undefined;throw error;});
async function transaction<T>(mode:IDBTransactionMode,run:(tx:IDBTransaction)=>Promise<T>) {
  const tx=(await open()).transaction(['records','blobs','state'],mode);
  const done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('REGION_STORAGE_FAILED'));tx.onerror=()=>{};});
  try{const result=await run(tx);await done;return result;}
  catch(error){try{tx.abort();}catch{/* Already settled. */}await done.catch(()=>{});throw error;}
}
/** No LRU eviction: active screenshot bytes have no re-readable source. */
export async function saveRegion(record:RegionRecord,source?:Blob,input?:Blob) {
  await transaction('readwrite',async tx=>{
    const records=tx.objectStore('records'),blobs=tx.objectStore('blobs'),state=tx.objectStore('state');
    const previous=await idbRequest(records.index('tab').get(record.tabId)) as RegionRecord|undefined;
    if(!source&&previous?.id!==record.id)throw Error('REGION_SOURCE_MISSING');
    const usage=await idbRequest(state.get('usage')) as {id:string;bytes:number;count:number}|undefined;
    const bytes=(usage?.bytes??0)-(previous?.bytes??0)+record.bytes;
    const count=(usage?.count??0)+(previous?0:1);
    if(bytes>REGION_BUDGET_BYTES||count>REGION_MAX_RECORDS)throw Error('REGION_STORAGE_FULL');
    if(previous&&previous.id!==record.id){records.delete(previous.id);blobs.delete(previous.id+':source');blobs.delete(previous.id+':input');}
    if(source)blobs.put(source,record.id+':source');
    if(input&&!record.inputIsSource)blobs.put(input,record.id+':input');
    records.put(record);state.put({id:'usage',bytes,count});
  });
}
export async function readRegion(id:string):Promise<RegionRecord|undefined> {
  return transaction('readonly',tx=>idbRequest(tx.objectStore('records').get(id)));
}
export async function regionForTab(tabId:number):Promise<RegionRecord|undefined> {
  return transaction('readonly',tx=>idbRequest(tx.objectStore('records').index('tab').get(tabId)));
}
export async function readRegionBlob(record:RegionRecord,kind:'source'|'input'):Promise<Blob|undefined> {
  return transaction('readonly',async tx=>{
    const current=await idbRequest(tx.objectStore('records').get(record.id)) as RegionRecord|undefined;
    if(!current||current.navigationId!==record.navigationId)return undefined;
    return idbRequest(tx.objectStore('blobs').get(record.id+':'+(kind==='input'&&record.inputIsSource?'source':kind)));
  });
}
export async function removeRegion(tabId:number,id?:string) {
  await transaction('readwrite',async tx=>{
    const records=tx.objectStore('records'),state=tx.objectStore('state');
    const previous=await idbRequest(records.index('tab').get(tabId)) as RegionRecord|undefined;
    if(!previous||id&&previous.id!==id)return;
    const usage=await idbRequest(state.get('usage')) as {bytes:number;count:number}|undefined;
    records.delete(previous.id);tx.objectStore('blobs').delete(previous.id+':source');tx.objectStore('blobs').delete(previous.id+':input');
    state.put({id:'usage',bytes:Math.max(0,(usage?.bytes??0)-previous.bytes),count:Math.max(0,(usage?.count??0)-1)});
  });
}
/** At most 32 metadata rows; never loads screenshot blobs to discover abandoned documents. */
export async function listRegions():Promise<RegionRecord[]> {
  return transaction('readonly',tx=>idbRequest(tx.objectStore('records').getAll(undefined,REGION_MAX_RECORDS)));
}
