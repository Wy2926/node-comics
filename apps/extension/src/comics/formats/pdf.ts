import {getDocument, PDFWorker, PDFDataRangeTransport} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {abortable} from '../../concurrency';
import {throwIfAborted, type DocumentSession, type IndexedPage, type RandomAccessSource} from './contracts';

function pdfDiagnostic(error: unknown): unknown {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  if (name === 'PasswordException') return new Error('PDF 已加密，当前只支持未加密文件。');
  if (name === 'InvalidPDFException') return new Error('PDF 文件结构损坏，无法建立目录。');
  return error;
}

export async function openPdfDocument(source: RandomAccessSource, signal?: AbortSignal): Promise<DocumentSession> {
  throwIfAborted(signal);
  const initial = await abortable(source.readAt(0, Math.min(65536, source.snapshot.size), signal), signal);
  throwIfAborted(signal);
  const lifetime = new AbortController();
  let worker: PDFWorker | undefined, task: ReturnType<typeof getDocument> | undefined;
  let disposing: Promise<void> | undefined, readers = 0;
  // Safari's serialized location origin can change the case of its extension ID.
  // Keep runtime resource URLs intact and avoid PDF.js's HTTP-only origin wrapper.
  const assets = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('import-assets/pdf/') : new URL('import-assets/pdf/', location.origin + '/').href;
  const port = new Worker(assets + 'pdf.worker.mjs', {type: 'module'});
  // PDF.js may leave both its work and destroy promises pending after cancellation.
  // Normal close awaits cleanup; cancellation never waits for a dead worker's acknowledgement.
  const dispose = () => disposing ??= Promise.resolve().then(async () => {
    try { if (task) await abortable(task.destroy(), lifetime.signal); }
    catch (error) { if (!lifetime.signal.aborted) throw error; }
    finally {
      lifetime.abort();
      signal?.removeEventListener('abort', cancel);
      port.removeEventListener('error', workerFailed);
      port.removeEventListener('messageerror', workerFailed);
      try { worker?.destroy(); } finally { port.terminate(); }
    }
  });
  const stop = (reason?: unknown) => { lifetime.abort(reason); void dispose().catch(() => {}); };
  const cancel = () => stop(signal?.reason);
  const workerFailed = (event: Event) => { event.preventDefault(); stop(new Error('PDF 读取失败，请重试。')); };
  const assertOpen = (signal?: AbortSignal) => {
    throwIfAborted(signal); lifetime.signal.throwIfAborted();
    if (disposing) throw new DOMException('PDF session closed.', 'AbortError');
  };
  signal?.addEventListener('abort', cancel, {once: true});
  port.addEventListener('error', workerFailed);
  port.addEventListener('messageerror', workerFailed);
  if (signal?.aborted) cancel();
  class SourceRange extends PDFDataRangeTransport {
    override requestDataRange(begin: number, end: number) {
      void source.readAt(begin, end - begin, lifetime.signal)
        .then(bytes => { if (!lifetime.signal.aborted) this.onDataRange(begin, bytes); }).catch(stop);
    }
    override abort() { lifetime.abort(); }
  }
  try {
    assertOpen();
    worker = PDFWorker.create({port});
    task = getDocument({worker, range: new SourceRange(source.snapshot.size, initial, true), disableAutoFetch: true, disableStream: true, rangeChunkSize: 256 * 1024,
      useSystemFonts: false, stopAtErrors: true, maxImageSize: -1,
      cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/', wasmUrl: assets + 'wasm/'});
    const pdf = await abortable(task.promise, lifetime.signal);
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new Error('PDF 未包含可读页面。');
    async function readPage<T>(descriptor: IndexedPage, signal: AbortSignal | undefined, action: (number: number) => Promise<T>): Promise<T> {
      assertOpen(signal);
      const number = descriptor.locator.page;
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > pdf.numPages) throw new Error('PDF 页码无效。');
      const cancelRead = () => stop(signal?.reason);
      signal?.addEventListener('abort', cancelRead, {once: true});
      readers++;
      try {
        // The operation cancels its own waits and finishes cleanup before releasing this reader.
        const result = await action(number);
        lifetime.signal.throwIfAborted();
        return result;
      } catch (error) { throw lifetime.signal.aborted ? lifetime.signal.reason : pdfDiagnostic(error); }
      finally { readers--; signal?.removeEventListener('abort', cancelRead); }
    }
    const renderPage = (descriptor: IndexedPage, signal?: AbortSignal, displayWidth?: number) => readPage(descriptor, signal, async number => {
      let page;
      const canvas = document.createElement('canvas');
      try {
        page = await abortable(pdf.getPage(number), lifetime.signal);
        lifetime.signal.throwIfAborted();
        const base = page.getViewport({scale: 1});
        if (!Number.isFinite(base.width * base.height) || base.width <= 0 || base.height <= 0) throw new Error('PDF 页面尺寸无效。');
        if (displayWidth !== undefined && (!Number.isFinite(displayWidth) || displayWidth <= 0)) throw new Error('PDF 显示尺寸无效。');
        // Reading follows the requested display size; only translation preparation compresses images.
        const scale = displayWidth === undefined ? 2 : displayWidth / base.width;
        const viewport = page.getViewport({scale});
        canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
        const render = page.render({canvas, viewport, background: '#ffffff'});
        const cancel = () => render.cancel();
        lifetime.signal.addEventListener('abort', cancel, {once: true});
        if (lifetime.signal.aborted) cancel();
        try { await abortable(render.promise, lifetime.signal); } finally { lifetime.signal.removeEventListener('abort', cancel); }
        lifetime.signal.throwIfAborted();
        const blob = await abortable(new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PDF 页面转换失败。')), 'image/png')), lifetime.signal);
        return {blob, width: Math.max(1, Math.floor(base.width * 2)), height: Math.max(1, Math.floor(base.height * 2))};
      } finally { canvas.width = canvas.height = 1; page?.cleanup(); }
    });
    return {
      capabilities: {access: 'random', remote: false, encrypted: false, multiVolume: false, indexComplete: true},
      async index(signal) {
        assertOpen(signal);
        return Array.from({length: pdf.numPages}, (_, ordinal) => ({ordinal, name: `第 ${ordinal + 1} 页`, locator: {page: ordinal + 1}}));
      },
      async materialize(descriptor, signal) { return (await renderPage(descriptor, signal)).blob; },
      renderForDisplay(descriptor, width, signal) { return renderPage(descriptor, signal, width); },
      originalImage: (descriptor, signal) => readPage(descriptor, signal, async number => {
        // This command is installed by our version-checked PDF.js worker extension.
        const transport = (pdf as unknown as {_transport: {messageHandler: {sendWithPromise(name: string, data: {pageIndex: number}): Promise<Uint8Array<ArrayBuffer> | null>}}})._transport;
        const bytes = await abortable(transport.messageHandler.sendWithPromise('NodeComicsOriginalImage', {pageIndex: number - 1}), lifetime.signal);
        return bytes ? new Blob([bytes], {type: 'image/jpeg'}) : undefined;
      }),
      close() { if (readers) stop(); return dispose(); },
    };
  } catch (error) {
    const reason = lifetime.signal.aborted ? lifetime.signal.reason : pdfDiagnostic(error);
    stop(reason); await dispose(); throw reason;
  }
}
