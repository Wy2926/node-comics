import type {DocumentSnapshot, PageManifest, PageSnapshot, SourceSnapshot} from '../contracts/source';
import {validatePages} from '../core/pages';
import {resolveSource} from '../core/resolve';
import {definitions} from '../registry/definitions';
import {isPageImageUrl} from '../shared/urls';

/** Both discovery transports pass through the same validation and registration boundary. */
export async function registerManifest(snapshot:PageSnapshot, options:{id?:string; revision?:number; pageContext?:PageManifest['pageContext']}={}) {
  const {definition,location}=resolveSource(snapshot.url,definitions);
  if(!definition.capabilities.importable || !definition.capabilities.pages || location.kind!=='reader')throw Error('SOURCE_IMPORT_UNSUPPORTED');
  if(!Array.isArray(snapshot.items))throw Error('SOURCE_PAGES_INVALID');
  const normalized:SourceSnapshot={...snapshot,items:snapshot.items.map(({url,kind,preview:_,processing,...item})=>({
    ...item,resource:kind==='page'?{kind:'page',resourceKey:url}:{kind:'http',url,processing},
  }))};
  validatePages(normalized,location);
  if(snapshot.items.some(item=>item.kind!==undefined&&item.kind!=='page' || item.kind==='page'&&(!options.pageContext||!isPageImageUrl(item.url))))throw Error('SOURCE_PAGES_INVALID');
  const {title,url,adapter,direction,discoveryComplete,knownTotal,note,items}=snapshot;
  const manifest:PageManifest={title,url,adapter,direction,discoveryComplete,knownTotal,note,items,id:options.id??crypto.randomUUID(),revision:options.revision??1,
    ...(options.pageContext?{pageContext:options.pageContext}:{}),
  };
  await chrome.storage.local.set({['manifest:'+manifest.id]:manifest});
  return manifest;
}
export function registerDocumentManifest(value:DocumentSnapshot,tabId:number,id?:string) {
  const {navigationId,revision,...snapshot}=value;
  if(!Number.isInteger(tabId)||tabId<0||typeof navigationId!=='string'||!navigationId||!Number.isInteger(revision)||revision<1)throw Error('SOURCE_PAGES_INVALID');
  return registerManifest(snapshot,{id,revision,pageContext:{tabId,navigationId}});
}
