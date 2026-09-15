import { defaults, type ReadingCopy, type Settings, type User } from '../types';
import {normalizeConcurrency} from '../concurrency';
import {mergeJobs} from '../reader/jobs';
import {attachCopy,emptyLibrary,validateLibrary} from './model';
import type {ImportAssignment,LibraryState,SourceCatalog} from './types';
import {sourcePageIdentity} from '../sources/mangacopy';
const DB = 'node-comics-library';
export function readPosition(copyId:string,revision:number):{pageId:string;relativeOffset:number}|null {try{const value=JSON.parse(localStorage.getItem(`nc-copy-position:${copyId}:${revision}`)??'null');return typeof value?.pageId==='string'&&Number.isFinite(value.relativeOffset)?value:null;}catch{return null;}}
export function savePosition(copyId:string,revision:number,position:{pageId:string;relativeOffset:number}){localStorage.setItem(`nc-copy-position:${copyId}:${revision}`,JSON.stringify({...position,relativeOffset:Math.max(0,Math.min(1,position.relativeOffset)),updatedAt:Date.now()}));}
let opening: Promise<IDBDatabase>;
function db() { return opening ??= new Promise((resolve,reject) => { const r = indexedDB.open(DB,1); r.onupgradeneeded=()=> { r.result.createObjectStore('copies',{keyPath:'id'}).createIndex('sourceKey','sourceKey',{unique:true}); r.result.createObjectStore('blobs',{keyPath:'id'});r.result.createObjectStore('library',{keyPath:'id'}); }; r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); }); }
async function transaction<T>(store: string, mode: IDBTransactionMode, action: (s: IDBObjectStore)=>IDBRequest<T>): Promise<T> { const d=await db(); return new Promise((resolve,reject)=> { const t=d.transaction(store,mode); const req=action(t.objectStore(store)); t.oncomplete=()=>resolve(req.result); t.onerror=()=>reject(t.error); t.onabort=()=>reject(t.error); }); }
export const readCopies = async () => {
  const copies=(await transaction<ReadingCopy[]>('copies','readonly',s=>s.getAll())).sort((a,b)=>b.updatedAt-a.updatedAt);
  const available=new Set(await transaction<IDBValidKey[]>('blobs','readonly',s=>s.getAllKeys()));
  for(const c of copies){const position=readPosition(c.id,c.manifestRevision);if(position&&c.pages.some(p=>p.id===position.pageId))Object.assign(c,position);let changed=false;c.pages=c.pages.map(p=>{
    const blobKey=p.blobKey&&available.has(p.blobKey)?p.blobKey:undefined;
    const outputBlobs=Object.fromEntries(Object.entries(p.outputBlobs).filter(([,key])=>available.has(key)));
    if(blobKey!==p.blobKey||Object.keys(outputBlobs).length!==Object.keys(p.outputBlobs).length){changed=true;return {...p,blobKey,outputBlobs,...(!blobKey?{fetchError:'本地图片已清理，请重新导入或返回来源获取。'}:{})};}return p;
  });if(changed)await saveCopy(c);}
  return copies;
};
export async function saveCopy(copy: ReadingCopy):Promise<void>{
  const database=await db();
  await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction(['copies','blobs'],'readwrite');const records=tx.objectStore('copies');const request=records.get(copy.id);const keys=tx.objectStore('blobs').getAllKeys();
    keys.onsuccess=()=>{
      const previous=request.result as ReadingCopy|undefined;
      if(!previous||previous.manifestRevision>copy.manifestRevision)return;
      const available=new Set(keys.result);
      const input=previous.manifestRevision===copy.manifestRevision?previous.pages.map(p=>copy.pages.find(incoming=>incoming.id===p.id)??p):copy.pages;
      const pages=input.map(page=>{
        const existing=previous?.pages.find(p=>p.id===page.id);
        if(!existing||page.ownerId&&(page.ownerId!==existing.ownerId||page.apiOrigin!==existing.apiOrigin))return page;
        const useExistingAsset=!page.assetId||(page.assetExpiresAt===undefined&&existing.assetExpiresAt!==undefined);
        const blobKey=page.blobKey??existing.blobKey;
        return {...page,...(!page.blobKey&&existing.blobKey?{width:existing.width,height:existing.height,imageSha256:existing.imageSha256,fileHash:existing.fileHash,pageIndex:existing.pageIndex,sourceUrl:existing.sourceUrl}:{}),blobKey:blobKey&&available.has(blobKey)?blobKey:undefined,outputBlobs:Object.fromEntries(Object.entries({...existing.outputBlobs,...page.outputBlobs}).filter(([,key])=>available.has(key))),...(useExistingAsset?{assetId:existing.assetId,assetExpiresAt:existing.assetExpiresAt,ownerId:existing.ownerId,apiOrigin:existing.apiOrigin}:{}),jobs:mergeJobs(existing.jobs,page.jobs)};
      });
      records.put({...previous,lastReadAt:copy.lastReadAt??previous.lastReadAt,pageId:copy.pageId,relativeOffset:copy.relativeOffset,manifestRevision:copy.manifestRevision,pages});
    };
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
export const getBlob = async (id: string) => (await transaction<{id: string; blob: Blob}>('blobs','readonly',s=>s.get(id)))?.blob;
export const putBlob = (id: string, blob: Blob) => transaction('blobs','readwrite',s=>s.put({id,blob,usedAt:Date.now()}));
export const removeBlob = (id: string) => transaction('blobs','readwrite',s=>s.delete(id));
export async function deleteCopy(copy: ReadingCopy) {await editLibrary((s,copies)=>{s.coverage=s.coverage.filter(c=>c.copyId!==copy.id);s.tasks=s.tasks.filter(t=>t.copyId!==copy.id);const at=copies.findIndex(c=>c.id===copy.id);if(at>=0)copies.splice(at,1);for(const catalog of s.catalogs)if(copy.sourceEntryId&&catalog.entries.some(e=>e.id===copy.sourceEntryId))catalog.excludedEntryIds=[...new Set([...catalog.excludedEntryIds,copy.sourceEntryId])];});await collectUnusedBlobs(copyBlobKeys(copy));}
export async function clearImages(copies: ReadingCopy[]) { await transaction('blobs','readwrite',s=>s.clear()); for (const c of copies) { c.pages=c.pages.map(p=>({...p,blobKey:undefined,outputBlobs:{},fetchError:'本地图片已清理，请返回来源重新获取或导入原图。'})); await saveCopy(c); } }
export function settings(): Settings {
  try {
    const value=JSON.parse(localStorage.getItem('nc-settings')??'{}');const merged=knownSettings(value);
    const enums={appearance:['system','light','dark'],accentTheme:['sky','rose','mint','iris'],libraryLayout:['grid','list'],readerBackground:['gray','paper','night'],translationMode:['classic','redraw'],direction:['ltr','rtl'],layout:['continuous','single'],fit:['width','window']} as const;
    for(const key of Object.keys(enums) as (keyof typeof enums)[])if(!(enums[key] as readonly string[]).includes(merged[key]))Object.assign(merged,{[key]:defaults[key]});
    return {...merged,autoShowTranslation:typeof value.autoShowTranslation==='boolean'?value.autoShowTranslation:true,textScale:[1,1.125,1.25].includes(value.textScale)?value.textScale:1,requestConcurrency:normalizeConcurrency(value.requestConcurrency)};
  } catch {return {...defaults};}
}
function knownSettings(value:Partial<Settings>):Settings {
  return Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>[key,value?.[key as keyof Settings]??fallback])) as unknown as Settings;
}
export function saveSettings(value: Settings) { localStorage.setItem('nc-settings',JSON.stringify(knownSettings(value))); if (typeof chrome!=='undefined' && chrome.storage?.local) void chrome.storage.local.set({preferences:{language:value.language,direction:value.direction,layout:value.layout,fit:value.fit}}); }
export interface Session {token:string;user:User;apiOrigin:string;}
export function session(): Session|null { try {const value=JSON.parse(localStorage.getItem('nc-session')??'null');return value?.apiOrigin===new URL(settings().apiBase).origin?value:null;} catch{return null;} }
export function saveSession(value: Session|null) { if(value)localStorage.setItem('nc-session',JSON.stringify(value));else localStorage.removeItem('nc-session'); }
export async function enforceCacheBudget(copies: ReadingCopy[], limitMb: number, protectedCopyId?: string) {
  const all=await transaction<{id:string;blob:Blob;usedAt:number}[]>('blobs','readonly',s=>s.getAll());let total=all.reduce((n,b)=>n+b.blob.size,0);const limit=limitMb*1024*1024;if(total<=limit)return;
  const protectedKeys=new Set(copies.filter(c=>c.id===protectedCopyId||c.retention==='offline').flatMap(c=>c.pages.flatMap(p=>[p.blobKey,...Object.values(p.outputBlobs)])));const removed=new Set<string>();
  for(const b of all.sort((a,b)=>a.usedAt-b.usedAt)){if(total<=limit)break;if(!protectedKeys.has(b.id)){await removeBlob(b.id);removed.add(b.id);total-=b.blob.size;}}
  for(const copy of copies){let changed=false;copy.pages=copy.pages.map(page=>{const outputBlobs=Object.fromEntries(Object.entries(page.outputBlobs).filter(([,key])=>!removed.has(key)));const lostOriginal=!!page.blobKey&&removed.has(page.blobKey);if(lostOriginal||Object.keys(outputBlobs).length!==Object.keys(page.outputBlobs).length){changed=true;return {...page,blobKey:lostOriginal?undefined:page.blobKey,outputBlobs,...(lostOriginal?{fetchError:'本地缓存达到上限，原图已清理，请重新导入。'}:{})};}return page;});if(changed)await saveCopy(copy);}
}
export async function cacheSize() {return (await transaction<{blob:Blob}[]>('blobs','readonly',s=>s.getAll())).reduce((n,b)=>n+b.blob.size,0);}

