import { catalog } from '../repositories';
import { openFileSource } from '../sources/runtime';
import { getSourceDriver } from '../sources/registry';
import { openDocument } from '../formats';
import {epubImageDescriptor} from '../domain/epub-images';
import type { ComicFormat, IndexedPage } from '../formats/contracts';
import { prepareComicPage } from './normalize';
import { ImagePermissionsRequired, readSourceImage } from '../../sources';
import {refreshWebsitePage} from '../application/website-content';
import { sourcePageCache } from '../../storage/source-pages';
import { downloadKey, downloadStore } from '../../storage/downloads';
import { SourceDatabaseSchemaError } from '../../storage/database';
import { pageRenderProfile, pageReference, type PageReference } from './identity';
import type { PageDescriptor, PageMaterialization } from '../domain';
import {entryContentKind} from '../domain';

export interface PageRequest extends PageReference { signal?: AbortSignal; priority?: 'current'|'prefetch'|'background'; purpose?: 'reading'|'translation'|'export'|'download'|'thumbnail'; }
export interface PageLease { blob: Blob; identity: PageMaterialization; release(): void; }
interface Value { blob: Blob; identity: PageMaterialization; validate():Promise<void>; }
interface Work { controller: AbortController; promise: Promise<Value>; users: number; }
const pending=new Map<string,Work>();
const listeners=new Set<(identity:PageMaterialization)=>void>();
let active=0;
const queue:{priority:number;run:()=>void}[]=[];
function cacheUnavailable(error:unknown):undefined{if(error instanceof SourceDatabaseSchemaError)throw error;return undefined;}
function schedule<T>(priority:number,action:()=>Promise<T>):Promise<T>{return new Promise((resolve,reject)=>{queue.push({priority,run:()=>{active++;action().then(resolve,reject).finally(()=>{active--;drain();});}});queue.sort((a,b)=>a.priority-b.priority);drain();});}
function drain(){while(active<2&&queue.length)queue.shift()!.run();}
export {downloadKey} from '../../storage/downloads';
export const materializationId=(ref:PageReference)=>JSON.stringify([ref.contentId,ref.pageId,ref.renderProfileId]);
export const onMaterialized=(listener:(identity:PageMaterialization)=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};

