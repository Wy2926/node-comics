import { catalog } from '../repositories';
import type { Document, PageDescriptor, PageMaterialization, ReadingUnit, Work } from '../domain';
import type { Page, ReadingCopy } from '../../types';
import { RENDER_PROFILE, pageReference } from '../pages/identity';
import { materializationId } from '../pages/service';
import { releaseContainer } from '../../storage/containers';
import { sourcePageCache } from '../../storage/source-pages';
import { sourceRangeCache } from '../../storage/source-ranges';
import { thumbnailCache } from '../../storage/thumbnails';
import { downloadStore } from '../../storage/downloads';
import type { LibraryViewModel } from './types';
import { mergeJobs } from '../../reader/jobs';
import {markDocumentRead, preferredDocument, updateWork} from './work-management';
import {withSourceLabels} from './source-labels';
export {preferredDocument, continueDocument} from './work-management';

type TranslationPayload = Pick<Page,'ownerId'|'apiOrigin'|'jobs'|'assetId'|'assetExpiresAt'>;
const savedPages = new WeakMap<Page,string>();
const payload = (page: Page): TranslationPayload => ({ownerId:page.ownerId,apiOrigin:page.apiOrigin,jobs:page.jobs,assetId:page.assetId,assetExpiresAt:page.assetExpiresAt});

