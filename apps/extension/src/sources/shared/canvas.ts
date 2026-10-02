import { msg } from '../../i18n/runtime';
export async function canvasImage(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  if (!Number.isSafeInteger(canvas.width) || !Number.isSafeInteger(canvas.height) || canvas.width < 1 || canvas.height < 1)
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
    if (!blob) throw Error();
    return blob;
  } catch {
    throw Error(msg('网页原图读取失败。'));
  } finally {
    combined.removeEventListener('abort', aborted);
  }
}
