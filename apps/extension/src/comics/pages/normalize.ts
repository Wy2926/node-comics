import {msg} from '../../i18n/runtime';
import {Sha256} from '../../importers/hash';
import {MAX_PAGE} from '../formats/limits';
import {imageMimeFromBytes} from '../formats/identify';
export interface PageInput {name: string; pageIndex?: number; blob: Blob; width?: number; height?: number}

async function digestPage(blob: Blob, signal?: AbortSignal): Promise<string> {
  if (blob.size >= 1024 * 1024 && typeof Worker !== 'undefined') {
    const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), {type: 'module'});
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker.terminate(); };
      const cancel = () => { finish(); reject(signal?.reason ?? new DOMException('页面摘要已取消。', 'AbortError')); };
      const timer = setTimeout(() => { finish(); reject(new Error('页面摘要计算超时。')); }, 30_000);
      signal?.addEventListener('abort', cancel, {once: true});
      worker.onerror = () => { finish(); reject(new Error('页面摘要 Worker 无法运行。')); };
      worker.onmessage = (event: MessageEvent<{sha256?: string; error?: string}>) => {
        finish(); if (event.data.sha256) resolve(event.data.sha256); else reject(new Error(event.data.error ?? '页面摘要失败。'));
      };
      if (signal?.aborted) cancel(); else worker.postMessage(blob);
    });
  }
  const hash = new Sha256();
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    signal?.throwIfAborted(); hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted(); return hash.digest();
}

/** Only materialized pages are normalized; indexing never calls a bitmap decoder. */
export async function prepareComicPage(item: PageInput, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (item.blob.size > MAX_PAGE) throw Error(msg('{0} 超过单页 32 MB 限制。', {'0': item.name}));
  if (item.width && item.height) checkDimensions(item.width, item.height);
  const mime=imageMimeFromBytes(new Uint8Array(await item.blob.slice(0,12).arrayBuffer()));
  if(!mime)throw Error(msg('{0} 无法解码，请检查图片是否损坏。', {'0': item.name}));
  const input=item.blob.type===mime?item.blob:item.blob.slice(0,item.blob.size,mime);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(input); }
  catch { throw Error(msg('{0} 无法解码，请检查图片是否损坏。', {'0': item.name})); }
  try {
    signal?.throwIfAborted();
    const {width, height} = bitmap; checkDimensions(width, height);
    let blob = input;
    if (blob.type === 'image/gif') {
      const canvas = new OffscreenCanvas(width, height);
      try { canvas.getContext('2d')!.drawImage(bitmap, 0, 0); blob = await canvas.convertToBlob({type: 'image/png'}); }
      finally { canvas.width = canvas.height = 1; }
    }
    if (blob.size > MAX_PAGE) throw Error(msg('{0} 转换后超过单页 32 MB 限制。', {'0': item.name}));
    const imageSha256 = await digestPage(blob, signal);
    signal?.throwIfAborted(); return {blob, width, height, imageSha256};
  } finally { bitmap.close(); }
}
function checkDimensions(width: number, height: number) {
  if (!Number.isFinite(width * height) || width < 1 || height < 1 || width * height > 40_000_000 || Math.max(width, height) > 30000)
    throw Error(msg('漫画页尺寸超过阅读器限制（4000 万像素、单边 30000）。'));
}
