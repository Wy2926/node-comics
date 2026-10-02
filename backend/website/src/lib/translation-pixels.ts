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
export function pixels(
  source: Blob,
  limits: { max_bytes: number; max_pixels: number; max_dimension: number },
  result?: TranslationResult,
  artifact?: Blob,
  allowTiles = false,
): Promise<PixelResult> {
  const work = () =>
    new Promise<PixelResult>((resolve, reject) => {
      const worker = new PixelWorker();
      const timer = setTimeout(() => {
        worker.terminate();
        reject(Error('IMAGE_PROCESSING_FAILED'));
      }, 120000);
      const finish = () => {
        clearTimeout(timer);
        worker.terminate();
      };
      worker.onerror = () => {
        finish();
        reject(Error('IMAGE_PROCESSING_FAILED'));
      };
      worker.onmessage = (event) => {
        finish();
        if (event.data.error) reject(Error(event.data.error));
        else resolve(event.data);
      };
      worker.postMessage({ source, limits, result, artifact, allowTiles });
    });
  const next = tail.then(work);
  tail = next.catch(() => undefined);
  return next;
}
