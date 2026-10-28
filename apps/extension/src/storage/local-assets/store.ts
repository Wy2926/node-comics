import {openSourceDatabase} from '../database';
import {Sha256} from '../../importers/hash';

export interface LocalAsset {id:string;url:string;bytes:number;sha256:string;license:string;source:string;label:string;}
export type AssetState='missing'|'downloading'|'paused'|'verifying'|'ready'|'error';
export interface AssetRecord {id:string;offset:number;state:AssetState;etag?:string;error?:string;updatedAt:number;}
const CHUNK=1024*1024;
export const assetLock=(asset:LocalAsset)=>'nc-local-asset:'+asset.sha256;
let database:Promise<IDBDatabase>|undefined;
const db=()=>database??=openSourceDatabase('local-assets',{assets:{keyPath:'id'},chunks:{keyPath:['id','offset']}},()=>{database=undefined;});
async function transaction<T>(table:'assets'|'chunks',mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const database=await db();
  return new Promise((resolve,reject)=>{const tx=database.transaction(table,mode),r=action(tx.objectStore(table));tx.oncomplete=()=>resolve(r.result);tx.onabort=tx.onerror=()=>reject(tx.error??r.error);});
}
export const assetRecord=(asset:LocalAsset)=>transaction<AssetRecord|undefined>('assets','readonly',store=>store.get(asset.sha256));
const save=(record:AssetRecord)=>transaction('assets','readwrite',store=>store.put(record));
const keyRange=(id:string)=>IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]);
async function reset(asset:LocalAsset){
  await transaction('chunks','readwrite',store=>store.delete(keyRange(asset.sha256)));
  await save({id:asset.sha256,offset:0,state:'missing',updatedAt:Date.now()});
}
async function chunk(asset:LocalAsset,offset:number){
  const value=await transaction<{bytes:Uint8Array}|undefined>('chunks','readonly',store=>store.get([asset.sha256,offset]));
  if(!value)throw Error('ASSET_MISSING');return value.bytes;
}
async function writeChunk(asset:LocalAsset,bytes:Uint8Array,record:AssetRecord){
  const database=await db();
  await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction(['assets','chunks'],'readwrite');
    tx.objectStore('chunks').put({id:asset.sha256,offset:record.offset-bytes.length,bytes});
    tx.objectStore('assets').put(record);
    tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);
  });
}
async function verifyAsset(asset:LocalAsset,consume?:(bytes:Uint8Array<ArrayBuffer>)=>void){
  const record=await assetRecord(asset);
  if(!record||record.offset!==asset.bytes)throw Error('ASSET_MISSING');
  const hash=new Sha256();let total=0;
  while(total<asset.bytes){const bytes=await chunk(asset,total);if(!bytes.length||bytes.length>CHUNK||total+bytes.length>asset.bytes)throw Error('ASSET_CORRUPT');hash.update(bytes);consume?.(bytes as Uint8Array<ArrayBuffer>);total+=bytes.length;}
  if(hash.digest()!==asset.sha256)throw Error('ASSET_CORRUPT');
}
/** Caller holds a shared asset lease until all sessions and Blob URLs are released. */
export async function readAsset(asset:LocalAsset):Promise<Blob>{
  if((await assetRecord(asset))?.state!=='ready')throw Error('ASSET_MISSING');
  const parts:BlobPart[]=[];
  await verifyAsset(asset,bytes=>parts.push(new Blob([bytes])));
  return new Blob(parts);
}
export async function removeAsset(asset:LocalAsset){
  return navigator.locks.request(assetLock(asset),{ifAvailable:true},async lock=>{
    if(!lock)throw Error('ASSET_BUSY');await reset(asset);
  });
}
export async function recheckAsset(asset:LocalAsset){
  return navigator.locks.request(assetLock(asset),{ifAvailable:true},async lock=>{
    if(!lock)throw Error('ASSET_BUSY');
    try{await verifyAsset(asset);const record=(await assetRecord(asset))!;await save({...record,state:'ready',error:undefined,updatedAt:Date.now()});}
    catch(error){await reset(asset);await save({id:asset.sha256,offset:0,state:'error',error:'ASSET_CORRUPT',updatedAt:Date.now()});throw error;}
  });
}
export async function recordAssetFailure(asset:LocalAsset){
  await navigator.locks.request(assetLock(asset),{ifAvailable:true},async lock=>{
    if(!lock)return;const record=await assetRecord(asset);if(record?.state==='ready')return;
    await save({id:asset.sha256,offset:record?.offset??0,state:'error',error:'ASSET_DOWNLOAD_FAILED',updatedAt:Date.now()});
  });
}

