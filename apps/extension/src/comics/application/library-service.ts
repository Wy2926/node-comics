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
import type {TranslationScope} from '../../translation/channels/contracts';
import {readReadingPreferences, readingSelectionKey, readingSlots, chooseReadingEntry, resolveReadingSequence, entryReadable, entryRetained, sourceOrder} from './reading-preferences';
export {coverReference} from './cover-access';
export {selectReadingEntry} from './reading-preferences';

type TranslationPayload=Pick<Page,'translationScope'|'ownerId'|'apiOrigin'|'jobs'|'assetId'|'assetExpiresAt'>;
const savedPages=new WeakMap<Page,string>();
const payload=(page:Page):TranslationPayload=>({translationScope:page.translationScope,ownerId:page.ownerId,apiOrigin:page.apiOrigin,jobs:page.jobs,assetId:page.assetId,assetExpiresAt:page.assetExpiresAt});
export const listShelfIndex=async():Promise<LibraryViewModel>=>({comics:await catalog.list('comics',{index:'updatedAt',direction:'prev',limit:Number.MAX_SAFE_INTEGER})});
export async function continueEntry(comicId:string,targetLanguage?:string):Promise<Entry|undefined> {
  const comic=await catalog.get('comics',comicId);if(!comic)return;
  const [allEntries,preferences]=await Promise.all([catalog.listEntries(comicId),readReadingPreferences(comic)]);
  const slots=readingSlots(allEntries),byId=new Map(allEntries.map(entry=>[entry.id,entry]));
  const resume=(entry:Entry)=>entryReadable(entry)?entry:chooseReadingEntry(slots.find(slot=>slot.id===readingSelectionKey(entry))!,preferences,targetLanguage);
  const positions=await catalog.list('positions',{index:'comicId',range:comicId,limit:10000});
  const recent=positions.filter(position=>byId.get(position.entryId)?.contentId===position.contentId)
    .sort((a,b)=>b.updatedAt-a.updatedAt)[0];
  const explicit=preferences.lastEntryId?byId.get(preferences.lastEntryId):undefined;
  if(explicit&&(preferences.selectedAt??0)>=(recent?.updatedAt??0))return resume(explicit);
  if(recent)return resume(byId.get(recent.entryId)!);
  const last=comic.lastEntryId?byId.get(comic.lastEntryId):undefined;if(last)return resume(last);
  const start=slots.find(slot=>slot.entries.some(entry=>entry.id===comic.startEntryId)&&slot.entries.some(entryReadable))
    ??slots.find(slot=>slot.entries.some(entryReadable))??slots[0];
  return start?chooseReadingEntry(start,preferences,targetLanguage):undefined;
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
export async function loadEntry(id:string,scope?:TranslationScope):Promise<ReadingEntry> {
  const entry=await catalog.get('entries',id);if(!entry)throw Error('漫画已移除。');
  const [descriptors,position,comic]=await Promise.all([catalog.listPages(entry.contentId,{limit:1500}),catalog.get('positions',id),catalog.get('comics',entry.comicId)]);
  const pages=await Promise.all(descriptors.map(async descriptor=>{
    const identity=await catalog.get('materializations',materializationId({entryId:id,contentId:entry.contentId,pageId:descriptor.pageId,renderProfileId:RENDER_PROFILE}));
    const page=descriptorView(entry,descriptor,identity);
    if(scope&&identity){
      const saved=await catalog.get('translationBindings',JSON.stringify([scope.key,identity.imageSha256]));
      if(saved?.scope===scope.key){
        const value=saved.payload as TranslationPayload;
        page.translationScope=scope.key;page.ownerId=value.ownerId;page.apiOrigin=value.apiOrigin;page.jobs=Array.isArray(value.jobs)?value.jobs:[];page.assetId=value.assetId;page.assetExpiresAt=value.assetExpiresAt;
      }
    }
    savedPages.set(page,JSON.stringify(payload(page)));return page;
  }));
  return {...readingEntry(entry,pages,position),catalogUpdateRevision:comic?.catalogUpdates?.revision};
}
export interface DirectoryEntry {id:string;title:string;tags:string[];current:boolean;read:boolean;readable:boolean;total?:number;status:string;error?:string;contentLanguage?:string;sourceRemoved?:boolean}
export interface DirectoryGroup {id:string;title:string;entryIds:string[];parentId?:string}
export interface DirectoryChapter {id:string;title:string;entryIds:string[];selectedEntryId:string;groupIds:string[];current:boolean;readable:boolean}
export interface ReadingDirectory {comicId?:string;title:string;entries:DirectoryEntry[];chapters:DirectoryChapter[];groups:DirectoryGroup[];sourceUrl?:string;related?:{id:string;title:string;url:string}[]}
export async function comicDirectory(comicId:string,currentId?:string,targetLanguage?:string):Promise<ReadingDirectory> {
  const comic=await catalog.get('comics',comicId);if(!comic)throw Error('漫画已移除。');
  const slots=readingSlots(await catalog.listEntries(comicId)).map(slot=>{
    const present=slot.entries.filter(entry=>!entry.sourceRemoved||entry.id===currentId);
    return {...slot,entries:present.length?present:[slot.entries[0]]};
  });
  const entries=slots.flatMap(slot=>slot.entries).sort(sourceOrder);
  const preferences=await readReadingPreferences(comic);
  const [source]=await catalog.list('catalogs',{index:'comicId',range:comicId,limit:1}) as unknown as SourceCatalog[];
  const sourceEntries=new Map(source?.entries.map(entry=>[entry.id,entry]));
  const bySource=new Map(entries.map(entry=>[entry.sourceEntryId,entry.id]));
  const groups=source?.groups.map(group=>({...group,entryIds:group.entryIds.flatMap(id=>{const entryId=bySource.get(id);return entryId?[entryId]:[];})})).filter(group=>group.entryIds.length||source.groups.some(child=>child.parentId===group.id))??[];
  const available=(entry:Entry)=>entryReadable(entry)||entry.id===currentId&&entryRetained(entry);
  const chapters=slots.map(slot=>{
    const current=slot.entries.find(entry=>entry.id===currentId),selected=current??chooseReadingEntry(slot,preferences,targetLanguage);
    return {id:slot.id,title:selected.title,entryIds:slot.entries.map(entry=>entry.id),selectedEntryId:selected.id,
      groupIds:[...new Set(slot.entries.flatMap(entry=>sourceEntries.get(entry.sourceEntryId??'')?.groupIds??[]))],current:!!current,readable:available(selected)};
  });
  return {comicId,title:comic.title,sourceUrl:comic.sourceUrl,groups,chapters,
    related:source?.entries.filter(entry=>entry.related).map(({id,title,url})=>({id,title,url})),entries:entries.map(entry=>({id:entry.id,title:entry.title,tags:sourceEntries.get(entry.sourceEntryId??'')?.rawTypes??[],current:entry.id===currentId,read:!!entry.readAt,readable:available(entry),total:entry.knownTotal??entry.pageCount,
      contentLanguage:entry.contentLanguage,sourceRemoved:entry.sourceRemoved,
      status:!available(entry)?'该话暂无可读内容。':entry.sourceRemoved?'源站已移除':entry.error??(entry.indexState==='ready'?'可以阅读':'按需载入'),error:!available(entry)?'该话暂无可读内容。':entry.error}))};
}
/** Only one adapter-declared sequence may be read continuously. Other groups remain explicit navigation. */
export async function readerSequence(entryId:string,scope?:TranslationScope,targetLanguage?:string):Promise<{copies:ReadingEntry[];directory:ReadingDirectory}> {
  const entry=await catalog.get('entries',entryId);if(!entry)throw Error('漫画已移除。');
  const comic=await catalog.get('comics',entry.comicId);if(!comic)throw Error('漫画已移除。');
  const entries=resolveReadingSequence(entry,await catalog.listEntries(entry.comicId),await readReadingPreferences(comic),targetLanguage);
  const at=entries.findIndex(item=>item.id===entryId);
  const copies=await Promise.all(entries.map((item,index)=>item.id!==entryId&&!entryReadable(item)
    ?Promise.resolve(readingEntry({...item,discoveryComplete:false}))
    :Math.abs(index-at)<=1?loadEntry(item.id,scope):Promise.resolve(readingEntry(item))));
  return {copies,directory:await comicDirectory(entry.comicId,entryId,targetLanguage)};
}
export async function saveReaderState(copy:ReadingEntry) {
  if(!copy.contentId||!copy.comicId)return;
  const entry=await catalog.get('entries',copy.id);if(!entry||entry.contentId!==copy.contentId||entry.comicId!==copy.comicId)return;
  if(copy.pageId&&copy.lastReadAt!==undefined)await catalog.savePosition({id:copy.id,comicId:copy.comicId,entryId:copy.id,contentId:copy.contentId,pageId:copy.pageId,relativeOffset:Math.max(0,Math.min(1,copy.relativeOffset)),updatedAt:copy.lastReadAt});
  for(const page of copy.pages){
    if(!page.translationScope||!page.imageSha256||!page.jobs.length&&!page.assetId)continue;
    const incoming=payload(page),signature=JSON.stringify(incoming);if(savedPages.get(page)===signature)continue;
    const id=JSON.stringify([page.translationScope,page.imageSha256]);
    await catalog.editTranslationBinding(id,previous=>{
      const old=previous?.payload as TranslationPayload|undefined,jobs=mergeJobs(old?.jobs??[],incoming.jobs);
      const merged:TranslationPayload={...incoming,jobs,assetId:incoming.assetId??old?.assetId,assetExpiresAt:incoming.assetId?incoming.assetExpiresAt:old?.assetExpiresAt};
      if(previous&&JSON.stringify(old)===JSON.stringify(merged))return undefined;
      return {id,scope:page.translationScope!,imageSha256:page.imageSha256!,payload:merged,updatedAt:Date.now()};
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
