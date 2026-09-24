import {catalog} from '../repositories';
import type {Comic,Entry,PageDescriptor,PageMaterialization} from '../domain';
import type {Page,ReadingEntry} from '../../types';
import {RENDER_PROFILE,pageReference} from '../pages/identity';
import {materializationId} from '../pages/service';
import {releaseContainer} from '../../storage/containers';
import {sourcePageCache} from '../../storage/source-pages';
import {sourceRangeCache} from '../../storage/source-ranges';
import {thumbnailCache} from '../../storage/thumbnails';
import {downloadStore} from '../../storage/downloads';
import type {LibraryViewModel,SourceCatalog} from './types';
import {mergeJobs} from '../../reader/jobs';
import {sourceCoverOwner} from './cover-access';
export {coverReference} from './cover-access';

type TranslationPayload=Pick<Page,'ownerId'|'apiOrigin'|'jobs'|'assetId'|'assetExpiresAt'>;
const savedPages=new WeakMap<Page,string>();
const payload=(page:Page):TranslationPayload=>({ownerId:page.ownerId,apiOrigin:page.apiOrigin,jobs:page.jobs,assetId:page.assetId,assetExpiresAt:page.assetExpiresAt});
export const listShelfIndex=async():Promise<LibraryViewModel>=>({comics:await catalog.list('comics',{index:'updatedAt',direction:'prev',limit:Number.MAX_SAFE_INTEGER})});
export async function continueEntry(comicId:string):Promise<Entry|undefined> {
  const comic=await catalog.get('comics',comicId);if(!comic)return;
  if(comic.lastEntryId){const entry=await catalog.get('entries',comic.lastEntryId);if(entry?.comicId===comicId)return entry;}
  if(comic.startEntryId){const entry=await catalog.get('entries',comic.startEntryId);if(entry?.comicId===comicId)return entry;}
  const entries=(await catalog.listEntries(comicId)).filter(entry=>!entry.sourceRemoved);return entries.length===1?entries[0]:undefined;
}
export function descriptorView(entry:Entry,page:PageDescriptor,identity?:PageMaterialization):Page {
  return {id:page.pageId,name:page.name,width:identity?.width??page.width??900,height:identity?.height??page.height??1300,
    entryId:entry.id,contentId:page.contentId,renderProfileId:RENDER_PROFILE,
    blobKey:pageReference({entryId:entry.id,contentId:page.contentId,pageId:page.pageId,renderProfileId:RENDER_PROFILE}),
    ...(identity?{imageSha256:identity.imageSha256,imageByteSize:identity.byteSize,imageMime:identity.mime}:{}),
    sourceUrl:typeof page.locator.url==='string'?page.locator.url:undefined,jobs:[],outputBlobs:{}};
}
function readingEntry(entry:Entry,pages:Page[]=[],position?:{contentId:string;pageId:string;relativeOffset:number;updatedAt:number}):ReadingEntry {
  return {id:entry.id,comicId:entry.comicId,contentId:entry.contentId,title:entry.title,source:entry.format,sourceKey:entry.id,sourceUrl:entry.sourceUrl,sourceEntryId:entry.sourceEntryId,generation:entry.generation,
    createdAt:entry.createdAt,updatedAt:entry.updatedAt,lastReadAt:position?.updatedAt,coverPageId:entry.coverPageId,pages,
    pageId:position?.contentId===entry.contentId?position.pageId:pages[0]?.id??'',relativeOffset:position?.contentId===entry.contentId?position.relativeOffset:0,
    discoveryComplete:entry.discoveryComplete??false,knownTotal:entry.knownTotal??entry.pageCount};
}
export async function loadEntry(id:string,account?:{userId:string;origin:string}):Promise<ReadingEntry> {
  const entry=await catalog.get('entries',id);if(!entry)throw Error('漫画已移除。');
  const [descriptors,position,comic]=await Promise.all([catalog.listPages(entry.contentId,{limit:1500}),catalog.get('positions',id),catalog.get('comics',entry.comicId)]);
  const pages=await Promise.all(descriptors.map(async descriptor=>{
    const identity=await catalog.get('materializations',materializationId({entryId:id,contentId:entry.contentId,pageId:descriptor.pageId,renderProfileId:RENDER_PROFILE}));
    const page=descriptorView(entry,descriptor,identity);
    if(account&&identity){
      const saved=await catalog.get('translationBindings',JSON.stringify([account.origin,account.userId,identity.imageSha256]));
      if(saved&&saved.userId===account.userId&&saved.apiOrigin===account.origin){
        const value=saved.payload as TranslationPayload;
        page.ownerId=account.userId;page.apiOrigin=account.origin;page.jobs=Array.isArray(value.jobs)?value.jobs:[];page.assetId=value.assetId;page.assetExpiresAt=value.assetExpiresAt;
      }
    }
    savedPages.set(page,JSON.stringify(payload(page)));return page;
  }));
  return {...readingEntry(entry,pages,position),catalogUpdateRevision:comic?.catalogUpdates?.revision};
}
export interface DirectoryEntry {id:string;title:string;tags:string[];current:boolean;read:boolean;total?:number;status:string;error?:string}
export interface DirectoryGroup {id:string;title:string;entryIds:string[];parentId?:string}
export interface ReadingDirectory {comicId?:string;title:string;entries:DirectoryEntry[];groups:DirectoryGroup[];sourceUrl?:string;related?:{id:string;title:string;url:string}[]}
export async function comicDirectory(comicId:string,currentId?:string):Promise<ReadingDirectory> {
  const comic=await catalog.get('comics',comicId);if(!comic)throw Error('漫画已移除。');
  const entries=(await catalog.listEntries(comicId)).filter(entry=>!entry.sourceRemoved||entry.id===currentId);
  const [source]=await catalog.list('catalogs',{index:'comicId',range:comicId,limit:1}) as unknown as SourceCatalog[];
  const bySource=new Map(entries.map(entry=>[entry.sourceEntryId,entry.id]));
  const groups=source?.groups.map(group=>({...group,entryIds:group.entryIds.flatMap(id=>{const entryId=bySource.get(id);return entryId?[entryId]:[];})})).filter(group=>group.entryIds.length||source.groups.some(child=>child.parentId===group.id))??[];
  return {comicId,title:comic.title,sourceUrl:comic.sourceUrl,groups,related:source?.entries.filter(entry=>entry.related).map(({id,title,url})=>({id,title,url})),entries:entries.map(entry=>({id:entry.id,title:entry.title,tags:source?.entries.find(item=>item.id===entry.sourceEntryId)?.rawTypes??[],current:entry.id===currentId,read:!!entry.readAt,total:entry.knownTotal??entry.pageCount,status:entry.error??(entry.indexState==='ready'?'可以阅读':'按需载入'),error:entry.error}))};
}
/** Only one adapter-declared sequence may be read continuously. Other groups remain explicit navigation. */
export async function readerSequence(entryId:string,account?:{userId:string;origin:string}):Promise<{copies:ReadingEntry[];directory:ReadingDirectory}> {
  const entry=await catalog.get('entries',entryId);if(!entry)throw Error('漫画已移除。');
  const entries=entry.sequenceId?(await catalog.listEntries(entry.comicId)).filter(item=>item.sequenceId===entry.sequenceId&&(!item.sourceRemoved||item.id===entryId)):[entry];
  const at=entries.findIndex(item=>item.id===entryId);
  const copies=await Promise.all(entries.map((item,index)=>Math.abs(index-at)<=1?loadEntry(item.id,account):Promise.resolve(readingEntry(item))));
  return {copies,directory:await comicDirectory(entry.comicId,entryId)};
}
export async function saveReaderState(copy:ReadingEntry) {
  if(!copy.contentId||!copy.comicId)return;
  const entry=await catalog.get('entries',copy.id);if(!entry||entry.contentId!==copy.contentId||entry.comicId!==copy.comicId)return;
  if(copy.pageId&&copy.lastReadAt!==undefined)await catalog.savePosition({id:copy.id,comicId:copy.comicId,entryId:copy.id,contentId:copy.contentId,pageId:copy.pageId,relativeOffset:Math.max(0,Math.min(1,copy.relativeOffset)),updatedAt:copy.lastReadAt});
  for(const page of copy.pages){
    if(!page.ownerId||!page.apiOrigin||!page.imageSha256||!page.jobs.length&&!page.assetId)continue;
    const incoming=payload(page),signature=JSON.stringify(incoming);if(savedPages.get(page)===signature)continue;
    const id=JSON.stringify([page.apiOrigin,page.ownerId,page.imageSha256]);
    await catalog.editTranslationBinding(id,previous=>{
      const old=previous?.payload as TranslationPayload|undefined,jobs=mergeJobs(old?.jobs??[],incoming.jobs);
      const merged:TranslationPayload={...incoming,jobs,assetId:incoming.assetId??old?.assetId,assetExpiresAt:incoming.assetId?incoming.assetExpiresAt:old?.assetExpiresAt};
      if(previous&&JSON.stringify(old)===JSON.stringify(merged))return undefined;
      return {id,apiOrigin:page.apiOrigin!,userId:page.ownerId!,imageSha256:page.imageSha256!,payload:merged,updatedAt:Date.now()};
    });
    savedPages.set(page,signature);
  }
}
export async function removeComic(id:string) {
  const entries=await catalog.deleteComic(id);
  await thumbnailCache.deleteOwner(sourceCoverOwner(id),true);
  for(const entry of entries) {
    await Promise.all([sourcePageCache.deleteOwner(entry.id,true),sourceRangeCache.deleteOwner(entry.id,true),thumbnailCache.deleteOwner(entry.id,true),downloadStore.deleteOwner(entry.id,true)]);
    if(entry.containerId)await releaseContainer(entry.containerId,entry.contentId);
  }
}
/** Each comic is independent: a failed removal must not stop the rest of the selection. */
export async function removeComics(ids:readonly string[]) {
  const removed:string[]=[],failures:{id:string;error:string}[]=[];
  for(const id of new Set(ids)) {
    try {await removeComic(id);removed.push(id);}
    catch(error) {failures.push({id,error:error instanceof Error?error.message:String(error)});}
  }
  return {removed,failures};
}
export const subscribeLibrary=catalog.subscribe;
export const markRead=catalog.markRead;
export const completePageList=(copy:ReadingEntry)=>copy.pages.length>0&&copy.discoveryComplete&&(!copy.knownTotal||copy.knownTotal===copy.pages.length);
export type {Comic,Entry};


export const getEntry=(id:string)=>catalog.get('entries',id);
