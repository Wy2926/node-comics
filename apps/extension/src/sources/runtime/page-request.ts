import type { PageRequestInput } from './page-document';
export interface PageNetworkRequest extends PageRequestInput {
  url: string;
  referer?: string;
  body?: string;
}
export interface PageNetworkResponse {
  pageUrl: string;
  status: number;
  body: string;
  challenge: boolean;
  retryAfter: string | null;
  error?: 'changed' | 'network' | 'aborted' | 'size';
}
/** Serialized by scripting.executeScript. Keep this function self-contained: no imports or site code. */
export async function requestInSourcePage(input: PageNetworkRequest): Promise<PageNetworkResponse> {
  const result: PageNetworkResponse = { pageUrl: location.href, status: 0, body: '', challenge: false, retryAfter: null };
  if (location.href !== input.pageUrl || new URL(input.url).origin !== location.origin ||
    Reflect.get(document, Symbol.for('nc-source-page-document')) !== input.documentToken)
    return { ...result, error: 'changed' };
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, 30000);
  window.addEventListener(input.cancelEvent, abort, { once: true });
  window.addEventListener('pagehide', abort, { once: true });
  try {
    const response = await fetch(input.url, {
      credentials: 'include', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json, text/html', ...(input.body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }) },
      ...(input.body === undefined ? {} : { method: 'POST', body: input.body }),
      ...(input.referer ? { referrer: input.referer, referrerPolicy: 'unsafe-url' as ReferrerPolicy } : {})
    });
    result.status = response.status;
    result.challenge = response.headers.get('cf-mitigated') === 'challenge';
    result.retryAfter = response.headers.get('retry-after');
    // Challenge documents are not source data and must not be fed to a site's parser.
    if (result.challenge) {
      await response.body?.cancel();
      return result;
    }
    if (!response.body)
      return response.ok ? { ...result, error: 'network' } : result;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done)
          break;
        size += value.length;
        if (size > 8 * 1024 * 1024) {
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
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    result.body = new TextDecoder().decode(bytes);
    if (location.href !== input.pageUrl || Reflect.get(document, Symbol.for('nc-source-page-document')) !== input.documentToken)
      return { ...result, body: '', error: 'changed' };
    controller.signal.throwIfAborted();
    return result;
  }
  catch {
    return { ...result, body: '', error: controller.signal.aborted ? 'aborted' : 'network' };
  }
  finally {
    clearTimeout(timer);
    window.removeEventListener(input.cancelEvent, abort);
    window.removeEventListener('pagehide', abort);
  }
}
