import {sourceNetworks} from '../registry/networks';
import {definitions} from '../registry/definitions';
import {resolveSource} from '../core/resolve';
import {validateCatalog} from '../core/catalog';
import {validatePages} from '../core/pages';
import {registerManifest} from './manifests';
import type {PageManifest,SourceCatalogSnapshot} from '../contracts/source';
import type {SourceNetwork} from '../contracts/network';
import {withImageHeaders} from './image-headers';
import {safeImageUrl} from '../shared/urls';

/** Select each operation independently; failures never switch transports implicitly. */
export function networkOperation<K extends keyof SourceNetwork>(url:string,operation:K) {
  const {definition,location}=resolveSource(url,definitions);
  if(!definition.capabilities.importable||!definition.capabilities[operation]||location.kind!==(operation==='catalog'?'catalog':'reader'))throw Error('SOURCE_OPERATION_UNSUPPORTED');
  return sourceNetworks[definition.id]?.[operation];
}
function networkContext(sourceUrl:string,signal?:AbortSignal){return {signal,async request(url:string,options?:{referer:string}){
  if(safeImageUrl(url,url)!==url)throw Error('来源请求地址无效。');
  if(options && (safeImageUrl(options.referer,options.referer)!==options.referer || new URL(options.referer).origin!==new URL(url).origin ||
    resolveSource(options.referer,definitions).definition.id!==resolveSource(sourceUrl,definitions).definition.id))throw Error('来源请求头归属无效。');
  const lifetime=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30_000)]);
  return withImageHeaders(url,options?{referer:options.referer}:undefined,lifetime,async()=>{
  const response=await fetch(url,{credentials:'include',redirect:'error',headers:{Accept:'application/json, text/html'},
    signal:lifetime});
  if(!response.ok)throw Error(`来源请求失败（HTTP ${response.status}），请稍后重试或在源站完成验证。`);
  if(!response.body)throw Error('来源响应为空。');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8*1024*1024)throw Error('来源响应超过限制。');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder().decode(bytes);
  });
}};}
export async function readNetworkCatalog(url:string,options:{signal?:AbortSignal;previous?:SourceCatalogSnapshot}={}){
  let {signal}=options;
  signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(120_000)]);
  const {location}=resolveSource(url,definitions),read=networkOperation(url,'catalog');
  if(!read)throw Error('SOURCE_CATALOG_UNSUPPORTED');
  const previous=options.previous&&validateCatalog(options.previous,definitions);
  if(previous&&previous.id!==location.catalog!.key)throw Error('SOURCE_CATALOG_CHANGED');
  const snapshot=validateCatalog(await read(url,{...networkContext(url,signal),previous}),definitions);
  if(snapshot.id!==location.catalog!.key||!snapshot.complete||!snapshot.groups.every(group=>group.complete))throw Error('SOURCE_CATALOG_CHANGED');
  signal?.throwIfAborted();
  return snapshot;
}
export async function readNetworkPages(url:string,signal?:AbortSignal):Promise<PageManifest>{
  signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(60_000)]);
  const {location}=resolveSource(url,definitions),read=networkOperation(url,'pages');
  if(!read)throw Error('SOURCE_COLLECTION_UNSUPPORTED');
  const snapshot=validatePages(await read(url,networkContext(url,signal)),location);
  signal?.throwIfAborted();
  return registerManifest({...snapshot,items:snapshot.items.map(({resource,...item})=>{
    if(resource.kind!=='http')throw Error('SOURCE_PAGES_INVALID');
    return {...item,url:resource.url,...(resource.processing?{processing:resource.processing}:{})};
  })});
}
