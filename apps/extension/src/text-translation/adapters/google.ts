import {TextTranslationError, type TextTranslationAdapter} from '../contracts';

const endpoint = 'https://translate.googleapis.com/translate_a/single';
/** Splits only large texts. Keep Unicode characters and paragraph separators intact. */
export function splitText(text: string): string[] {
  const parts: string[] = [];
  while (text.length > 4000) {
    let end = text.lastIndexOf('\n', 4000);
    if (end < 2000) end = text.lastIndexOf(' ', 4000);
    if (end < 2000) end = 4000;
    else end++;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}
async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new TextTranslationError('invalid');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 512 * 1024) throw new TextTranslationError('invalid');
      text += decoder.decode(chunk.value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}
export function createGoogleTranslator(fetcher: typeof fetch = fetch, now = Date.now): TextTranslationAdapter {
  let retryAt = 0;
  return {id: 'google', name: 'Google Translate', async translate(text, targetLanguage, signal) {
    signal.throwIfAborted();
    if (!text.trim() || text.length > 16_000 || !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(targetLanguage)) throw new TextTranslationError('invalid');
    const url = new URL(endpoint);
    Object.entries({client: 'gtx', sl: 'auto', tl: targetLanguage, dt: 't'}).forEach(([key, value]) => url.searchParams.set(key, value));
    const output: string[] = [];
    try {
      for (const part of splitText(text)) {
        signal.throwIfAborted();
        if (retryAt > now()) throw new TextTranslationError('rate-limit', retryAt);
        const response = await fetcher(url.href, {method: 'POST', body: new URLSearchParams({q: part}),
          credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])});
        if (response.status === 429 || response.status === 503) {
          const header = response.headers.get('Retry-After'), seconds = Number(header);
          const delay = header && Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - now() : 30_000;
          retryAt = Math.max(retryAt, now() + Math.max(1000, Number.isFinite(delay) ? delay : 30_000));
          await response.body?.cancel();
          throw new TextTranslationError('rate-limit', retryAt);
        }
        if (!response.ok) {await response.body?.cancel(); throw new TextTranslationError('unavailable');}
        const value = await readResponse(response);
        if (!Array.isArray(value) || !Array.isArray(value[0]) || !value[0].length || value[0].some(row => !Array.isArray(row) || typeof row[0] !== 'string')) throw new TextTranslationError('invalid');
        const translated = value[0].map(row => row[0]).join('');
        if (!translated.trim() || translated.length > 32_000) throw new TextTranslationError('invalid');
        output.push(translated + (part.endsWith('\n') && !translated.endsWith('\n') ? '\n' : part.endsWith(' ') && !/\s$/.test(translated) ? ' ' : ''));
      }
      signal.throwIfAborted();
      return output.join('');
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof TextTranslationError) throw error;
      throw new TextTranslationError('unavailable');
    }
  }};
}
