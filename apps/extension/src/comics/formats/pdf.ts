import {getDocument, GlobalWorkerOptions, PDFDataRangeTransport} from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import {MAX_PAGE, MAX_PAGES, MiB} from './limits';
import {throwIfAborted, type DocumentSession, type IndexedPage, type RandomAccessSource} from './contracts';
GlobalWorkerOptions.workerSrc = workerUrl;

function pdfDiagnostic(error: unknown): unknown {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  if (name === 'PasswordException') return new Error('PDF 已加密，当前只支持未加密文件。');
  if (name === 'InvalidPDFException') return new Error('PDF 文件结构损坏，无法建立目录。');
  return error;
}

export async function openPdfDocument(source: RandomAccessSource, signal?: AbortSignal): Promise<DocumentSession> {
  let activeSignal: AbortSignal | undefined, read = 0, budget = 16 * MiB, failure: unknown;
  const lifetime = new AbortController();
  throwIfAborted(signal);
  const initial = await source.readAt(0, Math.min(65536, source.snapshot.size), signal ? AbortSignal.any([signal,lifetime.signal]) : lifetime.signal);
  class SourceRange extends PDFDataRangeTransport {
    override requestDataRange(begin: number, end: number) {
      read += end - begin;
      if (read > budget) { failure = new Error('PDF 本次目录或页面准备超过读取预算，请拆分文件。'); void task.destroy(); return; }
      const signal = activeSignal ? AbortSignal.any([activeSignal, lifetime.signal]) : lifetime.signal;
      void source.readAt(begin, end - begin, signal).then(bytes => { if (!lifetime.signal.aborted) this.onDataRange(begin, bytes); })
        .catch(error => { failure = error; void task.destroy(); });
    }
    override abort() { lifetime.abort(); }
  }
  const range = new SourceRange(source.snapshot.size, initial, true);
  const assets = new URL('import-assets/pdf/', location.origin + '/').href;
  const task = getDocument({range, disableAutoFetch: true, disableStream: true, rangeChunkSize: 256 * 1024,
    useSystemFonts: false, stopAtErrors: true, maxImageSize: 40_000_000,
    cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/', wasmUrl: assets + 'wasm/'});
  const timer = setTimeout(() => { failure = new Error('PDF 打开超时。'); void task.destroy(); }, 60_000);
  const cancelOpening=()=>{failure=signal?.reason??new DOMException('PDF 打开已取消。','AbortError');lifetime.abort();void task.destroy();};
  signal?.addEventListener('abort',cancelOpening,{once:true});
  if(signal?.aborted)cancelOpening();
  try {
    const pdf = await task.promise;
    if (!pdf.numPages || pdf.numPages > MAX_PAGES) throw new Error('PDF 单卷最多支持 1500 页。');
    const pages: IndexedPage[] = Array.from({length: pdf.numPages}, (_, ordinal) => ({ordinal, name: `第 ${ordinal + 1} 页`, locator: {page: ordinal + 1}}));
    return {
      capabilities: {access: 'random', remote: false, encrypted: false, multiVolume: false, indexComplete: true},
      async index(signal) { throwIfAborted(signal); return pages; },
      async materialize(descriptor, signal) {
        throwIfAborted(signal);
        const number = descriptor.locator.page;
        if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > pdf.numPages) throw new Error('PDF 页码无效。');
        activeSignal = signal; read = 0; budget = 32 * MiB;
        const cancelDocument = () => { void task.destroy(); };
        signal?.addEventListener('abort', cancelDocument, {once: true});
        const timeout = setTimeout(cancelDocument, 60_000);
        let page;
        const canvas = document.createElement('canvas');
        try {
          page = await pdf.getPage(number);
          const base = page.getViewport({scale: 1});
          if (!Number.isFinite(base.width * base.height) || base.width <= 0 || base.height <= 0) throw new Error('PDF 页面尺寸无效。');
          const scale = Math.min(2, 8192 / Math.max(base.width, base.height), Math.sqrt(16_000_000 / (base.width * base.height)));
          const viewport = page.getViewport({scale});
          canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
          const render = page.render({canvas, viewport, background: '#ffffff'});
          const cancel = () => render.cancel();
          signal?.addEventListener('abort', cancel, {once: true});
          try { await render.promise; } finally { signal?.removeEventListener('abort', cancel); }
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PDF 页面转换失败。')), 'image/png'));
          if (blob.size > MAX_PAGE) throw new Error('PDF 页面超过 32 MB。');
          throwIfAborted(signal); return blob;
        } catch (error) { throw failure ?? pdfDiagnostic(error); }
        finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancelDocument); canvas.width = canvas.height = 1; page?.cleanup(); }
      },
      async close() { lifetime.abort(); await task.destroy(); },
    };
  } catch (error) { await task.destroy(); throw failure ?? pdfDiagnostic(error); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort',cancelOpening); }
}
