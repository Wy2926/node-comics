import {BlobReader, TextReader, ZipWriter} from '@zip.js/zip.js/index-native.js';
import {msg} from '../i18n/runtime';
import {exportImage} from './images';
import {exportManifest, exportName, MAX_EXPORT_BYTES, type ExportPage, type ExportPlan} from './plan';
export interface ExportProgress {completed:number;total:number;file:string;phase:string}
export interface ExportImageLease {blob:Blob;width?:number;height?:number;release():void}
export interface ExportDependencies {
  acquire(page:ExportPage,signal:AbortSignal):Promise<ExportImageLease>;
  assertCurrent():Promise<void> | void;
  progress?(progress:ExportProgress):void;
}
export interface ExportResult {name:string;bytes:number;blob?:Blob}

/** ZIP writes directly to a file stream; the fallback retains at most 128 MiB of output. */
export async function writeExport(plan:ExportPlan,dependencies:ExportDependencies,signal:AbortSignal,destination?:WritableStream<Uint8Array>):Promise<ExportResult> {
  const check=async()=>{signal.throwIfAborted();await dependencies.assertCurrent();signal.throwIfAborted();};
  await check();
  const buffered=!destination, chunks:Uint8Array<ArrayBuffer>[]=[];
  const target=destination?.getWriter();let bytes=0,sourceBytes=0,closed=false;
  const abort=async(error:unknown)=>{chunks.length=0;if(!closed){closed=true;await target?.abort(error).catch(()=>{});target?.releaseLock();}};
  const output=new WritableStream<Uint8Array>({
    async write(chunk){signal.throwIfAborted();bytes+=chunk.byteLength;if(buffered&&bytes>MAX_EXPORT_BYTES)throw new Error('此浏览器的导出文件最多 128 MiB，请分批导出或使用支持直接写入文件的浏览器。');if(target)await target.write(chunk);else chunks.push(new Uint8Array(chunk));},
    async close(){if(closed)return;closed=true;try{await target?.close();}finally{target?.releaseLock();}},abort,
  });
  try{
    const pdf=plan.options.format==='pdf'?await(await import('./pdf')).pdfWriter(plan.title):undefined;
    const zip=pdf?undefined:new ZipWriter(output,{useWebWorkers:false,useCompressionStream:true,level:0});
    for(const [index,page] of plan.pages.entries()){
      await check();dependencies.progress?.({completed:index,total:plan.pages.length,file:plan.title,phase:msg('读取第 {0} 页',{'0':page.ordinal+1})});
      const lease=await dependencies.acquire(page,signal);
      try{
        await check();sourceBytes+=lease.blob.size;
        if((buffered||pdf)&&sourceBytes>MAX_EXPORT_BYTES)throw new Error('本次有界导出图片超过 128 MiB，请使用流式 CBZ / ZIP 或拆分文件。');
        if(pdf)await pdf.add(lease.blob,signal);
        else{
          const image=await exportImage(lease.blob,false,lease.width&&lease.height?{width:lease.width,height:lease.height}:undefined,signal);
          await check();await zip!.add(`${String(page.ordinal+1).padStart(5,'0')}.${image.extension}`,new BlobReader(image.blob),{signal});
        }
      }finally{lease.release();}
      await check();dependencies.progress?.({completed:index+1,total:plan.pages.length,file:plan.title,phase:msg('已处理第 {0} 页',{'0':page.ordinal+1})});
    }
    await check();const manifest=JSON.stringify(exportManifest(plan),null,2);
    if(pdf){const blob=await pdf.close(manifest);if(blob.size>MAX_EXPORT_BYTES)throw new Error('PDF 文件超过 128 MiB，请改用流式 CBZ / ZIP。');await check();const writer=output.getWriter();await writer.write(new Uint8Array(await blob.arrayBuffer()));await writer.close();writer.releaseLock();}
    else{await zip!.add('export-manifest.json',new TextReader(manifest),{signal});await check();await zip!.close();}
    return {name:exportName(plan.title,plan.options),bytes,...(buffered?{blob:new Blob(chunks,{type:pdf?'application/pdf':'application/zip'})}:{})};
  }catch(error){await abort(error);throw error;}
}
