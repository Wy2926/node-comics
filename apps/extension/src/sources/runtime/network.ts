import {sourceNetworks} from '../registry/networks';
import {definitions} from '../registry/definitions';
import {resolveSource} from '../core/resolve';
import {validateCatalog} from '../core/catalog';
import {validatePages} from '../core/pages';
import {registerManifest} from './manifests';
import type {PageManifest,PageSnapshot,SourceCatalogSnapshot} from '../contracts/source';
import {createSourceNetworkContext as networkContext} from './http';
import {withPageNetworkContext} from './page-network';
import {importResponseLimits,rememberImportResponses,takeImportResponses,type ImportResponse} from './import-responses';

/** Select each operation independently; failures never switch transports implicitly. */
export function networkOperation<K extends 'catalog'|'pages'>(url:string,operation:K) {
  const {definition,location}=resolveSource(url,definitions);
  if(!definition.capabilities.importable||!definition.capabilities[operation]||location.kind!==(operation==='catalog'?'catalog':'reader'))throw Error('SOURCE_OPERATION_UNSUPPORTED');
  return sourceNetworks[definition.id]?.[operation];
}
/** Resolve missing parent identity through the owning adapter, without opening a source tab. */
export async function resolveNetworkCatalog(url:string,signal?:AbortSignal):Promise<string|undefined>{
  const {definition,location}=resolveSource(url,definitions);
  if(!definition.capabilities.importable||!definition.capabilities.catalog||location.kind!=='reader')return;
  if(location.catalog)return location.catalog.url;
  const resolve=sourceNetworks[definition.id]?.resolveCatalog;
  if(!resolve)return;
  signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const context=networkContext(url,signal),responses:ImportResponse[]=[];
  let retained=0;
  const target=await resolve(url,{...context,async request(target,options){
    const body=await context.request(target,options);
    if(options?.form===undefined){
      retained+=body.length*2;
      if(retained<=importResponseLimits.bytes&&responses.length<importResponseLimits.count)responses.push({url:target,referer:options?.referer,body});
    }
    return body;
  }});
  signal.throwIfAborted();
  const parent=resolveSource(target,definitions);
  if(parent.definition.id!==definition.id||parent.location.kind!=='catalog'||!parent.location.catalog)
    throw Error('SOURCE_CATALOG_CHANGED');
  await rememberImportResponses(location,parent.location.catalog.key,responses,signal);
  signal.throwIfAborted();
  return parent.location.catalog.url;
}
export async function readNetworkCatalog(url:string,options:{signal?:AbortSignal;previous?:SourceCatalogSnapshot;onCatalogProgress?:(snapshot:SourceCatalogSnapshot)=>Promise<void>}={}){
  let {signal}=options;
  signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(120_000)]);
  signal.throwIfAborted();
  const {definition,location}=resolveSource(url,definitions),read=networkOperation(url,'catalog');
  if(!read)throw Error('SOURCE_CATALOG_UNSUPPORTED');
  const previous=options.previous&&validateCatalog(options.previous,definitions);
  if(previous&&previous.id!==location.catalog!.key)throw Error('SOURCE_CATALOG_CHANGED');
  const onCatalogProgress=options.onCatalogProgress ? async (value:SourceCatalogSnapshot)=>{
    signal.throwIfAborted();
    const snapshot=validateCatalog(value,definitions);
    if(snapshot.id!==location.catalog!.key||snapshot.complete)throw Error('SOURCE_CATALOG_CHANGED');
    await options.onCatalogProgress!(snapshot);
    signal.throwIfAborted();
  }:undefined;
  const value=sourceNetworks[definition.id]?.pageTransport?.includes('catalog')
    ?await withPageNetworkContext(url,signal,context=>read(url,{...context,previous,onCatalogProgress}))
    :await read(url,{...networkContext(url,signal),previous,onCatalogProgress});
  const snapshot=validateCatalog(value,definitions);
  if(snapshot.id!==location.catalog!.key||!snapshot.complete||!snapshot.groups.every(group=>group.complete))throw Error('SOURCE_CATALOG_CHANGED');
  signal?.throwIfAborted();
  return snapshot;
}
export async function readNetworkPages(url:string,signal?:AbortSignal):Promise<PageManifest>{
  signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(60_000)]);
  const {definition,location}=resolveSource(url,definitions),read=networkOperation(url,'pages');
  if(!read)throw Error('SOURCE_COLLECTION_UNSUPPORTED');
  const value=sourceNetworks[definition.id]?.pageTransport?.includes('pages')
    ?await withPageNetworkContext(url,signal,context=>read(url,context))
    :await read(url,networkContext(url,signal,await takeImportResponses(location,signal)));
  const snapshot=validatePages(value,location);
  signal?.throwIfAborted();
  const manifest:PageSnapshot={adapter:snapshot.adapter,url:snapshot.url,title:snapshot.title,direction:snapshot.direction,
    discoveryComplete:snapshot.discoveryComplete,knownTotal:snapshot.knownTotal,note:snapshot.note,
    items:snapshot.items.map(({resource,id,contentKey,width,height,order})=>{
    if(resource.kind!=='http')throw Error('SOURCE_PAGES_INVALID');
    return {id,contentKey,url:resource.url,width,height,order,processing:resource.processing};
  })};
  if(manifest.items.length&&manifest.items.every(item=>item.contentKey!==undefined)){
    // Equal renewable HTTP observations share one immutable record. A changed URL,
    // page slot, recipe or content key gets another ID, preserving in-flight locators.
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(manifest)));
    signal?.throwIfAborted();
    const id='network-sha256:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    return registerManifest(manifest,{id});
  }
  return registerManifest(manifest);
}
