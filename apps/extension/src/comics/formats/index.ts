import {throwIfAborted, type ComicFormat, type DocumentSession, type RandomAccessSource} from './contracts';
import {imageMimeFromBytes} from './identify';
export {detectFormat} from './identify';
export type {ComicFormat, DocumentSession, IndexedPage, RandomAccessSource} from './contracts';

export async function openDocument(format: ComicFormat | string, source: RandomAccessSource, signal?: AbortSignal): Promise<DocumentSession> {
  throwIfAborted(signal);
  if(!source.snapshot.local&&!['cbz','image'].includes(format))throw new Error('此格式尚未通过云端范围读取验证，请下载后从本地导入。');
  if (format === 'image') {
    if (source.snapshot.size > 32 * 1024 * 1024) throw new Error('单张图片最多支持 32 MB。');
    return {
      capabilities: {access: 'random', remote: true, encrypted: false, multiVolume: false, indexComplete: true},
      async index(signal) { throwIfAborted(signal); return [{ordinal: 0, name: '图片', locator: {image: 0}}]; },
      async materialize(page, signal) {
        if (page.ordinal !== 0 || page.locator.image !== 0) throw new Error('图片页码无效。');
        const bytes = await source.readAt(0, source.snapshot.size, signal);
        const type = imageMimeFromBytes(bytes);
        if (!type) throw new Error('图片格式无效。');
        return new Blob([new Uint8Array(bytes)], {type});
      }, async close() {},
    };
  }
  if (format === 'pdf') return (await import('./pdf')).openPdfDocument(source,signal);
  if (!['cbz', 'cbr', 'mobi'].includes(format)) throw new Error('不支持此漫画格式。');
  // Production parsing runs off the UI thread. Direct drivers remain testable without Worker globals.
  if (typeof Worker !== 'undefined') return (await import('./worker-session')).openWorkerDocument(format as ComicFormat, source,signal);
  if (format === 'cbz') return (await import('./zip')).openZipDocument(source);
  if (format === 'mobi') return (await import('./mobi')).openMobiDocument(source);
  throw new Error('本地 CBR 阅读需要支持 Worker 的浏览器。');
}
