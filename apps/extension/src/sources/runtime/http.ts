import type {SourceNetworkContext} from '../contracts/network';
import {msg} from '../../i18n/runtime';
import {originMatches} from '../shared/origins';
import {resolveSource} from '../core/resolve';
import {definitions} from '../registry/definitions';
import {safeImageUrl} from '../shared/urls';
import {withImageHeaders} from './image-headers';
import type {ImportResponse} from './import-responses';

export class SourceHttpError extends Error {
  constructor(readonly kind: 'request-denied' | 'permission-required' | 'http' | 'invalid-response', message: string,
    readonly details: {status?: number; retryAfter?: number} = {}) {
    super(message);
    this.name = 'SourceHttpError';
  }
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(1, Math.ceil(seconds))) : undefined;
}
/** Packaged source parsers share a bounded transport, with an optional operation-specific allowlist. */
export function createSourceNetworkContext(sourceUrl: string, signal?: AbortSignal, replay: ImportResponse[] = [],
  allowedOrigins?: readonly string[]): SourceNetworkContext {
  return {signal, async request(url, options) {
    signal?.throwIfAborted();
    if (safeImageUrl(url, url) !== url) throw new SourceHttpError('request-denied', '来源请求地址无效。');
    if (allowedOrigins && !allowedOrigins.some(origin => originMatches(origin, url)))
      throw new SourceHttpError('request-denied', '来源请求超出声明范围。');
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      const origins = [new URL(url).origin + '/*'];
      if (!await chrome.permissions.contains({origins}))
        throw new SourceHttpError('permission-required', msg('网站访问权限已被浏览器关闭，请在扩展设置中允许访问所有网站后重试。'));
      signal?.throwIfAborted();
    }
    if (options && (safeImageUrl(options.referer, options.referer) !== options.referer || new URL(options.referer).origin !== new URL(url).origin ||
      resolveSource(options.referer, definitions).definition.id !== resolveSource(sourceUrl, definitions).definition.id))
      throw new SourceHttpError('request-denied', '来源请求头归属无效。');
    const cached = replay.findIndex(response => response.url === url && response.referer === options?.referer);
    if (cached >= 0) return replay.splice(cached, 1)[0].body;
    const lifetime = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    return withImageHeaders(url, options ? {referer: options.referer} : undefined, lifetime, async () => {
      const response = await fetch(url, {credentials: 'include', redirect: 'error', headers: {Accept: 'application/json, text/html'}, signal: lifetime});
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourceHttpError('http', `来源请求失败（HTTP ${response.status}），请稍后重试或在源站完成验证。`,
          {status: response.status, retryAfter: retryAfter(response.headers.get('retry-after'))});
      }
      if (!response.body) throw new SourceHttpError('http', '来源响应为空。');
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          lifetime.throwIfAborted();
          const {done, value} = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 8 * 1024 * 1024) throw new SourceHttpError('invalid-response', '来源响应超过限制。');
          chunks.push(value);
        }
      } catch (error) {await reader.cancel().catch(() => {}); throw error;} finally {reader.releaseLock();}
      lifetime.throwIfAborted();
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
      return new TextDecoder().decode(bytes);
    });
  }};
}
