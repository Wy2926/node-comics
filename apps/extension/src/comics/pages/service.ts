import { catalog } from '../repositories';
import { openFileSource } from '../sources/runtime';
import { getSourceDriver } from '../sources/registry';
import { openDocument } from '../formats';
import type { ComicFormat, IndexedPage } from '../formats/contracts';
import { prepareComicPage } from './normalize';
import { sourceImage, sourceMessage, requireImagePermissions, inExtension } from '../../sources';
import { sourcePageCache } from '../../storage/source-pages';
import { downloadStore } from '../../storage/downloads';
import { SourceDatabaseSchemaError } from '../../storage/database';
import { originalReplica } from '../originals';
import { RENDER_PROFILE, pageReference, type PageReference } from './identity';
import type { PageMaterialization } from '../domain';

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
export const downloadKey=(revisionId:string,pageId:string)=>JSON.stringify([revisionId,pageId]);
export const materializationId=(ref:PageReference)=>JSON.stringify([ref.revisionId,ref.pageId,ref.renderProfileId]);
export const onMaterialized=(listener:(identity:PageMaterialization)=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};

async function read(request:PageRequest,signal:AbortSignal):Promise<Value>{
  signal.throwIfAborted();
  if(request.renderProfileId!==RENDER_PROFILE)throw Error('不支持的页面渲染版本，请重新打开漫画。');
  const [revision,descriptor,doc]=await Promise.all([catalog.get('revisions',request.revisionId),catalog.get('pageDescriptors',[request.revisionId,request.pageId]),catalog.get('documents',request.documentId)]);
  if(!revision||revision.documentId!==request.documentId||!descriptor||!doc)throw Error('页面或文档已移除。');
  const binding=await catalog.get('bindings',doc.sourceBindingId);
  const connection=binding&&await catalog.get('connections',binding.connectionId);
  if(!binding||!connection)throw Error('来源连接已移除。');
  if(connection.status==='disconnected'||connection.status==='revoked')throw Error('来源连接已断开，请重新连接。');
  if(binding.status==='disconnected'||binding.status==='revoked')throw Error('当前文件访问已撤销，请重新连接来源。');
  const assertSourceCurrent=async()=>{
    const [currentBinding,currentConnection,currentDocument]=await Promise.all([catalog.get('bindings',binding.id),catalog.get('connections',connection.id),catalog.get('documents',doc.id)]);
    if(!currentBinding||!currentConnection||!currentDocument||currentDocument.generation!==doc.generation||currentBinding.generation!==binding.generation||currentConnection.generation!==connection.generation||currentBinding.status==='revoked'||currentBinding.status==='disconnected'||currentConnection.status==='revoked'||currentConnection.status==='disconnected')throw Error('页面来源已变化或访问被撤销，请重新打开。');
  };
  const cachePages=getSourceDriver(connection.provider)?.cachePages!==false;
  const cacheToken=cachePages&&request.purpose!=='download'?await sourcePageCache.token(doc.id).catch(cacheUnavailable):undefined;
  const id=materializationId(request),known=await catalog.get('materializations',id);
  let blob=await downloadStore.get(downloadKey(request.revisionId,request.pageId)).catch(cacheUnavailable);
  if(!blob&&cachePages)blob=await sourcePageCache.get(pageReference(request)).catch(cacheUnavailable);
  // These repositories contain already-normalized output from this service, keyed by immutable revision/profile.
  const trustedCache=!!blob;
  if(!blob){
    try{
      if(doc.format==='website'){
        const {url,manifestId,sourceId,kind}=descriptor.locator;
        if(typeof url!=='string'||typeof manifestId!=='string'||typeof sourceId!=='string')throw Error('原图来源清单缺失，请重新发现来源。');
        if(kind!=='page'&&inExtension())await requireImagePermissions([url]);
        const valid=await sourceMessage<{url:string;data?:string}>({type:'NC_SOURCE_IMAGE',manifestId,pageId:sourceId});
        signal.throwIfAborted();
        if(valid.url!==url)throw Error('图片来源已变化，请重新发现。');
        blob=await sourceImage(valid.data??valid.url,signal);
      }else{
        const containerId=revision.containerId??(typeof descriptor.locator.containerId==='string'?descriptor.locator.containerId:undefined);
        const source=await openFileSource({connection,binding,revision,documentId:doc.id,format:doc.format,containerId,signal});
        try{
          const session=await openDocument(doc.format==='images'?'image':doc.format as ComicFormat,source,signal);
          try{blob=await session.materialize(doc.format==='images'?{ordinal:0,name:descriptor.name,locator:{image:0}}:{...descriptor,locator:descriptor.locator} as IndexedPage,signal);}finally{await session.close();}
        }finally{await source.close();}
      }
    }catch(error){if(signal.aborted||error instanceof SourceDatabaseSchemaError)throw error;blob=known&&await originalReplica(known.imageSha256);if(!blob)throw error;}
  }
  signal.throwIfAborted();
  const prepared=trustedCache&&known&&known.byteSize===blob.size&&known.mime===blob.type&&known.width>0&&known.height>0
    ? {blob,width:known.width,height:known.height,imageSha256:known.imageSha256}
    : await prepareComicPage({name:descriptor.name,pageIndex:descriptor.ordinal,blob},signal);
  const identity:PageMaterialization={id,pageId:request.pageId,revisionId:request.revisionId,renderProfileId:request.renderProfileId,imageSha256:prepared.imageSha256,width:prepared.width,height:prepared.height,byteSize:prepared.blob.size,mime:prepared.blob.type,updatedAt:Date.now()};
  if(known&&known.imageSha256!==identity.imageSha256)throw Error('来源内容与已保存的页面身份不同，请重新建立文档版本。');
  signal.throwIfAborted();
  // A deleted revision may not be resurrected by a late parser/network completion.
  if(!await catalog.get('revisions',request.revisionId))throw Error('文档已移除。');
  await assertSourceCurrent();
  try{if(!await catalog.putMaterialization(identity,doc.generation))throw Error('页面所属文档版本已变化，请重新打开。');}
  catch(error){if((error as Error).name!=='QuotaExceededError')throw error;}
  if(!trustedCache&&cacheToken&&request.purpose!=='download')await sourcePageCache.put(pageReference(request),prepared.blob,{owner:doc.id,token:cacheToken,connectionId:connection.id,revisionId:revision.id}).catch(cacheUnavailable);
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