export const readLibrary=async():Promise<LibraryState>=>(await transaction<LibraryState|undefined>('library','readonly',s=>s.get('library')))??emptyLibrary();
/** One IDB transaction serializes metadata changes and source-key deduplication across tabs. */
export async function editLibrary<T>(change:(s:LibraryState,copies:ReadingCopy[])=>T):Promise<T>{
 const database=await db();return new Promise((resolve,reject)=>{
  const tx=database.transaction(['library','copies'],'readwrite'),meta=tx.objectStore('library'),records=tx.objectStore('copies');
  const request=meta.get('library'),all=records.getAll();let result:T;let failure:unknown;
  all.onsuccess=()=>{try{const state:LibraryState=request.result??emptyLibrary(),copies:ReadingCopy[]=all.result;const before=new Set(copies.map(c=>c.id));result=change(state,copies);validateLibrary(state);for(const w of state.works){if(w.preferredCopyId&&!state.coverage.some(c=>c.copyId===w.preferredCopyId&&c.workId===w.id))w.preferredCopyId=undefined;if(w.coverCopyId&&!state.coverage.some(c=>c.copyId===w.coverCopyId&&c.workId===w.id))w.coverCopyId=undefined;}state.revision++;meta.put(state);for(const c of copies){records.put(c);before.delete(c.id);}for(const id of before)records.delete(id);}catch(e){failure=e;tx.abort();}};
  tx.oncomplete=()=>{windowDispatch();resolve(result);};tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??tx.error);
 });
}
function windowDispatch(){if(typeof window!=='undefined')window.dispatchEvent(new Event('nc-library-change'));}
export async function commitCopies(incoming:ReadingCopy[],assignments:ImportAssignment[],catalog?:SourceCatalog){
 return editLibrary((s,copies)=>{
  if(incoming.length!==assignments.length)throw Error('导入归属数量不一致。');
  const workIds:string[]=[],copyIds:string[]=[];let created=0;
  let commonWork=assignments[0]?.workId??s.catalogs.find(c=>c.id===catalog?.id)?.workId;
  for(const [i,copy] of incoming.entries()){
   const normalizedKey=(value:ReadingCopy)=>{const digest=value.sourceKey.match(/:([a-f0-9]{64})$/)?.[1];return value.sourceKey.startsWith('web:')&&value.sourceUrl&&digest?'web:'+sourcePageIdentity(value.sourceUrl)+':'+digest:value.sourceKey;};
   const existing=copies.find(c=>normalizedKey(c)===normalizedKey(copy));
   if(existing){
    // Exact source identity only; title and page-subset heuristics are deliberately absent.
    if(copy.pages.length&&existing.pages.length===copy.pages.length)existing.pages=existing.pages.map((page,n)=>{
     const fresh=copy.pages[n];
     const sameBytes=!!page.imageSha256&&page.imageSha256===fresh.imageSha256;
     const neverFetched=!page.imageSha256&&!!page.sourceUrl&&page.sourceUrl===fresh.sourceUrl;
     if(!fresh.blobKey||!sameBytes&&!neverFetched)return page;
     return {...page,...(neverFetched?{width:fresh.width,height:fresh.height,imageSha256:fresh.imageSha256,fileHash:fresh.fileHash,pageIndex:fresh.pageIndex}:{}),blobKey:fresh.blobKey,fetchError:undefined};
    });
    copyIds.push(existing.id);continue;
   }
   const assignment={...assignments[i]};if(!assignment.workId&&!catalog?.entries.find(e=>e.id===copy.sourceEntryId)?.related&&commonWork)assignment.workId=commonWork;
   const workId=attachCopy(s,copy,assignment);if(!catalog?.entries.find(e=>e.id===copy.sourceEntryId)?.related)commonWork??=workId;
   workIds.push(workId);copyIds.push(copy.id);copies.push(copy);created++;
  }
  if(catalog){const existing=s.catalogs.find(c=>c.id===catalog.id);if(!existing){s.catalogs.push({...catalog,workId:commonWork});}else{existing.workId??=commonWork;for(const e of catalog.entries){const at=existing.entries.findIndex(x=>x.id===e.id);if(at<0)existing.entries.push(e);else existing.entries[at]=e;}existing.excludedEntryIds=existing.excludedEntryIds.filter(id=>!incoming.some(c=>c.sourceEntryId===id));if(catalog.complete){existing.groups=catalog.groups;existing.observedAt=catalog.observedAt;existing.complete=true;}}}
  return {workIds,copyIds,created};
 });
}
export async function removeWork(workId:string){
 const candidates=(await readCopies()).flatMap(copyBlobKeys);
 await editLibrary((s,copies)=>{
  const owned=s.coverage.filter(c=>c.workId===workId).map(c=>c.copyId);s.coverage=s.coverage.filter(c=>c.workId!==workId);
  const deleted=new Set(owned.filter(id=>!s.coverage.some(c=>c.copyId===id)));
  for(let i=copies.length-1;i>=0;i--)if(deleted.has(copies[i].id)){const entryId=copies[i].sourceEntryId;for(const catalog of s.catalogs)if(entryId&&catalog.entries.some(e=>e.id===entryId))catalog.excludedEntryIds=[...new Set([...catalog.excludedEntryIds,entryId])];copies.splice(i,1);}
  s.works=s.works.filter(w=>w.id!==workId);s.chapters=s.chapters.filter(c=>c.workId!==workId);s.versions=s.versions.filter(v=>v.workId!==workId);s.series=s.series.map(e=>({...e,workIds:e.workIds.filter(id=>id!==workId)})).filter(e=>e.workIds.length);s.publications=s.publications.map(p=>({...p,workIds:p.workIds.filter(id=>id!==workId)})).filter(p=>p.workIds.length);for(const p of s.publications)if(p.seriesId&&!s.series.some(e=>e.id===p.seriesId))p.seriesId=undefined;for(const c of copies)if(c.versionId&&!s.versions.some(v=>v.id===c.versionId))c.versionId=undefined;s.inclusions=s.inclusions.filter(i=>s.publications.some(p=>p.id===i.publicationId)&&(i.target.kind==='work'?s.works:s.chapters).some(t=>t.id===i.target.id));s.publicationRelations=s.publicationRelations.filter(r=>s.publications.some(p=>p.id===r.fromId)&&s.publications.some(p=>p.id===r.toId));s.relations=s.relations.filter(r=>r.fromId!==workId&&r.toId!==workId);s.tasks=s.tasks.filter(t=>!deleted.has(t.copyId));for(const c of s.catalogs)if(c.workId===workId)c.workId=undefined;
 });await collectUnusedBlobs(candidates);
}
export async function collectUnusedBlobs(candidates:string[]){const database=await db();await new Promise<void>((resolve,reject)=>{const tx=database.transaction(['copies','blobs'],'readwrite');const req=tx.objectStore('copies').getAll();req.onsuccess=()=>{const used=new Set((req.result as ReadingCopy[]).flatMap(c=>c.pages.flatMap(p=>[p.blobKey,...Object.values(p.outputBlobs)])));for(const key of new Set(candidates))if(!used.has(key))tx.objectStore('blobs').delete(key);};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
export const copyBlobKeys=(copy:ReadingCopy)=>copy.pages.flatMap(p=>[p.blobKey,...Object.values(p.outputBlobs)]).filter((key):key is string=>!!key);
export async function clearCopyImages(copyId:string){const copy=(await readCopies()).find(c=>c.id===copyId);if(!copy)return;await editLibrary((s,copies)=>{const current=copies.find(c=>c.id===copyId);if(current){current.pages=current.pages.map(p=>({...p,blobKey:undefined,outputBlobs:{}}));current.retention='cache';}const task=s.tasks.find(t=>t.copyId===copyId);if(task){task.status='paused';task.error='本地副本已清理，可补齐原图。';}});await collectUnusedBlobs(copyBlobKeys(copy));}
export async function forkSourceRevision(copyId:string){return editLibrary((s,copies)=>{const copy=copies.find(c=>c.id===copyId);if(!copy?.sourceEntryId)throw Error('此副本没有可重新解析的来源。');const revised={...copy,id:crypto.randomUUID(),sourceKey:copy.sourceEntryId+':revision:'+crypto.randomUUID(),manifestRevision:copy.manifestRevision+1,pages:[],pageId:'',relativeOffset:0,sourcePagesEdited:undefined,webImports:undefined,discoveryComplete:false,lastReadAt:undefined,createdAt:Date.now(),updatedAt:Date.now()};copies.push(revised);s.coverage.push(...s.coverage.filter(c=>c.copyId===copyId).map(c=>({...c,id:crypto.randomUUID(),copyId:revised.id})));return revised.id;});}
export async function markCopyRead(copyId:string){await editLibrary(s=>{for(const c of s.coverage.filter(c=>c.copyId===copyId&&!c.startPageId&&!c.endPageId)){const target=c.target.kind==='chapter'?s.chapters.find(x=>x.id===c.target.id):c.target.kind==='publication'?s.publications.find(x=>x.id===c.target.id):c.target.kind==='work'?s.works.find(x=>x.id===c.workId):undefined;if(target&&!target.readAt)target.readAt=Date.now();}});}
