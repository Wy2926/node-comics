import type { PageRequestInput } from './page-document';
export interface PageCoverResponse {
  pageUrl: string;
  responseUrl: string;
  status: number;
  type: string;
  data: string;
  challenge: boolean;
  retryAfter: string | null;
  error?: 'changed' | 'network' | 'aborted' | 'size' | 'type';
}
/** Serialized by scripting.executeScript; reads only the exact image document, never another URL. */
export async function readCoverInPage(input: PageRequestInput): Promise<PageCoverResponse> {
  const result: PageCoverResponse = { pageUrl: location.href, responseUrl: location.href, status: 0, type: '', data: '', challenge: false, retryAfter: null };
  if (location.href !== input.pageUrl || !/^https?:/.test(input.pageUrl) ||
    Reflect.get(document, Symbol.for('nc-source-page-document')) !== input.documentToken)
    return { ...result, error: 'changed' };
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, 30000);
  window.addEventListener(input.cancelEvent, abort, { once: true });
  window.addEventListener('pagehide', abort, { once: true });
  try {
    // Navigation already requested this image. Reuse a successful response instead of downloading it twice.
    const response = await fetch(input.pageUrl, {
      credentials: 'include', cache: 'force-cache', redirect: 'follow',
      referrerPolicy: 'no-referrer', signal: controller.signal
    });
    result.status = response.status;
    result.responseUrl = response.url || input.pageUrl;
    result.challenge = response.headers.get('cf-mitigated') === 'challenge';
    result.retryAfter = response.headers.get('retry-after');
    result.type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!response.ok || result.challenge) {
      await response.body?.cancel();
      return result;
    }
    if (!/^image\/(?:avif|bmp|gif|jpeg|jpg|png|webp)$/.test(result.type)) {
      await response.body?.cancel();
      return { ...result, error: 'type' };
    }
    if (!response.body)
      return { ...result, error: 'network' };
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done)
          break;
        size += value.length;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          return { ...result, error: 'size' };
        }
        chunks.push(value);
      }
    }
    catch (error) {
      await reader.cancel().catch(() => { });
      throw error;
    }
    finally {
      reader.releaseLock();
    }
    if (!size)
      return { ...result, error: 'network' };
    const parts: string[] = [];
    for (const chunk of chunks)
      for (let offset = 0; offset < chunk.length; offset += 32768)
        parts.push(String.fromCharCode(...chunk.subarray(offset, offset + 32768)));
    result.data = btoa(parts.join(''));
    if (location.href !== input.pageUrl || Reflect.get(document, Symbol.for('nc-source-page-document')) !== input.documentToken)
      return { ...result, data: '', error: 'changed' };
    controller.signal.throwIfAborted();
    return result;
  }
  catch {
    return { ...result, data: '', error: controller.signal.aborted ? 'aborted' : 'network' };
  }
  finally {
    clearTimeout(timer);
    window.removeEventListener(input.cancelEvent, abort);
    window.removeEventListener('pagehide', abort);
  }
}
