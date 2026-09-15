import {getDocument,GlobalWorkerOptions,PDFDataRangeTransport,version} from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import {hashFile} from './hash';
import {MAX_PAGES,MAX_PAGE,MAX_EXPANDED,type ComicPage} from './comic-shared';
GlobalWorkerOptions.workerSrc=workerUrl;
export const pdfFileHash=(originalHash:string)=>hashFile(new Blob([`pdf-png-v1:144dpi:16mp:8192:${version}:${originalHash}`]));
export async function openPdf(file:File,originalHash:string) {
  const initial=new Uint8Array(await file.slice(0,65536).arrayBuffer());
  class LocalRange extends PDFDataRangeTransport {
    stopped=false;
    override requestDataRange(begin:number,end:number) {
      void file.slice(begin,end).arrayBuffer().then(bytes=>{if(!this.stopped)this.onDataRange(begin,new Uint8Array(bytes));}).catch(()=>{void task.destroy();});
    }
    override abort(){this.stopped=true;}
  }
  const range=new LocalRange(file.size,initial,true);
  const assets=new URL('import-assets/pdf/',location.origin+'/').href;
  const task=getDocument({range,disableAutoFetch:true,disableStream:true,rangeChunkSize:1024*1024,
    useSystemFonts:false,stopAtErrors:true,
    cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/'});
  try {
    const pdf=await task.promise;
    if(!pdf.numPages||pdf.numPages>MAX_PAGES)throw Error('PDF 单卷最多支持 1500 页。');
    // Rendering changes may change upload bytes. Keep old PDF identities apart.
    const fileHash=await pdfFileHash(originalHash);
    return {fileHash,total:pdf.numPages,close:()=>task.destroy(),warnings:['PDF 按页转换为 PNG；原 PDF 保留在本机，未上传。'],pages:(async function*():AsyncGenerator<ComicPage> {
      let expanded=0;
      for(let pageIndex=0;pageIndex<pdf.numPages;pageIndex++) {
        const page=await pdf.getPage(pageIndex+1);
        const base=page.getViewport({scale:1});
        if(!Number.isFinite(base.width*base.height)||base.width<=0||base.height<=0)throw Error(`PDF 第 ${pageIndex+1} 页尺寸无效。`);
        const scale=Math.min(2,8192/Math.max(base.width,base.height),Math.sqrt(16_000_000/(base.width*base.height)));
        const viewport=page.getViewport({scale});
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.floor(viewport.width));canvas.height=Math.max(1,Math.floor(viewport.height));
        const render=page.render({canvas,viewport,background:'#ffffff'});
        const timer=setTimeout(()=>render.cancel(),60000);
        try {
          await render.promise;
          const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('PDF 页面转换失败。')),'image/png'));
          expanded+=blob.size;
          if(blob.size>MAX_PAGE||expanded>MAX_EXPANDED)throw Error('PDF 转换后超过单页 32 MB 或整卷 1024 MB 限制，请拆分文件。');
          yield {name:`第 ${String(pageIndex+1).padStart(3,'0')} 页`,pageIndex,blob,width:canvas.width,height:canvas.height};
        } finally {clearTimeout(timer);canvas.width=canvas.height=1;page.cleanup();}
      }
    })()};
  } catch(error) {
    await task.destroy();
    if((error as Error).name==='PasswordException')throw Error('PDF 需要密码，请先在本机解密后导入。');
    throw error;
  }
}
