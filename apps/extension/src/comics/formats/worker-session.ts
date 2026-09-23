import FormatWorker from './format.worker?worker';
import {throwIfAborted, type ComicFormat, type DocumentSession, type FormatCapabilities, type IndexedPage, type RandomAccessSource} from './contracts';

export async function openWorkerDocument(format: ComicFormat, source: RandomAccessSource, signal?: AbortSignal): Promise<DocumentSession> {
  const worker = new FormatWorker();
  const lifetime = new AbortController();
  let closed = false, sequence = 0, activeSignal: AbortSignal = lifetime.signal;
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Map<number, {resolve(value: unknown): void; reject(error: Error): void; cleanup(): void}>();
  const stop = (error: Error) => {
    if (closed) return; closed = true; lifetime.abort(error); worker.terminate();
    for (const request of pending.values()) { request.cleanup(); request.reject(error); } pending.clear();
  };
  worker.onerror = () => stop(new Error('漫画解析 Worker 无法运行，请重新打开。'));
  worker.onmessage = (event: MessageEvent<{id: number; command?: string; offset?: number; length?: number; value?: unknown; error?: string}>) => {
    const message = event.data;
    if (message.command === 'read') {
      void source.readAt(message.offset!, message.length!, activeSignal).then(bytes => {
        if (!closed) worker.postMessage({command: 'bytes', id: message.id, bytes}, [bytes.buffer as ArrayBuffer]);
      }).catch(error => { if (!closed) worker.postMessage({command: 'bytes', id: message.id, error: (error as Error).message}); });
      return;
    }
    const request = pending.get(message.id); pending.delete(message.id); request?.cleanup();
    if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.value);
  };
  const request = <T>(command: string, value: object = {}, signal?: AbortSignal): Promise<T> => {
    const run = async () => {
      throwIfAborted(signal);
      if (closed) throw new Error('漫画解析会话已关闭。');
      activeSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
      return new Promise<T>((resolve, reject) => {
        const id = ++sequence;
        const cancel = () => stop(new DOMException('页面准备已取消。', 'AbortError'));
        const timer = setTimeout(() => stop(new Error('漫画解析超过 60 秒，请拆分或转换后重试。')), 60_000);
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
        pending.set(id, {resolve: value => resolve(value as T), reject, cleanup});
        signal?.addEventListener('abort', cancel, {once: true});
        worker.postMessage({id, command, ...value});
      });
    };
    const result = queue.then(run); queue = result.catch(() => {}); return result;
  };
  try {
    const capabilities = await request<FormatCapabilities>('open', {format, snapshot: source.snapshot},signal);
    return {capabilities,
      async index(signal) { const pages = await request<IndexedPage[]>('index', {}, signal); capabilities.indexComplete = true; return pages; },
      materialize: (page, signal) => request<Blob>('page', {page}, signal),
      async close() { stop(new DOMException('解析会话已关闭。', 'AbortError')); },
    };
  } catch (error) { stop(error as Error); throw error; }
}
