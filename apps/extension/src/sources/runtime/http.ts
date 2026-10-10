import type {SourceNetworkContext} from '../contracts/network';
import {msg} from '../../i18n/runtime';
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

export function sourceRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(1, Math.ceil(seconds))) : undefined;
}
function encodeForm(form: Readonly<Record<string, string>>): string {
  const invalid = () => {throw new SourceHttpError('request-denied', '来源请求表单无效或超过限制。');};
  if (!form || typeof form !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(form))) return invalid();
  const body = new URLSearchParams(), limit = 1024 * 1024;
  let length = 0;
  for (const key of Reflect.ownKeys(form)) {
    const field = Object.getOwnPropertyDescriptor(form, key)!;
    if (typeof key !== 'string' || !key || /[\u0000-\u001f\u007f]/.test(key) || !field.enumerable || !('value' in field) ||
      typeof field.value !== 'string') return invalid();
    length += key.length + field.value.length + 1 + (length ? 1 : 0);
    if (length > limit) return invalid();
    body.append(key, field.value);
  }
  const encoded = body.toString();
  if (encoded.length > limit) return invalid();
  return encoded;
}
/** Shared authorization for extension HTTP and source-page requests. */
export async function authorizeSourceRequest(url: string, options: Parameters<SourceNetworkContext['request']>[1], signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (safeImageUrl(url, url) !== url) throw new SourceHttpError('request-denied', '来源请求地址无效。');
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    const origins = [new URL(url).origin + '/*'];
    if (!await chrome.permissions.contains({origins}))
      throw new SourceHttpError('permission-required', msg('网站访问权限已被浏览器关闭，请在扩展设置中允许访问所有网站后重试。'));
    signal?.throwIfAborted();
  }
  if (options && safeImageUrl(options.referer, options.referer) !== options.referer)
    throw new SourceHttpError('request-denied', '来源请求 Referer 地址无效。');
  return options?.form === undefined ? undefined : encodeForm(options.form);
}
/** Packaged adapters choose request hosts; the transport checks browser access and resource budgets. */
export function createSourceNetworkContext(signal?: AbortSignal, replay: ImportResponse[] = []): SourceNetworkContext {
  return {signal, async request(url, options) {
    const body = await authorizeSourceRequest(url,options,signal);
    const cached = body === undefined ? replay.findIndex(response => response.url === url && response.referer === options?.referer) : -1;
    if (cached >= 0) return replay.splice(cached, 1)[0].body;
    const lifetime = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    return withImageHeaders(url, options ? {referer: options.referer} : undefined, lifetime, async () => {
      const response = await fetch(url, {credentials: 'include', headers: {Accept: 'application/json, text/html',
        ...(body === undefined ? {} : {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'})}, signal: lifetime,
        ...(body === undefined ? {} : {method: 'POST', body})});
      // Some sources return a structured empty result with a non-success status.
      // Only explicitly requested error responses reach the owning parser.
      if (!response.ok && !(response.status >= 400 && response.status <= 599 && options?.acceptStatuses?.includes(response.status))) {
        await response.body?.cancel();
        throw new SourceHttpError('http', `来源请求失败（HTTP ${response.status}），请稍后重试或在源站完成验证。`,
          {status: response.status, retryAfter: sourceRetryAfter(response.headers.get('retry-after'))});
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
