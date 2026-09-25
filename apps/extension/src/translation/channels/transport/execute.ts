import {readTransferReceipt, saveTransferReceipt} from './receipts';
import {ImageTransferError, withTransferLock, type ImageTransferRequest} from './types';

export function validateTransferRequest(value: unknown): value is ImageTransferRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as ImageTransferRequest;
  try {
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return false;
  } catch { return false; }
  const strings = (items: unknown, limit: number) => !!items && typeof items === 'object' && !Array.isArray(items)
    && Object.entries(items).length <= 20 && Object.entries(items).every(([k, v]) => k.length <= 100 && typeof v === 'string' && v.length <= limit);
  return typeof request.imageField === 'string' && /^[a-zA-Z_][a-zA-Z_0-9]{0,60}$/.test(request.imageField)
    && strings(request.headers, 8192) && strings(request.fields, 65536)
    && [request.maxBytes, request.maxPixels, request.maxDimension].every(value => Number.isSafeInteger(value) && value > 0)
    && request.maxBytes <= 64 * 1024 * 1024 && request.maxPixels <= 40_000_000 && request.maxDimension <= 30000;
}

async function imageBody(response: Response, request: ImageTransferRequest): Promise<Blob> {
  if (!response.ok) throw new ImageTransferError('HTTP_' + response.status);
  if (response.redirected || response.type === 'opaqueredirect') throw new ImageTransferError('REDIRECT');
  const type = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if (!type || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type))
    throw new ImageTransferError('INVALID_IMAGE');
  if (Number(response.headers.get('content-length')) > request.maxBytes) throw new ImageTransferError('IMAGE_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) throw new ImageTransferError('INVALID_IMAGE');
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.length;
      if (total > request.maxBytes) throw new ImageTransferError('IMAGE_TOO_LARGE');
      chunks.push(value.slice().buffer);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally {reader.releaseLock();}
  const blob = new Blob(chunks, {type});
  let image: ImageBitmap;
  try {image = await createImageBitmap(blob);} catch {throw new ImageTransferError('INVALID_IMAGE');}
  try {
    if (image.width < 1 || image.height < 1 || image.width * image.height > request.maxPixels
      || Math.max(image.width, image.height) > request.maxDimension) throw new ImageTransferError('IMAGE_TOO_LARGE');
  } finally {image.close();}
  return blob;
}

/** The receipt is committed before fetch; another context must observe it, never resend. */
export async function executeImageTransfer(id: string, request: ImageTransferRequest, onAccepted?: () => void): Promise<void> {
  if (!validateTransferRequest(request)) throw new ImageTransferError('INVALID_REQUEST');
  await withTransferLock(id, async () => {
    const receipt = await readTransferReceipt(id);
    if (!receipt || receipt.state !== 'prepared') return;
    // A cross-context lock request is not ownership until its callback actually runs.
    // Acknowledge before waiting for the scope slot so the caller only waits for this handoff.
    try {onAccepted?.();} catch {} // Notification failure does not revoke accepted work.
    const run = async () => {
      const current = await readTransferReceipt(id);
      if (!current || current.state !== 'prepared') return;
      if (!current.input) {
        await saveTransferReceipt({...current, state: 'failed', errorCode: 'SOURCE_MISSING', updatedAt: Date.now()}); return;
      }
      await saveTransferReceipt({...current, state: 'running', updatedAt: Date.now()});
      try {
        const form = new FormData();
        form.append(request.imageField, current.input, 'page');
        for (const [key, value] of Object.entries(request.fields)) form.append(key, value);
        const response = await fetch(request.url, {
          method: 'POST', headers: request.headers, body: form, credentials: 'omit', redirect: 'error', cache: 'no-store',
          referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30 * 60 * 1000),
        });
        const output = await imageBody(response, request);
        await saveTransferReceipt({...current, input: undefined, output, state: 'succeeded', updatedAt: Date.now()});
      } catch (error) {
        // Never retain remote response text, a URL, or fetch's potentially sensitive message.
        const errorCode = error instanceof ImageTransferError ? error.code : 'INTERRUPTED';
        await saveTransferReceipt({...current, input: undefined, output: undefined, state: 'failed', errorCode, updatedAt: Date.now()});
      }
    };
    // One image at a time for a channel, including other reader tabs and original-page translation.
    if (typeof navigator !== 'undefined' && navigator.locks)
      await navigator.locks.request('nc-channel-execution:' + receipt.scope, run);
    else await run();
  });
}