async function read(request:PageRequest,signal:AbortSignal):Promise<Value>{
  signal.throwIfAborted();
  const [storedDescriptor,doc]=await Promise.all([catalog.get('pageDescriptors',[request.contentId,request.pageId]),catalog.get('entries',request.entryId)]);
  const descriptor=doc?.format==='epub'?epubImageDescriptor(doc.document,request.contentId,request.pageId):storedDescriptor;
  if(!descriptor||!doc||doc.contentId!==request.contentId)throw Error('页面已移除或来源内容已变化。');
  if(request.renderProfileId!==pageRenderProfile(doc.format))throw Error('不支持的页面渲染版本，请重新打开漫画。');
  const comic=await catalog.get('comics',doc.comicId),binding=comic?.source;
  const connection=binding&&await catalog.get('connections',binding.connectionId);
  if(!comic||!binding||!connection)throw Error('漫画来源已移除。');
  if(connection.status==='disconnected'||connection.status==='revoked'||binding.status!=='active')throw Error('来源访问已断开，请重新连接。');
  const assertSourceCurrent=async()=>{
    const [currentComic,currentConnection,currentEntry]=await Promise.all([catalog.get('comics',comic.id),catalog.get('connections',connection.id),catalog.get('entries',doc.id)]);
    if(!currentComic||!currentConnection||!currentEntry||currentEntry.contentId!==request.contentId||currentEntry.generation!==doc.generation||currentComic.source.generation!==binding.generation||currentConnection.generation!==connection.generation||currentComic.source.status!=='active'||currentConnection.status==='revoked'||currentConnection.status==='disconnected')throw Error('页面来源已变化或访问被撤销，请重新打开。');
  };
  const cachePages=getSourceDriver(connection.provider)?.cachePages!==false;
  const cacheToken=cachePages&&request.purpose!=='download'?await sourcePageCache.token(doc.id).catch(cacheUnavailable):undefined;
  const id=materializationId(request),known=await catalog.get('materializations',id);
  let blob=await downloadStore.get(downloadKey(request.contentId,request.pageId,request.renderProfileId)).catch(cacheUnavailable);
  if(!blob&&cachePages)blob=await sourcePageCache.get(pageReference(request)).catch(cacheUnavailable);
  // These repositories contain already-normalized output from this service, keyed by current content identity/profile.
  const trustedCache=!!blob;
  if(!blob){
    if(doc.format==='website'){
      const readImage=(page:PageDescriptor)=>{
        const {url,manifestId,sourceId}=page.locator;
        if(typeof url!=='string'||typeof manifestId!=='string'||typeof sourceId!=='string')throw Error('原图来源清单缺失，请重新发现来源。');
        return readSourceImage({manifestId,pageId:sourceId,expectedUrl:url},signal);
      };
      try{blob=await readImage(descriptor);}
      catch(error){
        const details=(error as {details?:{status?:number;retryAfter?:number}})?.details;
        if(signal.aborted||error instanceof ImagePermissionsRequired||error instanceof SourceDatabaseSchemaError||
          error instanceof DOMException&&error.name==='AbortError'||(error as {kind?:string})?.kind==='permission-required'||
          details?.status===429||details?.retryAfter||typeof descriptor.locator.contentKey!=='string')throw error;
        await assertSourceCurrent();
        const renewed=await refreshWebsitePage(doc,descriptor,signal);
        await assertSourceCurrent();
        blob=await readImage(renewed);
      }
    }else if(entryContentKind(doc)==='pages'){
      const provider=getSourceDriver(connection.provider);
      if(!provider?.pages)throw Error('此来源不提供逐页读取。');
      blob=await provider.pages.read({connection,source:binding,entryId:doc.id,contentId:doc.contentId,sourceSnapshot:doc.sourceSnapshot,format:doc.format,entry:doc,signal},descriptor);
    }else{
      const containerId=doc.containerId;
      const source=await openFileSource({connection,source:binding,entryId:doc.id,contentId:doc.contentId,sourceSnapshot:doc.sourceSnapshot,format:doc.format,containerId,signal});
      try{
        if(doc.format==='epub')blob=await (await import('../formats/epub')).readEpubImage(source,descriptor.locator.epubImage as string,signal);
        else {
          const session=await openDocument(doc.format as ComicFormat,source,signal);
          try{blob=await session.materialize({...descriptor,locator:descriptor.locator} as IndexedPage,signal);}finally{await session.close();}
        }
      }finally{await source.close();}
    }
  }
  signal.throwIfAborted();
  const prepared=trustedCache&&known&&known.byteSize===blob.size&&known.mime===blob.type&&known.width>0&&known.height>0
    ? {blob,width:known.width,height:known.height,imageSha256:known.imageSha256}
    : await prepareComicPage({name:descriptor.name,blob},signal);
  const identity:PageMaterialization={id,pageId:request.pageId,contentId:request.contentId,renderProfileId:request.renderProfileId,imageSha256:prepared.imageSha256,width:prepared.width,height:prepared.height,byteSize:prepared.blob.size,mime:prepared.blob.type,updatedAt:Date.now()};
  if(known&&known.imageSha256!==identity.imageSha256)throw Error('来源内容与已保存的页面身份不同，请重新载入当前内容。');
  signal.throwIfAborted();
  // Deleted source content may not be resurrected by a late parser/network completion.
  if((await catalog.get('entries',request.entryId))?.contentId!==request.contentId)throw Error('来源内容已变化，请重新打开。');
  await assertSourceCurrent();
  try{if(!await catalog.putMaterialization(identity,doc.generation))throw Error('页面来源内容已变化，请重新打开。');}
  catch(error){if((error as Error).name!=='QuotaExceededError')throw error;}
  if(!trustedCache&&cacheToken&&request.purpose!=='download')await sourcePageCache.put(pageReference(request),prepared.blob,{owner:doc.id,token:cacheToken,connectionId:connection.id,contentId:doc.contentId}).catch(cacheUnavailable);
  await assertSourceCurrent();
  for(const listener of listeners){try{listener(identity);}catch{/* A UI subscriber cannot make prepared source bytes unavailable. */}}
  return {blob:prepared.blob,identity,validate:assertSourceCurrent};
}
/** Every consumer releases its own lease; a cancelled thumbnail cannot cancel an active reader. */
export async function acquirePage(request:PageRequest):Promise<PageLease>{
  request.signal?.throwIfAborted();
  const key=pageReference(request);let work=pending.get(key);
  if(!work){
    const controller=new AbortController();
    const promise=schedule(request.priority==='background'?2:request.priority==='prefetch'?1:0,()=>read(request,controller.signal));
    work={controller,promise,users:0};pending.set(key,work);
    void promise.catch(()=>{});
  }
  const chosen=work;chosen.users++;let released=false;
  const release=()=>{if(released)return;released=true;request.signal?.removeEventListener('abort',abort);chosen.users--;if(!chosen.users){chosen.controller.abort();if(pending.get(key)===chosen)pending.delete(key);}};
  let rejectAbort:(error:unknown)=>void=()=>{};
  const abort=()=>{release();rejectAbort(request.signal?.reason??new DOMException('Aborted','AbortError'));};
  const cancelled=new Promise<never>((_,reject)=>{rejectAbort=reject;request.signal?.addEventListener('abort',abort,{once:true});});
  try{const value=await Promise.race([chosen.promise,cancelled]);await Promise.race([value.validate(),cancelled]);request.signal?.throwIfAborted();return {blob:value.blob,identity:value.identity,release};}catch(error){release();throw error;}
}
