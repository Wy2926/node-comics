import PixelWorker from './translation-pixels.worker?worker';
import type { TranslationResult } from '../../../shared/translation-images/types';
let tail: Promise<unknown> = Promise.resolve();
export interface PixelResult {
  input: Blob;
  width: number;
  height: number;
  sha256: string;
  mime: string;
  result?: Blob;
}
function pixelOperation<T>(message: unknown, signal?: AbortSignal): Promise<T> {
  const work = () => new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const worker = new PixelWorker();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { finish(); reject(signal?.reason); };
    const timer = setTimeout(() => { finish(); reject(Error('IMAGE_PROCESSING_FAILED')); }, 120000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => { finish(); reject(Error('IMAGE_PROCESSING_FAILED')); };
    worker.onmessage = event => {
      finish();
      if (event.data.error) reject(Error(event.data.error));
      else resolve(event.data);
    };
    worker.postMessage(message);
  });
  const next = tail.then(work);
  tail = next.catch(() => undefined);
  return next;
}
export function pixels(source: Blob, limits: { max_bytes: number; max_pixels: number; max_dimension: number }, result?: TranslationResult, artifact?: Blob, allowTiles = false): Promise<PixelResult> {
  return pixelOperation({ source, limits, result, artifact, allowTiles });
}
export function imageThumbnail(source: Blob, signal: AbortSignal): Promise<{ thumbnail: Blob }> {
  return pixelOperation({ source, thumbnail: true }, signal);
}
