import {throwIfAborted, type ComicFormat, type DocumentSession, type RandomAccessSource, type FileIndex} from './contracts';
export {detectFormat} from './identify';
export type {ComicFormat, DocumentSession, IndexedPage, RandomAccessSource} from './contracts';

/** File indexing is shared; EPUB documents never enter image materialization. */
export async function indexFile(format: ComicFormat | string, source: RandomAccessSource, signal?: AbortSignal): Promise<FileIndex> {
  throwIfAborted(signal);
  if (format === 'epub') return (await import('./epub')).indexEpub(source, signal);
  const session = await openDocument(format, source, signal);
  try { return {kind: 'images', pages: await session.index(signal)}; }
  finally { await session.close(); }
}

export async function openDocument(format: ComicFormat | string, source: RandomAccessSource, signal?: AbortSignal): Promise<DocumentSession> {
  throwIfAborted(signal);
  if(!source.snapshot.local&&!['cbz','mobi'].includes(format))throw new Error('此格式尚未通过云端范围读取验证，请下载后从本地导入。');
  if (format === 'pdf') return (await import('./pdf')).openPdfDocument(source,signal);
  if (!['cbz', 'cbr', 'mobi'].includes(format)) throw new Error('不支持此漫画格式。');
  // Production parsing runs off the UI thread. Direct drivers remain testable without Worker globals.
  if (typeof Worker !== 'undefined') return (await import('./worker-session')).openWorkerDocument(format as ComicFormat, source,signal);
  if (format === 'cbz') return (await import('./zip')).openZipDocument(source);
  if (format === 'mobi') return (await import('./mobi')).openMobiDocument(source);
  throw new Error('本地 CBR 阅读需要支持 Worker 的浏览器。');
}
