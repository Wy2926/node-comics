import { catalog } from '../repositories';
import { listDownloads, pauseDownloads } from '../acquisition';
import { downloadStore } from '../../storage/downloads';
import { imageOrigins } from '../../sources';
export { grantDownloads, pauseDownloads } from '../acquisition';
export async function downloadItems(){
  return Promise.all((await listDownloads()).map(async task=>{
    const doc=await catalog.get('entries',task.entryId),pages=doc?await catalog.listPages(doc.contentId,{limit:1500}):[];
    const urls=pages.flatMap(p=>p.locator.kind!=='page'&&typeof p.locator.url==='string'?[p.locator.url]:[]);
    return {...task,title:doc?.title??'已移除的文档',origins:imageOrigins(urls)};
  }));
}
export async function deleteDownloads(entryId:string){
  await pauseDownloads([entryId]);await downloadStore.deleteOwner(entryId);
  await catalog.editTask('download:'+entryId,entryId,task=>task?{...task,status:'paused',completed:0,error:'下载资料已删除，可主动重新下载。',generation:Number(task.generation)+1,updatedAt:Date.now()}:undefined);
}
export function subscribeDownloads(fn:()=>void){return catalog.subscribe(change=>{if(change.table==='tasks')fn();});}
