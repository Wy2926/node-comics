import type {Api} from '../../api';
import {msg} from '../../i18n/runtime';
import {catalog} from '../repositories';
import {acquirePage} from '../pages/service';
import {openContainer} from '../../storage/containers';
import {translationCache} from '../../storage/translations';
import {loadResultBlob, resultBlobKey, resultInMemory} from '../../storage/translations/results';
import {planExport, MAX_EXPORT_BYTES, safeName, type ExportOptions} from '../../export/plan';
import {writeExport, type ExportProgress, type ExportResult} from '../../export/files';
export type {ExportOptions,ExportProgress,ExportResult};
export {exportName} from '../../export/plan';
export interface ExportContext {signal:AbortSignal;api?:Api;userId?:string;isCurrent?:()=>boolean;destination?:WritableStream<Uint8Array>;progress?:(value:ExportProgress)=>void}

export async function exportDocument(entryId:string,options:ExportOptions,context:ExportContext):Promise<ExportResult>{
  const {api,userId,signal}=context;
  const account=api&&userId?{origin:api.base,userId}:undefined;
  const plan=await planExport(entryId,options,account,signal);
  const assertCurrent=async()=>{
    if(options.images==='translation'&&(!api?.isCurrent()||context.isCurrent?.()===false))throw Error('账户或服务已切换，本次导出已停止。');
    const doc=await catalog.get('entries',entryId);
    if(!doc||doc.contentId!==plan.contentId||doc.generation!==plan.generation)throw Error('来源内容已变化，本次导出已停止。');
  };
  return writeExport(plan,{assertCurrent,progress:context.progress,async acquire(page,readSignal){
    await assertCurrent();
    if(page.kind!=='translation'){
      const lease=await acquirePage({...page.reference,signal:readSignal,purpose:'export',priority:'background'});
      return {blob:lease.blob,width:lease.identity.width,height:lease.identity.height,release:lease.release};
    }
    if(!page.job||!api||!userId)throw Error('已有译图身份缺失，请重新打开导出面板。');
    const key=page.cacheKey??resultBlobKey(api.base,userId,page.job);
    const cached=resultInMemory(key)??await translationCache.get(key);
    const blob=cached??await loadResultBlob({origin:api.base,userId,job:page.job,download:()=>api.image(page.job!.output_asset_id!,readSignal),isCurrent:()=>api.isCurrent()&&context.isCurrent?.()!==false});
    readSignal.throwIfAborted();await assertCurrent();return {blob,release(){}};
  }},signal,context.destination);
}

export async function originalFileInfo(entryId:string):Promise<{name:string;size?:number}|undefined>{
  const document=await catalog.get('entries',entryId);if(!document)return;
  if(!document.containerId)return;
  const binding=(await catalog.get('comics',document.comicId))?.source;
  const raw=typeof binding?.locator.name==='string'?binding.locator.name:`${document.title}.${document.format}`;
  return {name:safeName(raw)};
}

/** A byte-for-byte local source export. It never opens a format driver or creates a second container. */
export async function exportOriginalFile(entryId:string,context:Pick<ExportContext,'signal'|'destination'|'progress'>):Promise<ExportResult>{
  context.signal.throwIfAborted();
  const doc=await catalog.get('entries',entryId);if(!doc)throw Error('文档已移除。');
  if(!doc.containerId)throw Error('此内容没有本地源文件，请使用页面导出。');
  const name=(await originalFileInfo(entryId))?.name??safeName(doc.title);
  const source=await openContainer(doc.containerId);
  const target=context.destination?.getWriter(),chunks:Uint8Array<ArrayBuffer>[]=[];let closed=false;
  try{
    if(!target&&source.snapshot.size>MAX_EXPORT_BYTES)throw Error('此浏览器直接下载源文件最多支持 128 MiB，请使用支持直接写入文件的浏览器。');
    for(let offset=0;offset<source.snapshot.size;offset+=1024*1024){
      context.signal.throwIfAborted();
      const bytes=await source.readAt(offset,Math.min(1024*1024,source.snapshot.size-offset),context.signal);
      if(target)await target.write(bytes);else chunks.push(new Uint8Array(bytes));
      context.progress?.({completed:offset+bytes.length,total:source.snapshot.size,file:name,phase:msg('保存完整源文件')});
    }
    context.signal.throwIfAborted();await target?.close();closed=true;
    return {name,bytes:source.snapshot.size,...(!target?{blob:new Blob(chunks,{type:'application/octet-stream'})}:{})};
  }catch(error){if(!closed)await target?.abort(error).catch(()=>{});throw error;}
  finally{target?.releaseLock();await source.close();}
}

interface SavePickerWindow {showSaveFilePicker?(options:{suggestedName:string}):Promise<{createWritable():Promise<WritableStream<Uint8Array>>}>}
/** Call directly from the click handler to preserve the browser's user gesture. */
export async function chooseExportDestination(name:string):Promise<WritableStream<Uint8Array>|undefined>{
  const picker=(window as unknown as SavePickerWindow).showSaveFilePicker;
  if(!picker)return undefined;
  const handle=await picker.call(window,{suggestedName:name});return handle.createWritable();
}
export function saveBufferedExport(result:ExportResult){
  if(!result.blob)return;
  const url=URL.createObjectURL(result.blob),link=document.createElement('a');link.href=url;link.download=result.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);
}