export async function listLibrary(offset=0,limit=48):Promise<LibraryViewModel>{
  const values=await catalog.list('works',{index:'updatedAt',direction:'prev',offset,limit:limit+1});
  return {...await loadShelfCards(values.slice(0,limit)),nextOffset:values.length>limit?offset+limit:undefined};
}
/** Global title index supports sorting/search; card details are requested only by the visible window. */
export async function listShelfIndex():Promise<LibraryViewModel>{return {works:await catalog.workSummaries(),units:[],documents:[]};}
export async function loadShelfCards(works:Work[]):Promise<LibraryViewModel>{
  const units=(await metadataBatch(works,w=>catalog.listUnits(w.id))).flat();
  const documents=(await Promise.all(units.map(u=>catalog.listDocuments(u.id)))).flat();
  const positions=(await Promise.all(works.map(work=>catalog.list('positions',{index:'workId',range:work.id,limit:Number.MAX_SAFE_INTEGER})))).flat();
  const loaded=new Set(documents.map(document=>document.id)),unitIds=new Set(units.map(unit=>unit.id));
  const documentReads=new Map(documents.map(document=>[document.id,Promise.resolve<Document|undefined>(document)]));
  const unitReads=new Map(units.map(unit=>[unit.id,Promise.resolve<ReadingUnit|undefined>(unit)]));
  const readDocument=(id:string)=>{let result=documentReads.get(id);if(!result){result=catalog.get('documents',id);documentReads.set(id,result);}return result;};
  const readUnit=(id:string)=>{let result=unitReads.get(id);if(!result){result=catalog.get('units',id);unitReads.set(id,result);}return result;};
  async function includeReference(documentId:string,workId:string,expected:{unitId?:string;revisionId?:string}={}):Promise<boolean>{
    const document=await readDocument(documentId);
    if(!document||expected.unitId!==undefined&&document.unitId!==expected.unitId||expected.revisionId!==undefined&&document.revisionId!==expected.revisionId)return false;
    const unit=await readUnit(document.unitId);if(!unit||unit.workId!==workId)return false;
    if(!unitIds.has(unit.id)){units.push(unit);unitIds.add(unit.id);}
    if(!loaded.has(document.id)){documents.push(document);loaded.add(document.id);}
    return true;
  }
  // Keep shelf metadata bounded; only explicit cover, continuation and preference references bypass its per-unit limits.
  await metadataBatch(works,async work=>{
    if(work.cover)await includeReference(work.cover.documentId,work.id,{revisionId:work.cover.revisionId});
    const recent=positions.filter(position=>position.workId===work.id).sort((a,b)=>b.updatedAt-a.updatedAt);
    for(const position of recent)if(await includeReference(position.documentId,work.id,{revisionId:position.revisionId}))break;
  });
  await metadataBatch(units,async unit=>{if(unit.preferredDocumentId)await includeReference(unit.preferredDocumentId,unit.workId,{unitId:unit.id});});
  return withSourceLabels({works,units,documents,positions});
}
/** Catalog import state is independent of the shelf's mounted card window. */
export async function importedCatalogEntries(ids:string[]):Promise<string[]>{
  return (await metadataBatch(ids,async id=>{
    const [document]=await catalog.list('documents',{index:'sourceKey',range:'website:'+id,limit:1});
    return document?.sourceEntryId===id?[id]:[];
  })).flat();
}
async function metadataBatch<T,U>(values:T[],read:(value:T)=>Promise<U>):Promise<U[]>{
  const result:U[]=[];
  for(let offset=0;offset<values.length;offset+=16)result.push(...await Promise.all(values.slice(offset,offset+16).map(read)));
  return result;
}
async function workMetadata(workId:string):Promise<LibraryViewModel|undefined>{
  const work=await catalog.get('works',workId);if(!work)return undefined;
  const [units,positions]=await Promise.all([
    catalog.listUnits(workId,{limit:Number.MAX_SAFE_INTEGER}),
    catalog.list('positions',{index:'workId',range:workId,limit:Number.MAX_SAFE_INTEGER}),
  ]);
  const documents=(await metadataBatch(units,unit=>catalog.listDocuments(unit.id,{limit:Number.MAX_SAFE_INTEGER}))).flat();
  return {works:[work],units,documents,positions};
}
/** Complete metadata for one work; document pages and source bytes remain lazy. */
export async function loadWorkDetails(workId:string):Promise<LibraryViewModel|undefined>{
  const details=await workMetadata(workId);if(!details)return undefined;
  return withSourceLabels(details,true);
}
const searchTerm=(value:string)=>value.trim().normalize('NFKC').toLocaleLowerCase();
function searchPage(offset:number,limit:number){return {offset:Number.isFinite(offset)?Math.max(0,Math.floor(offset)):0,limit:Number.isFinite(limit)?Math.max(1,Math.min(100,Math.floor(limit))):30};}
export async function searchWorks(query:string,offset=0,limit=30):Promise<{works:Work[];nextOffset?:number}>{
  const page=searchPage(offset,limit),term=searchTerm(query);
  const found=await catalog.search('works',work=>!term||[work.title,...work.aliases??[],...work.creators??[]].some(value=>searchTerm(value).includes(term)),{index:'updatedAt',direction:'prev',offset:page.offset,limit:page.limit+1});
  return {works:found.slice(0,page.limit),nextOffset:found.length>page.limit?page.offset+page.limit:undefined};
}
export const getWork=(id:string)=>catalog.get('works',id);
export const getReadingUnit=(id:string)=>catalog.get('units',id);
export const listWorkUnits=(workId:string)=>catalog.listUnits(workId,{limit:Number.MAX_SAFE_INTEGER});
export async function searchWorkUnits(workId:string,query:string,offset=0,limit=30):Promise<{units:ReadingUnit[];nextOffset?:number}>{
  const page=searchPage(offset,limit),term=searchTerm(query);
  const found=await catalog.search('units',unit=>!term||searchTerm(unit.title).includes(term),{index:'workOrder',range:IDBKeyRange.bound([workId,-Infinity],[workId,Infinity]),offset:page.offset,limit:page.limit+1});
  return {units:found.slice(0,page.limit),nextOffset:found.length>page.limit?page.offset+page.limit:undefined};
}
export function descriptorView(doc:Document,page:PageDescriptor,identity?:PageMaterialization):Page{
  return {id:page.pageId,name:page.name,width:identity?.width??page.width??900,height:identity?.height??page.height??1300,
    documentId:doc.id,revisionId:page.revisionId,renderProfileId:RENDER_PROFILE,
    blobKey:pageReference({documentId:doc.id,revisionId:page.revisionId,pageId:page.pageId,renderProfileId:RENDER_PROFILE}),
    ...(identity?{imageSha256:identity.imageSha256,imageByteSize:identity.byteSize,imageMime:identity.mime}:{}),
    sourceUrl:typeof page.locator.url==='string'?page.locator.url:undefined,jobs:[],outputBlobs:{}};
}
export async function loadDocument(id:string,account?:{userId:string;origin:string}):Promise<ReadingCopy>{
  const doc=await catalog.get('documents',id);if(!doc)throw Error('文档已移除。');
  const [descriptors,position,unit]=await Promise.all([catalog.listPages(doc.revisionId,{limit:1500}),catalog.get('positions',id),catalog.get('units',doc.unitId)]);
  const pages=await Promise.all(descriptors.map(async descriptor=>{
    const identity=await catalog.get('materializations',materializationId({documentId:doc.id,revisionId:doc.revisionId,pageId:descriptor.pageId,renderProfileId:RENDER_PROFILE}));
    const page=descriptorView(doc,descriptor,identity);
    if(account&&identity){
      const saved=await catalog.get('translationBindings',JSON.stringify([account.origin,account.userId,identity.imageSha256]));
      if(saved&&saved.userId===account.userId&&saved.apiOrigin===account.origin){
        const value=saved.payload as TranslationPayload;
        page.ownerId=account.userId;page.apiOrigin=account.origin;page.jobs=Array.isArray(value.jobs)?value.jobs:[];page.assetId=value.assetId;page.assetExpiresAt=value.assetExpiresAt;
        // Cache readiness belongs to the current reader lease, never to persistent content identity.
        page.outputBlobs={};
      }
    }
    savedPages.set(page,JSON.stringify(payload(page)));
    return page;
  }));
  return {id:doc.id,workId:unit?.workId,revisionId:doc.revisionId,title:doc.title,source:doc.format,sourceKey:doc.sourceKey??doc.id,sourceUrl:doc.sourceUrl,sourceEntryId:doc.sourceEntryId,manifestRevision:doc.generation,
    retention:'offline',createdAt:doc.createdAt,updatedAt:doc.updatedAt,lastReadAt:position?.updatedAt,coverPageId:doc.coverPageId,
    pages,pageId:position?.revisionId===doc.revisionId?position.pageId:pages[0]?.id??'',relativeOffset:position?.revisionId===doc.revisionId?position.relativeOffset:0,
    discoveryComplete:doc.discoveryComplete??doc.indexState==='ready',knownTotal:doc.knownTotal??doc.pageCount};
}
/** Only current/adjacent documents carry page view models; shelf cards contain metadata. */
export async function readerSequence(documentId:string,account?:{userId:string;origin:string}):Promise<{copies:ReadingCopy[];directory:ReadingDirectory}>{
  const doc=await catalog.get('documents',documentId);if(!doc)throw Error('文档已移除。');
  const unit=await catalog.get('units',doc.unitId);if(!unit)throw Error('阅读单元已移除。');
  const details=await workMetadata(unit.workId);if(!details)throw Error('作品已移除。');
  const {units,documents,positions=[]}=details,work=details.works[0];
  if(!documents.some(document=>document.id===doc.id))documents.push(doc);
  const chosen=units.map(u=>preferredDocument(u,documents,positions,documentId)).filter((d):d is Document=>!!d);
  const at=chosen.findIndex(d=>d.id===documentId);
  const copies=await Promise.all(chosen.map((d,i)=>Math.abs(i-at)<=1?loadDocument(d.id,account):Promise.resolve({id:d.id,title:d.title,pages:[],source:d.format,sourceKey:d.sourceKey??d.id,manifestRevision:d.generation,revisionId:d.revisionId,workId:unit.workId,retention:'offline' as const,createdAt:d.createdAt,updatedAt:d.updatedAt,pageId:'',relativeOffset:0,discoveryComplete:false,knownTotal:d.pageCount})));
  return {copies,directory:{title:work?.title??doc.title,catalogCount:0,entries:chosen.map(d=>({id:d.id,title:units.find(u=>u.id===d.unitId)?.title??d.title,kind:'copy',group:units.find(u=>u.id===d.unitId)?.role==='extra'?'番外':'目录',copyId:d.id,current:d.id===documentId,read:units.find(u=>u.id===d.unitId)?.readAt!==undefined,available:d.pageCount??0,total:d.pageCount,status:d.indexState==='ready'?'可以阅读':d.error??'正在建立目录'}))}};
}
export interface DirectoryEntry {id:string;title:string;number?:string;kind:'chapter'|'publication'|'copy';group:string;copyId?:string;pageId?:string;current:boolean;read:boolean;available:number;total?:number;status:string;error?:string;}
export interface ReadingDirectory {title:string;entries:DirectoryEntry[];catalogUrl?:string;catalogCount:number;}
export async function saveReaderState(copy:ReadingCopy){
  if(!copy.revisionId)return;
  const doc=await catalog.get('documents',copy.id);if(!doc||doc.revisionId!==copy.revisionId)return;
  if(copy.pageId&&copy.lastReadAt!==undefined)await catalog.savePosition({id:copy.id,workId:copy.workId??'',documentId:copy.id,revisionId:copy.revisionId,pageId:copy.pageId,relativeOffset:Math.max(0,Math.min(1,copy.relativeOffset)),updatedAt:copy.lastReadAt});
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
export async function removeDocument(id:string,options:{expectedUnitId?:string}={}){
  await releaseRemoved(await catalog.deleteDocument(id,options));
}
async function releaseRemoved(removed:Awaited<ReturnType<typeof catalog.deleteDocument>>){
  await Promise.all(removed.documentIds.flatMap(id=>[sourcePageCache.deleteOwner(id,true),sourceRangeCache.deleteOwner(id,true),thumbnailCache.deleteOwner(id,true),downloadStore.deleteOwner(id,true)]));
  for(const revision of removed.revisions){const ids=new Set([...(revision.containerId?[revision.containerId]:[]),...(Array.isArray(revision.sourceSnapshot?.containerIds)?revision.sourceSnapshot.containerIds.filter((id):id is string=>typeof id==='string'):[])]);for(const id of ids)await releaseContainer(id,revision.id);}
}
export async function removeWork(id:string){await releaseRemoved(await catalog.deleteWork(id));}
export const renameWork=(id:string,title:string)=>updateWork(id,{title});
export const subscribeLibrary=catalog.subscribe;
export const markRead=markDocumentRead;
export const completePageList=(copy:ReadingCopy)=>copy.discoveryComplete&&(!copy.knownTotal||copy.knownTotal===copy.pages.length);
export const coverReference=(doc:Document)=>doc.coverPageId?pageReference({documentId:doc.id,revisionId:doc.revisionId,pageId:doc.coverPageId,renderProfileId:RENDER_PROFILE}):undefined;
export type { Work, ReadingUnit, Document };
