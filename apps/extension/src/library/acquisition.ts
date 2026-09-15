import {emptyPage} from '../reader/model';
import {imageIdentity} from '../importers/hash';
import {discoverEntry,inExtension} from '../sources/client';
import type {PageManifest} from '../sources/adapters';
import {sourceImage} from '../sources/image-fetch';
import {editLibrary,readLibrary,readCopies,getBlob,putBlob,enforceCacheBudget,cacheSize} from './store';
import type {Page,ReadingCopy} from '../types';
export async function queueCopies(ids:string[],offline=true){await editLibrary((s,copies)=>{for(const id of new Set(ids)){const c=copies.find(c=>c.id===id);if(!c?.sourceEntryId)continue;if(offline)c.retention='offline';let t=s.tasks.find(t=>t.copyId===id);if(t?.status==='running'||c.discoveryComplete&&c.pages.length&&c.pages.every(p=>p.blobKey))continue;if(!t){t={id:crypto.randomUUID(),copyId:id,status:'queued',phase:'discover',completed:0,updatedAt:Date.now()};s.tasks.push(t);}t.status='queued';t.error=undefined;t.updatedAt=Date.now();}});}
export async function pauseCopies(ids:string[]){await editLibrary(s=>{for(const t of s.tasks)if(ids.includes(t.copyId)&&t.status!=='complete'){t.status='paused';t.error='已暂停，重新打开后可继续。';t.updatedAt=Date.now();}});}
export async function grantImagePermissions(ids:string[],copies:ReadingCopy[]){
 // Use the rendered copies so permissions.request runs directly from the click,
 // before any IndexedDB await can lose Chrome's required user activation.
 const origins=[...new Set(copies.filter(c=>ids.includes(c.id)).flatMap(c=>[...(c.sourceUrl?[new URL(c.sourceUrl).origin+'/*']:[]),...c.pages.flatMap(p=>p.sourceUrl?[new URL(p.sourceUrl).origin+'/*']:[])]))];
 if(origins.length&&inExtension()&&!await chrome.permissions.request({origins}))throw Error('来源或图片域名未获授权；已保留采集进度，可再次点击继续。');
 await queueCopies(ids);
}
export class AcquisitionCoordinator{
 private stopped=false;private controller=new AbortController();
 stop(){this.stopped=true;this.controller.abort();}
 async run(limitMb:number){
  if(!inExtension()||this.stopped)return;
  if(!(await readLibrary()).tasks.some(t=>t.status==='queued'||t.status==='running'))return;
  await navigator.locks.request('nc-library-acquisition',{ifAvailable:true},async lock=>{
   if(!lock||this.stopped)return;
   // Holding the origin-wide lock proves no other page currently owns a running task.
   if((await readLibrary()).tasks.some(t=>t.status==='running'))await editLibrary(s=>{for(const t of s.tasks)if(t.status==='running'){t.status='paused';t.error='采集页面已关闭，点击继续恢复。';}});
   while(!this.stopped){const state=await readLibrary();const task=state.tasks.find(t=>t.status==='queued');if(!task)break;try{await this.acquire(task.copyId,limitMb);}catch(e){await editLibrary(s=>{const t=s.tasks.find(t=>t.id===task.id);if(t&&t.status!=='paused'){t.status=this.stopped?'paused':'failed';t.error=e instanceof Error?e.message:'采集失败';t.updatedAt=Date.now();}});}}
  });
 }
 private async active(copyId:string){this.controller.signal.throwIfAborted();const s=await readLibrary();if(!s.tasks.some(t=>t.copyId===copyId&&t.status==='running'))throw Error('已暂停或移除采集任务。');}
 private async acquire(copyId:string,limitMb:number){
  await editLibrary(s=>{const t=s.tasks.find(t=>t.copyId===copyId);if(t){t.status='running';t.error=undefined;}});
  let copy=(await readCopies()).find(c=>c.id===copyId);if(!copy)throw Error('副本已移除。');
  const state=await readLibrary(),catalog=state.catalogs.find(c=>c.entries.some(e=>e.id===copy!.sourceEntryId));if(!catalog)throw Error('来源目录不存在。');
  if(!copy.sourcePagesEdited&&(!copy.discoveryComplete||copy.pages.some(p=>p.fetchError&&p.sourceUrl))){
   const update=async(manifest:PageManifest)=>{await this.active(copyId);await editLibrary((s,copies)=>{const c=copies.find(c=>c.id===copyId),t=s.tasks.find(t=>t.copyId===copyId);if(!c||!t)return;t.phase='discover';t.total=manifest.knownTotal;t.completed=manifest.items.length;
    // Existing byte/page identity remains intact when refreshing only expired URLs.
    if(c.discoveryComplete&&c.pages.length!==manifest.items.length&&!manifest.discoveryComplete)return;
    if(c.discoveryComplete&&c.pages.length!==manifest.items.length)throw Error('来源页数发生修订，请保留当前副本并重新导入修订版。');
    c.pages=manifest.items.map((item,n)=>({...c.pages[n]??emptyPage('第 '+(n+1)+' 页',item.width,item.height),sourceUrl:item.url}));c.knownTotal=manifest.knownTotal;c.discoveryComplete=manifest.discoveryComplete;
   });};
   const manifest=await discoverEntry(catalog,copy.sourceEntryId!,this.controller.signal,update,()=>this.active(copyId));await update(manifest);copy=(await readCopies()).find(c=>c.id===copyId)!;
  }
  await this.active(copyId);
  const origins=[...new Set(copy.pages.flatMap(p=>p.sourceUrl?[new URL(p.sourceUrl).origin+'/*']:[]))];
  if(origins.length&&!await chrome.permissions.contains({origins}))throw Error('需要授权图片域名。点击“授权并继续”后获取原图。');
  await editLibrary(s=>{const t=s.tasks.find(t=>t.copyId===copyId);if(t){t.phase='images';t.total=copy!.pages.length;t.completed=copy!.pages.filter(p=>p.blobKey).length;}});
  let failures=0;
  for(const page of copy.pages){
   await this.active(copyId);if(page.blobKey&&await getBlob(page.blobKey))continue;
   try{
    if(!page.sourceUrl)throw Error('原图地址缺失，请重新发现。');
    const blob=await sourceImage(page.sourceUrl,this.controller.signal);
    const bitmap=await createImageBitmap(blob);const width=bitmap.width,height=bitmap.height;bitmap.close();if(!width||!height||width*height>100000000)throw Error('原图尺寸不可用。');
    const identity=await imageIdentity(blob),blobKey='original:'+identity.imageSha256;
    if(!await getBlob(blobKey)){await enforceCacheBudget(await readCopies(),Math.max(0,limitMb-blob.size/1024/1024),copyId);if(await cacheSize()+blob.size>limitMb*1024*1024)throw Error('本地空间预算不足，请提高缓存上限或清理副本后继续。');await putBlob(blobKey,blob);}
    await this.active(copyId);await this.patch(copyId,page.id,{...identity,blobKey,width,height,fetchError:undefined});
   }catch(e){await this.active(copyId);const message=e instanceof Error?e.message:'原图获取失败';await this.patch(copyId,page.id,{fetchError:message});if(message.includes('空间预算'))throw e;failures++;}
   await new Promise(r=>setTimeout(r,200));
  }
  await editLibrary((s,copies)=>{const t=s.tasks.find(t=>t.copyId===copyId),c=copies.find(c=>c.id===copyId);if(t&&c){t.completed=c.pages.filter(p=>p.blobKey).length;t.status=failures?'failed':'complete';t.error=failures?failures+' 页获取失败，已完成页面可以阅读。':undefined;t.updatedAt=Date.now();}});
 }
 private async patch(copyId:string,pageId:string,patch:Partial<Page>){await editLibrary((s,copies)=>{const c=copies.find(c=>c.id===copyId);const p=c?.pages.find(p=>p.id===pageId);if(p)Object.assign(p,patch);const t=s.tasks.find(t=>t.copyId===copyId);if(t&&c){t.completed=c.pages.filter(p=>p.blobKey).length;t.updatedAt=Date.now();}});}
}
