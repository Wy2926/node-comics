import type {Job} from '../../types';
import type {TranslationScope} from '../../translation/channels/contracts';
import {msg} from '../../i18n/runtime';
import {catalog} from '../repositories';
import {acquirePage} from '../pages/service';
import {openContainer} from '../../storage/containers';
import {planExport, MAX_EXPORT_BYTES, safeName, type ExportOptions} from '../../export/plan';
import {writeExport, type ExportProgress, type ExportResult} from '../../export/files';
import {entrySource} from './entry-source';
export type {ExportOptions,ExportProgress,ExportResult};
export {exportName} from '../../export/plan';
export interface ExportContext {signal:AbortSignal;scope?:TranslationScope;readResult?:(job:Job,signal?:AbortSignal,original?:()=>Promise<Blob|undefined>)=>Promise<Blob>;isCurrent?:()=>boolean;destination?:WritableStream<Uint8Array>;progress?:(value:ExportProgress)=>void}

export async function exportDocument(entryId:string,options:ExportOptions,context:ExportContext):Promise<ExportResult>{
  const {scope,signal}=context;
  const plan=await planExport(entryId,options,scope,signal);
  const assertCurrent=async()=>{
    if(options.images==='translation'&&context.isCurrent?.()===false)throw Error(msg('翻译渠道已切换，本次导出已停止。'));
    const doc=await catalog.get('entries',entryId);
    if(!doc||doc.contentId!==plan.contentId||doc.generation!==plan.generation)throw Error('来源内容已变化，本次导出已停止。');
  };
  return writeExport(plan,{assertCurrent,progress:context.progress,async acquire(page,readSignal){
    await assertCurrent();
    if(page.kind!=='translation'){
      const lease=await acquirePage({...page.reference,signal:readSignal,purpose:'export',priority:'background'});
      return {blob:lease.blob,width:lease.identity.width,height:lease.identity.height,release:lease.release};
    }
    if(!page.job||!scope||!context.readResult)throw Error('已有译图身份缺失，请重新打开导出面板。');
    const blob=await context.readResult(page.job,readSignal,async()=>{
      const lease=await acquirePage({...page.reference,signal:readSignal,purpose:'export',priority:'background'});
      try{return lease.blob;}finally{lease.release();}
    });
    readSignal.throwIfAborted();await assertCurrent();return {blob,release(){}};
  }},signal,context.destination);
}

function originalFileName({entry, comic}: Awaited<ReturnType<typeof entrySource>>) {
  const raw = typeof comic.source.locator.name === 'string'
    ? comic.source.locator.name
    : `${entry.title}.${entry.format}`;
  return safeName(raw);
}

export async function originalFileInfo(
  entryId: string,
): Promise<{name: string; size?: number} | undefined> {
  const binding = await entrySource(entryId);
  await binding.assertCurrent();
  if (!binding.entry.containerId) return;
  return {name: originalFileName(binding)};
}

/** A byte-for-byte local source export. It never opens a format driver or creates a second container. */
export async function exportOriginalFile(
  entryId: string,
  context: Pick<ExportContext, 'signal' | 'destination' | 'progress'>,
): Promise<ExportResult> {
  const binding = await entrySource(entryId, undefined, context.signal);
  if (!binding.entry.containerId) {
    throw Error('此内容没有本地源文件，请使用页面导出。');
  }
  const name = originalFileName(binding);
  const source = await openContainer(binding.entry.containerId);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let target: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let closed = false;
  try {
    target = context.destination?.getWriter();
    await binding.assertCurrent();
    if (!target && source.snapshot.size > MAX_EXPORT_BYTES) {
      throw Error('此浏览器直接下载源文件最多支持 128 MiB，请使用支持直接写入文件的浏览器。');
    }
    for (let offset = 0; offset < source.snapshot.size; offset += 1024 * 1024) {
      context.signal.throwIfAborted();
      const bytes = await source.readAt(
        offset,
        Math.min(1024 * 1024, source.snapshot.size - offset),
        context.signal,
      );
      await binding.assertCurrent();
      if (target) await target.write(bytes);
      else chunks.push(new Uint8Array(bytes));
      context.progress?.({
        completed: offset + bytes.length,
        total: source.snapshot.size,
        file: name,
        phase: msg('保存完整源文件'),
      });
    }
    await binding.assertCurrent();
    await target?.close();
    closed = true;
    return {
      name,
      bytes: source.snapshot.size,
      ...(!target ? {blob: new Blob(chunks, {type: 'application/octet-stream'})} : {}),
    };
  } catch (error) {
    if (!closed) await target?.abort(error).catch(() => {});
    throw error;
  } finally {
    target?.releaseLock();
    await source.close();
  }
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
