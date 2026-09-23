import {openZipDocument} from './zip';
import {openMobiDocument} from './mobi';
import {openRarDocument} from './rar';
import type {ComicFormat, DocumentSession, IndexedPage, RandomAccessSource, SourceSnapshot} from './contracts';
let session: DocumentSession | undefined, sequence = 0;
const reads = new Map<number, {resolve(value: Uint8Array): void; reject(error: Error): void}>();
self.onmessage = async (event: MessageEvent<{id: number; command?: string; format?: ComicFormat; snapshot?: SourceSnapshot; page?: IndexedPage; bytes?: Uint8Array; error?: string}>) => {
  const message = event.data;
  if (message.command === 'bytes') {
    const pending = reads.get(message.id); reads.delete(message.id);
    if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.bytes!);
    return;
  }
  try {
    if (message.command === 'open') {
      const source: RandomAccessSource = {
        snapshot: message.snapshot!,
        readAt(offset, length) { return new Promise((resolve, reject) => { const id = ++sequence; reads.set(id, {resolve, reject}); self.postMessage({command: 'read', id, offset, length}); }); },
        async validate() { return 'unchanged'; }, async close() {},
      };
      session = message.format === 'cbz' ? openZipDocument(source) : message.format === 'mobi' ? openMobiDocument(source) : await openRarDocument(source);
      self.postMessage({id: message.id, value: session.capabilities});
    } else if (message.command === 'index') self.postMessage({id: message.id, value: await session!.index()});
    else if (message.command === 'page') self.postMessage({id: message.id, value: await session!.materialize(message.page!)});
  } catch (error) { self.postMessage({id: message.id, error: (error as Error).message || '漫画解析失败。'}); }
};
