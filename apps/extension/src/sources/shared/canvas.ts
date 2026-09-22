import { msg } from '../../i18n/runtime';
import { maxInlineBytes } from './bytes';
export async function canvasImage(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  if (!canvas.width || !canvas.height || canvas.width * canvas.height > 60_000_000)
    throw Error(msg('原图尺寸不可用。'));
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(30000),
    combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let aborted: () => void = () => {};
  try {
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      aborted = () => reject(Error('SOURCE_RESOURCE_EXPIRED'));
      combined.addEventListener('abort', aborted, { once: true });
      canvas.toBlob(resolve, 'image/png');
    });
    combined.throwIfAborted();
    if (!blob || blob.size > maxInlineBytes) throw Error();
    return blob;
  } catch {
    throw Error(msg('网页原图读取失败。'));
  } finally {
    combined.removeEventListener('abort', aborted);
  }
}
