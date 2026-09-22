import { msg } from '../i18n/runtime';
import { imageIdentity } from '../importers/hash';
import { emptyPage } from '../reader/model';
import type { PageManifest } from '../sources';
import { copyOrigins, discoverEntry, ImagePermissionsRequired, inExtension, requestImagePermissions, requireImagePermissions, sourceImage } from '../sources';
import type { Page, ReadingCopy } from '../types';
import { orderAcquisitionTasks } from './acquisition-order';
import { cacheSize, editLibrary, enforceCacheBudget, getBlob, putBlob, readCopies, readLibrary } from './store';
export async function queueCopies(ids:string[],offline=true){await editLibrary((s,copies)=>{for(const id of new Set(ids)){const c=copies.find(c=>c.id===id);if(!c?.sourceEntryId)continue;if(offline)c.retention='offline';let t=s.tasks.find(t=>t.copyId===id);if(t?.status==='running'||c.discoveryComplete&&c.pages.length&&c.pages.every(p=>p.blobKey))continue;if(!t){t={id:crypto.randomUUID(),copyId:id,status:'queued',phase:'discover',completed:0,updatedAt:Date.now()};s.tasks.push(t);}t.status='queued';t.error=undefined;t.updatedAt=Date.now();}orderAcquisitionTasks(s,copies);});}
export async function pauseCopies(ids:string[]){await editLibrary(s=>{for(const t of s.tasks)if(ids.includes(t.copyId)&&t.status!=='complete'){t.status='paused';t.error=msg("已暂停，重新打开后可继续。");t.updatedAt=Date.now();}});}
export async function grantImagePermissions(ids:string[],copies:ReadingCopy[],preparedOrigins:string[]=[]){
 // Use the rendered copies so permissions.request runs directly from the click,
 // before any IndexedDB await can lose Chrome's required user activation.
 await requestImagePermissions([...copyOrigins(copies.filter(c=>ids.includes(c.id))),...preparedOrigins]);
 await queueCopies(ids);
}
export class AcquisitionCoordinator{
 private stopped=false;private controller=new AbortController();
 stop(){this.stopped=true;this.controller.abort();}
 async run(limitMb:number){
  limitMb=limitMb===-1?Infinity:limitMb;
  if(!inExtension()||this.stopped)return;
  if(!(await readLibrary()).tasks.some(t=>t.status==='queued'||t.status==='running'))return;
  await navigator.locks.request('nc-library-acquisition',{ifAvailable:true},async lock=>{
   if(!lock||this.stopped)return;
   // Holding the origin-wide lock proves no other page currently owns a running task.
   if((await readLibrary()).tasks.some(t=>t.status==='running'))await editLibrary(s=>{for(const t of s.tasks)if(t.status==='running'){t.status='paused';t.error=msg("采集页面已关闭，点击继续恢复。");}});
   while(!this.stopped){
    // Select and claim in one transaction, including queues saved by older builds.
    const task=await editLibrary((s,copies)=>{if(this.stopped)return;orderAcquisitionTasks(s,copies);const next=s.tasks.find(t=>t.status==='queued');if(next){next.status='running';next.error=undefined;next.updatedAt=Date.now();}return next;});
    if(!task)break;
    try{await this.acquire(task.copyId,limitMb);}catch(e){await editLibrary(s=>{const t=s.tasks.find(t=>t.id===task.id);if(t&&t.status!=='paused'){t.status=this.stopped||e instanceof ImagePermissionsRequired?'paused':'failed';t.error=e instanceof Error?e.message:msg("采集失败");t.updatedAt=Date.now();}});}
   }
  });
 }
 private async active(copyId:string){this.controller.signal.throwIfAborted();const s=await readLibrary();if(!s.tasks.some(t=>t.copyId===copyId&&t.status==='running'))throw Error(msg("已暂停或移除采集任务。"));}
 private async acquire(copyId:string,limitMb:number){
  await this.active(copyId);
  let copy=(await readCopies()).find(c=>c.id===copyId);if(!copy)throw Error(msg("副本已移除。"));
  const state=await readLibrary(),catalog=state.catalogs.find(c=>c.entries.some(e=>e.id===copy!.sourceEntryId));if(!catalog)throw Error(msg("来源目录不存在。"));
  const refresh=!copy.sourcePagesEdited&&(!copy.discoveryComplete||copy.pages.some(p=>p.fetchError&&p.sourceUrl));
  const controller=new AbortController(),signal=AbortSignal.any([this.controller.signal,controller.signal]);
  let available=refresh?0:copy.pages.length,discoveryDone=!refresh,wake:(()=>void)|undefined;
  const active=async()=>{signal.throwIfAborted();await this.active(copyId);};
  const update=async(manifest:PageManifest)=>{
   await active();
   await editLibrary((s,copies)=>{
    const c=copies.find(c=>c.id===copyId),t=s.tasks.find(t=>t.copyId===copyId);if(!c||!t)return;
    if(c.discoveryComplete&&manifest.knownTotal&&c.pages.length!==manifest.knownTotal||manifest.discoveryComplete&&c.pages.length>manifest.items.length)throw Error(msg("来源页数发生修订，请保留当前副本并重新导入修订版。"));
    // A restarted source can expose a shorter prefix; retain saved suffix pages and identities.
    const pages=[...c.pages];
    for(const [n,item] of manifest.items.entries())pages[n]={...pages[n]??emptyPage(msg("第 {0} 页", {"0": (n+1)}),item.width,item.height),sourceUrl:item.url};
    c.pages=pages;c.knownTotal=manifest.knownTotal??c.knownTotal;c.discoveryComplete||=manifest.discoveryComplete;
    t.total=c.knownTotal;t.completed=pages.filter(p=>p.blobKey).length;t.phase=manifest.items.length?'images':'discover';
   });
   copy=(await readCopies()).find(c=>c.id===copyId)!;
   // Check newly exposed hosts before making any image request, including later CDN changes.
   await requireImagePermissions(manifest.items.map(item=>item.url));
   available=manifest.items.length;wake?.();
  };
  const discover=async()=>{
   try{if(refresh){const manifest=await discoverEntry(catalog,copy!.sourceEntryId!,signal,update,active);await update(manifest);}}
   finally{discoveryDone=true;wake?.();}
  };
  let failures=0;
  const download=async()=>{
   let index=0;
   while(true){
    await active();
    if(index>=available){if(discoveryDone)return;await new Promise<void>(resolve=>{wake=resolve;});continue;}
    const page=copy!.pages[index++];
    if(page.blobKey&&await getBlob(page.blobKey))continue;
    if(page.sourceUrl)await requireImagePermissions([page.sourceUrl]);
    await editLibrary(s=>{const t=s.tasks.find(t=>t.copyId===copyId);if(t){t.phase='images';t.total=copy!.knownTotal??(discoveryDone?copy!.pages.length:undefined);}});
    try{
     if(!page.sourceUrl)throw Error(msg("原图地址缺失，请重新发现。"));
     const blob=await sourceImage(page.sourceUrl,signal);
     const bitmap=await createImageBitmap(blob);const width=bitmap.width,height=bitmap.height;bitmap.close();if(!width||!height||width*height>100000000)throw Error(msg("原图尺寸不可用。"));
     const identity=await imageIdentity(blob),blobKey='original:'+identity.imageSha256;
     if(!await getBlob(blobKey)){await enforceCacheBudget(await readCopies(),Math.max(0,limitMb-blob.size/1024/1024),copyId);if(await cacheSize()+blob.size>limitMb*1024*1024)throw Object.assign(Error(msg("本地空间预算不足，请提高缓存上限或清理副本后继续。")),{code:'CACHE_BUDGET'});await putBlob(blobKey,blob);}
     await active();await this.patch(copyId,page.id,{...identity,blobKey,width,height,fetchError:undefined});
    }catch(e){await active();const message=e instanceof Error?e.message:msg("原图获取失败");await this.patch(copyId,page.id,{fetchError:message});if((e as {code?:string}).code==='CACHE_BUDGET')throw e;failures++;}
   }
  };
  const fail=(error:unknown)=>{controller.abort(error);wake?.();throw error;};
  await Promise.allSettled([discover().catch(fail),download().catch(fail)]);
  signal.throwIfAborted();await this.active(copyId);
  await editLibrary((s,copies)=>{const t=s.tasks.find(t=>t.copyId===copyId),c=copies.find(c=>c.id===copyId);if(t&&c){t.completed=c.pages.filter(p=>p.blobKey).length;t.status=failures?'failed':'complete';t.error=failures?msg("{0} 页获取失败，已完成页面可以阅读。", {"0": failures}):undefined;t.updatedAt=Date.now();}});
 }
 private async patch(copyId:string,pageId:string,patch:Partial<Page>){await editLibrary((s,copies)=>{const c=copies.find(c=>c.id===copyId);const p=c?.pages.find(p=>p.id===pageId);if(p)Object.assign(p,patch);const t=s.tasks.find(t=>t.copyId===copyId);if(t&&c){t.completed=c.pages.filter(p=>p.blobKey).length;t.updatedAt=Date.now();}});}
}
