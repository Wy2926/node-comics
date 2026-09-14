import { defaults, type Chapter, type Settings, type User } from '../types';
import {normalizeConcurrency} from '../concurrency';
import {mergeJobs} from './recovery';
const DB = 'node-comics-v1';
export function readPosition(chapterId:string):{pageId:string;relativeOffset:number}|null {try{const value=JSON.parse(localStorage.getItem(`nc-position:${chapterId}`)??'null');return typeof value?.pageId==='string'&&Number.isFinite(value.relativeOffset)?value:null;}catch{return null;}}
export function savePosition(chapterId:string,position:{pageId:string;relativeOffset:number}){localStorage.setItem(`nc-position:${chapterId}`,JSON.stringify({...position,relativeOffset:Math.max(0,Math.min(1,position.relativeOffset)),updatedAt:Date.now()}));}
let opening: Promise<IDBDatabase>;
function db() { return opening ??= new Promise((resolve,reject) => { const r = indexedDB.open(DB,1); r.onupgradeneeded=()=> { r.result.createObjectStore('chapters',{keyPath:'id'}); r.result.createObjectStore('blobs',{keyPath:'id'}); }; r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); }); }
async function transaction<T>(store: string, mode: IDBTransactionMode, action: (s: IDBObjectStore)=>IDBRequest<T>): Promise<T> { const d=await db(); return new Promise((resolve,reject)=> { const t=d.transaction(store,mode); const req=action(t.objectStore(store)); t.oncomplete=()=>resolve(req.result); t.onerror=()=>reject(t.error); t.onabort=()=>reject(t.error); }); }
export const readChapters = async () => {
  const chapters=(await transaction<Chapter[]>('chapters','readonly',s=>s.getAll())).sort((a,b)=>b.updatedAt-a.updatedAt);
  const available=new Set(await transaction<IDBValidKey[]>('blobs','readonly',s=>s.getAllKeys()));
  for(const c of chapters){const position=readPosition(c.id);if(position&&c.pages.some(p=>p.id===position.pageId))Object.assign(c,position);let changed=false;c.pages=c.pages.map(p=>{
    const blobKey=p.blobKey&&available.has(p.blobKey)?p.blobKey:undefined;
    const outputBlobs=Object.fromEntries(Object.entries(p.outputBlobs).filter(([,key])=>available.has(key)));
    if(blobKey!==p.blobKey||Object.keys(outputBlobs).length!==Object.keys(p.outputBlobs).length){changed=true;return {...p,blobKey,outputBlobs,...(!blobKey?{fetchError:'本地图片已清理，请重新导入或返回来源获取。'}:{})};}return p;
  });if(changed)await saveChapter(c);}
  return chapters;
};
export async function saveChapter(chapter: Chapter):Promise<void>{
  const database=await db();
  await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction('chapters','readwrite');const records=tx.objectStore('chapters');const request=records.get(chapter.id);
    request.onsuccess=()=>{
      const previous=request.result as Chapter|undefined;
      const rank:Record<string,number>={queued:0,running:1,outcome_unknown:2,failed:3,cancelled:3,no_text:3,succeeded:4};
      const pages=chapter.pages.map(page=>{
        const existing=previous?.pages.find(p=>p.id===page.id);
        if(!existing||page.ownerId&&(page.ownerId!==existing.ownerId||page.apiOrigin!==existing.apiOrigin))return page;
        const jobs=new Map(existing.jobs.map(job=>[job.id,job]));
        for(const job of page.jobs){const old=jobs.get(job.id);if(!old||(rank[job.status]??0)>=(rank[old.status]??0))jobs.set(job.id,old?.status==='succeeded'&&!old.output_asset_id&&job.output_asset_id?{...job,output_asset_id:null}:job);}
        const useExistingAsset=!page.assetId||Date.parse(existing.assetExpiresAt??'')>Date.parse(page.assetExpiresAt??'');
        return {...page,...(useExistingAsset?{assetId:existing.assetId,assetExpiresAt:existing.assetExpiresAt,ownerId:existing.ownerId,apiOrigin:existing.apiOrigin}:{}),jobs:mergeJobs([], [...jobs.values()])};
      });
      records.put({...chapter,pages});
    };
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
export const getBlob = async (id: string) => (await transaction<{id: string; blob: Blob}>('blobs','readonly',s=>s.get(id)))?.blob;
export const putBlob = (id: string, blob: Blob) => transaction('blobs','readwrite',s=>s.put({id,blob,usedAt:Date.now()}));
export const removeBlob = (id: string) => transaction('blobs','readwrite',s=>s.delete(id));
export async function deleteChapter(chapter: Chapter) { for (const p of chapter.pages) for(const key of [p.blobKey,...Object.values(p.outputBlobs)].filter(Boolean)) await removeBlob(key!); await transaction('chapters','readwrite',s=>s.delete(chapter.id));localStorage.removeItem(`nc-position:${chapter.id}`); }
export async function clearImages(chapters: Chapter[]) { await transaction('blobs','readwrite',s=>s.clear()); for (const c of chapters) { c.pages=c.pages.map(p=>({...p,blobKey:undefined,outputBlobs:{},fetchError:'本地图片已清理，请返回来源重新获取或导入原图。'})); await saveChapter(c); } }
export function settings(): Settings { try { const value=JSON.parse(localStorage.getItem('nc-settings')??'{}');return {...defaults,...value,requestConcurrency:normalizeConcurrency(value.requestConcurrency),autoTranslate:false}; } catch {return {...defaults};} }
export function saveSettings(value: Settings) { localStorage.setItem('nc-settings',JSON.stringify({...value,autoTranslate:false})); if (typeof chrome!=='undefined' && chrome.storage?.local) void chrome.storage.local.set({preferences:{language:value.language,direction:value.direction,layout:value.layout,fit:value.fit}}); }
export interface Session {token:string;user:User;apiOrigin:string;}
export function session(): Session|null { try {const value=JSON.parse(localStorage.getItem('nc-session')??'null');return value?.apiOrigin===new URL(settings().apiBase).origin?value:null;} catch{return null;} }
export function saveSession(value: Session|null) { if(value)localStorage.setItem('nc-session',JSON.stringify(value));else localStorage.removeItem('nc-session'); }
export async function enforceCacheBudget(chapters: Chapter[], limitMb: number, protectedChapterId?: string) {
  const all=await transaction<{id:string;blob:Blob;usedAt:number}[]>('blobs','readonly',s=>s.getAll());let total=all.reduce((n,b)=>n+b.blob.size,0);const limit=limitMb*1024*1024;if(total<=limit)return;
  const protectedKeys=new Set(chapters.filter(c=>c.id===protectedChapterId).flatMap(c=>c.pages.flatMap(p=>[p.blobKey,...Object.values(p.outputBlobs)])));const removed=new Set<string>();
  for(const b of all.sort((a,b)=>a.usedAt-b.usedAt)){if(total<=limit)break;if(!protectedKeys.has(b.id)){await removeBlob(b.id);removed.add(b.id);total-=b.blob.size;}}
  for(const chapter of chapters){let changed=false;chapter.pages=chapter.pages.map(page=>{const outputBlobs=Object.fromEntries(Object.entries(page.outputBlobs).filter(([,key])=>!removed.has(key)));const lostOriginal=!!page.blobKey&&removed.has(page.blobKey);if(lostOriginal||Object.keys(outputBlobs).length!==Object.keys(page.outputBlobs).length){changed=true;return {...page,blobKey:lostOriginal?undefined:page.blobKey,outputBlobs,...(lostOriginal?{fetchError:'本地缓存达到上限，原图已清理，请重新导入。'}:{})};}return page;});if(changed)await saveChapter(chapter);}
}
export async function cacheSize() {return (await transaction<{blob:Blob}[]>('blobs','readonly',s=>s.getAll())).reduce((n,b)=>n+b.blob.size,0);}
