import {catalog} from '../repositories';
import type {Entry,PageDescriptor} from '../domain';
import type {SourceCatalog} from './types';
import {publishWebsiteManifest} from './import-service';
import {discoverEntry,discoverPage,type PageManifest} from '../../sources';

export const websiteContentError=(error:unknown)=>(error instanceof Error?error.message:'原图下载失败，请重试。').replace(/https?:\/\/\S+/g,'[来源地址]');
const stale=()=>new DOMException('文档已移除或来源内容已变化。','AbortError');

/** Discovery publishes locators only; reading and downloads share the same identity checks. */
export async function discoverWebsiteContent(document:Entry,signal?:AbortSignal,reload=false):Promise<void>{
  const comic=await catalog.get('comics',document.comicId);
  const connection=comic&&await catalog.get('connections',comic.source.connectionId);
  const source=typeof comic?.source.locator.catalogId==='string'?await catalog.get('catalogs',comic.source.locator.catalogId) as SourceCatalog|undefined:undefined;
  if(!document.sourceUrl)throw Error('来源地址不可用。');
  const assertActive=async()=>{
    signal?.throwIfAborted();
    const [current,owner,access]=await Promise.all([catalog.get('entries',document.id),catalog.get('comics',document.comicId),connection&&catalog.get('connections',connection.id)]);
    if(!current||current.generation!==document.generation||current.contentId!==document.contentId||!owner||owner.source.status!=='active'||owner.source.generation!==comic?.source.generation||!access||access.status==='disconnected'||access.status==='revoked'||access.generation!==connection?.generation)throw stale();
    if(current.sourceRemoved||current.readable===false)throw Error('源站此章节暂不可读，已保存的页面仍可阅读。');
  };
  let published:PageManifest|undefined;
  const update=async(manifest:PageManifest)=>{await assertActive();await publishWebsiteManifest(document,manifest);published=manifest;};
  try{
    await assertActive();
    const lifetime=signal??new AbortController().signal,progress=reload?async()=>{}:update;
    const manifest=source&&document.sourceEntryId?await discoverEntry(source,document.sourceEntryId,lifetime,progress,assertActive):await discoverPage(document.sourceUrl,lifetime,progress,assertActive);
    await assertActive();if(manifest!==published)await publishWebsiteManifest(document,manifest,reload);
  }catch(error){
    if(!signal?.aborted)await catalog.patch('entries',document.id,{error:websiteContentError(error),indexState:'failed'},{expectedGeneration:document.generation}).catch(()=>{});
    throw error;
  }
}

interface Refresh {controller:AbortController;promise:Promise<void>;users:number;}
const refreshing=new Map<string,Refresh>();

/** Concurrent failed pages renew one chapter manifest; cancelling a page only releases its own wait. */
export async function refreshWebsitePage(document:Entry,failed:PageDescriptor,signal:AbortSignal):Promise<PageDescriptor>{
  signal.throwIfAborted();
  const currentPage=async()=>{
    signal.throwIfAborted();
    const [entry,page]=await Promise.all([catalog.get('entries',document.id),catalog.get('pageDescriptors',[document.contentId,failed.pageId])]);
    if(!entry||entry.generation!==document.generation||entry.contentId!==document.contentId||!page||page.locator.contentKey!==failed.locator.contentKey||page.locator.sourceId!==failed.locator.sourceId)throw stale();
    return page;
  };
  const current=await currentPage();
  if(current.locator.manifestId!==failed.locator.manifestId)return current;
  const key=JSON.stringify([document.id,document.generation,document.contentId,failed.locator.manifestId]);
  let work=refreshing.get(key);
  if(!work){
    const controller=new AbortController();
    work={controller,promise:discoverWebsiteContent(document,controller.signal),users:0};
    refreshing.set(key,work);
  }
  const chosen=work;chosen.users++;
  let abort:()=>void=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason??stale());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  try{await Promise.race([chosen.promise,cancelled]);return await currentPage();}
  finally{
    signal.removeEventListener('abort',abort);
    if(!--chosen.users){chosen.controller.abort();if(refreshing.get(key)===chosen)refreshing.delete(key);}
  }
}