/** Strict Range resume. No network read is issued until the previous chunk is durable. */
export async function downloadAsset(asset:LocalAsset,signal:AbortSignal,changed:()=>void,fetcher:typeof fetch=fetch){
  await navigator.locks.request('nc-local-asset-download',{signal},()=>navigator.locks.request(assetLock(asset),{signal},async()=>{
    let record=await assetRecord(asset)??{id:asset.sha256,offset:0,state:'missing' as AssetState,updatedAt:Date.now()};
    const notify=()=>{record.updatedAt=Date.now();changed();};
    if(record.state==='ready')return;
    try{
      if(record.offset===asset.bytes){
        await verifyAsset(asset);record.state='ready';await save(record);notify();return;
      }
      const controller=new AbortController();
      const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
      let timeout:ReturnType<typeof setTimeout>;
      const heartbeat=()=>{clearTimeout(timeout);timeout=setTimeout(()=>controller.abort(),30_000);};
      let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
      try{
        signal.throwIfAborted();heartbeat();
        const headers:Record<string,string>={};
        if(record.offset){headers.Range=`bytes=${record.offset}-`;if(record.etag)headers['If-Range']=record.etag;}
        const response=await fetcher(asset.url,{headers,signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});
        if(!response.ok||!response.body)throw Error('ASSET_DOWNLOAD_FAILED');
        if(response.status===206){
          const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range')??'');
          if(!range||Number(range[1])!==record.offset||Number(range[2])!==asset.bytes-1||Number(range[3])!==asset.bytes||response.headers.get('Content-Encoding'))throw Error('ASSET_RANGE_INVALID');
        }else if(response.status===200){
          if(record.offset){await reset(asset);record.offset=0;}
        }else throw Error('ASSET_RANGE_INVALID');
        const etag=response.headers.get('ETag');record.etag=etag&&!etag.startsWith('W/')?etag:undefined;
        record.state='downloading';record.error=undefined;await save(record);notify();
        reader=response.body.getReader();
        let buffer=new Uint8Array(CHUNK),used=0;
        for(;;){
          const {value,done}=await reader.read();if(done)break;heartbeat();
          if(record.offset+used+value.length>asset.bytes)throw Error('ASSET_SIZE_INVALID');
          for(let cursor=0;cursor<value.length;){
            const length=Math.min(CHUNK-used,value.length-cursor);buffer.set(value.subarray(cursor,cursor+length),used);used+=length;cursor+=length;
            if(used===CHUNK){record.offset+=used;await writeChunk(asset,buffer,record);notify();buffer=new Uint8Array(CHUNK);used=0;}
          }
        }
        if(record.offset+used!==asset.bytes)throw Error('ASSET_SIZE_INVALID');
        if(used){record.offset+=used;await writeChunk(asset,buffer.slice(0,used),record);}
      }finally{clearTimeout(timeout!);signal.removeEventListener('abort',abort);await reader?.cancel().catch(()=>{});}
      signal.throwIfAborted();record.state='verifying';await save(record);notify();
      await verifyAsset(asset);record.state='ready';await save(record);notify();
    }catch(error){
      record=await assetRecord(asset)??record;
      record.state=signal.aborted?'paused':'error';record.error=error instanceof DOMException&&error.name==='QuotaExceededError'?'ASSET_STORAGE_FULL':error instanceof Error&&/^ASSET_/.test(error.message)?error.message:'ASSET_DOWNLOAD_FAILED';
      if(record.error==='ASSET_CORRUPT'){await reset(asset);record.offset=0;}
      await save(record);notify();if(!signal.aborted)throw Error(record.error);
    }
  }));
}
