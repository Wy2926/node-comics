import { OpdsError } from './errors';
import type { PrivateConnection } from './private-store';
import type { OpdsProgressTarget } from './progress';

// Originals follow the reader's existing resource/decode budget; never resize or truncate them here.
export const CATALOG_LIMIT = 4 * 1024 * 1024,
  IMAGE_LIMIT = Number.MAX_SAFE_INTEGER,
  DOWNLOAD_LIMIT = 512 * 1024 * 1024;
export interface NetworkResult {
  bytes: Uint8Array<ArrayBuffer>;
  headers: Headers;
  status: number;
  url: string;
}
export interface RequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
  method?: 'GET' | 'HEAD';
  maxBytes?: number;
  status?: number;
  timeoutMs?: number;
}
type TransportRequestOptions = Omit<RequestOptions, 'method'> &
  (
    | { method?: 'GET' | 'HEAD'; body?: never }
    | { method: 'POST' | 'PUT' | 'PATCH'; body: string }
  );
function retryAfter(value: string | null): number | undefined {
  if (!value) return;
  const seconds = /^\d+$/.test(value.trim())
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.min(86400, Math.max(0, seconds)) : undefined;
}
export function validateRoot(value: string, authenticated: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpdsError('scope-blocked', '请输入完整的 OPDS HTTP(S) 地址。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new OpdsError('scope-blocked', 'OPDS 地址不能包含内嵌用户密码或片段。');
  if (authenticated && url.protocol !== 'https:')
    throw new OpdsError('scope-blocked', '携带凭据的 OPDS 连接需要 HTTPS。');
  return url.href;
}
export function allowedUrl(connection: PrivateConnection, value: string): string {
  const href = validateRoot(value, connection.auth.kind !== 'anonymous');
  if (/[{}]|%7[bd]/i.test(href))
    throw new OpdsError('scope-blocked', '资源地址含有未展开的模板参数。');
  return href;
}
export async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const advertised = Number(response.headers.get('Content-Length'));
  if (advertised > limit) {
    await response.body?.cancel();
    throw new OpdsError('too-large', 'OPDS 响应超出大小限制。');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new OpdsError('too-large', 'OPDS 响应超出大小限制。');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
/** Native redirects for reads; credentials and progress writes stay scoped to the connection. */
export class OpdsTransport {
  private active = 0;
  private waiters: (() => void)[] = [];
  private controllers = new Map<string, Set<AbortController>>();
  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly validateCurrent?: (connection: PrivateConnection) => Promise<void>,
  ) {}
  abortConnection(id: string) {
    const controllers = this.controllers.get(id);
    this.controllers.delete(id);
    for (const controller of controllers ?? []) controller.abort();
  }
  private async enter(signal?: AbortSignal) {
    while (this.active >= 4) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          this.waiters = this.waiters.filter((v) => v !== wake);
          reject(signal!.reason);
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    signal?.throwIfAborted();
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
        this.waiters.shift()?.();
      }
    };
  }
  private async response(
    connection: PrivateConnection,
    url: string,
    options: TransportRequestOptions,
  ): Promise<{ response: Response; release: () => void }> {
    const href = allowedUrl(connection, url);
    const controller = new AbortController(),
      set = this.controllers.get(connection.id) ?? new Set<AbortController>();
    set.add(controller);
    this.controllers.set(connection.id, set);
    const signal = AbortSignal.any([
      controller.signal,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(options.timeoutMs ?? 30000),
    ]);
    let leave: (() => void) | undefined;
    const release = () => {
      leave?.();
      set.delete(controller);
      if (!set.size && this.controllers.get(connection.id) === set)
        this.controllers.delete(connection.id);
    };
    try {
      leave = await this.enter(signal);
      await this.validateCurrent?.(connection);
      signal.throwIfAborted();
      const headers = new Headers(options.headers);
      headers.delete('Cookie');
      headers.delete('Authorization');
      if (connection.auth.kind === 'basic' && new URL(href).origin === new URL(connection.root).origin) {
        const bytes = new TextEncoder().encode(
          `${connection.auth.username}:${connection.auth.password}`,
        );
        headers.set(
          'Authorization',
          `Basic ${btoa(Array.from(bytes, (n) => String.fromCharCode(n)).join(''))}`,
        );
      }
      const response = await this.request.call(globalThis, href, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal,
        redirect: options.body === undefined ? 'follow' : 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      if (response.status === 403) {
        await response.body?.cancel();
        throw new OpdsError(
          'access-denied',
          'OPDS 服务器拒绝访问此资源（HTTP 403），请检查账号的资源访问或文件下载权限。',
          { status: response.status },
        );
      }
      if (response.status === 401) {
        if (
          response.headers.get('Content-Type')?.split(';')[0].trim() ===
          'application/opds-authentication+json'
        ) {
          const bytes = await readBounded(response, 128 * 1024);
          let auth: unknown;
          try {
            auth = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            auth = undefined;
          }
          const flows = (auth as { authentication?: { type?: string }[] } | undefined)
            ?.authentication;
          if (
            Array.isArray(flows) &&
            flows.length &&
            !flows.some((flow) => flow.type === 'http://opds-spec.org/auth/basic')
          )
            throw new OpdsError(
              'unsupported-auth',
              '此 OPDS 服务要求尚未支持的登录流程；目前支持匿名、Basic 和令牌地址。',
            );
        } else await response.body?.cancel();
        throw new OpdsError(
          'authentication-required',
          'OPDS 身份认证失败（HTTP 401），请更新连接授权。',
          { status: response.status },
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        const details = {
          status: response.status,
          retryAfter: retryAfter(response.headers.get('Retry-After')),
        };
        if (response.status === 412)
          throw new OpdsError('source-changed', 'OPDS 文件已更新，请重新打开。', details);
        if (response.status === 429 || details.retryAfter)
          throw new OpdsError('rate-limit', 'OPDS 服务暂时限制请求，请稍后重试。', details);
        throw new OpdsError('network', `OPDS 请求失败（HTTP ${response.status}）。`, details);
      }
      if (options.status && response.status !== options.status) {
        await response.body?.cancel();
        throw new OpdsError('range-unsupported', '此服务不支持可靠的分段读取，请选择下载后阅读。');
      }
      return { response, release };
    } catch (error) {
      release();
      if (error instanceof OpdsError) throw error;
      if (options.signal?.aborted) throw options.signal.reason;
      throw new OpdsError('network', 'OPDS 网络请求失败，请检查地址、网络或服务器重定向设置。');
    }
  }
  private async buffered(
    connection: PrivateConnection,
    url: string,
    options: TransportRequestOptions,
  ): Promise<NetworkResult> {
    const { response, release } = await this.response(connection, url, options);
    try {
      const bytes = await readBounded(response, options.maxBytes ?? CATALOG_LIMIT);
      await this.validateCurrent?.(connection);
      return { bytes, headers: response.headers, status: response.status, url: response.url || url };
    } catch (error) {
      if (error instanceof OpdsError) throw error;
      if (options.signal?.aborted) throw options.signal.reason;
      throw new OpdsError('network', 'OPDS 响应读取失败。');
    } finally {
      release();
    }
  }
  bytes(connection: PrivateConnection, url: string, options: RequestOptions = {}) {
    return this.buffered(connection, url, options);
  }
  async writeProgress(
    connection: PrivateConnection,
    target: OpdsProgressTarget,
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = allowedUrl(connection, target.url);
    if (new URL(url).origin !== new URL(connection.root).origin)
      throw new OpdsError('scope-blocked', '目录指向未授权的外部地址，请为该服务单独添加连接。');
    const body = JSON.stringify(payload);
    const limit = 128 * 1024;
    if (new TextEncoder().encode(body).byteLength > limit)
      throw new OpdsError('too-large', 'OPDS 阅读进度请求超出大小限制。');
    await this.buffered(connection, url, {
      method: target.method,
      body,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      maxBytes: limit,
      signal,
    });
  }
  async document(connection: PrivateConnection, url: string, signal?: AbortSignal) {
    const result = await this.bytes(connection, url, {
      signal,
      headers: {
        Accept:
          'application/opds+json, application/atom+xml, application/opds-publication+json, application/divina+json, application/webpub+json, application/opensearchdescription+xml',
      },
    });
    return {
      text: new TextDecoder().decode(result.bytes),
      contentType: result.headers.get('Content-Type') ?? '',
      url: result.url,
    };
  }
  async download(
    connection: PrivateConnection,
    url: string,
    signal?: AbortSignal,
    binding?: { etag?: string; lastModified?:string; size?: number },
  ) {
    const { response, release } = await this.response(connection, url, {
      signal,
      timeoutMs: 300000,
      headers: binding?.etag ? { 'If-Match': binding.etag } : binding?.lastModified ? {'If-Unmodified-Since':binding.lastModified} : undefined,
    });
    const reader = response.body?.getReader();
    const size = Number(response.headers.get('Content-Length')) || undefined;
    if (
      response.status !== 200 ||
      (binding?.etag && response.headers.get('ETag') !== binding.etag) ||
      (binding?.lastModified && response.headers.get('Last-Modified') !== binding.lastModified) ||
      (binding?.size && size && binding.size !== size)
    ) {
      await reader?.cancel();
      release();
      throw new OpdsError('source-changed', 'OPDS 文件在下载前已改变，请重新打开。');
    }
    if (!reader || (size && size > DOWNLOAD_LIMIT)) {
      await reader?.cancel();
      release();
      throw new OpdsError('too-large', '下载文件为空或超过 512 MiB 上限。');
    }
    let total = 0;
    const current = this.validateCurrent;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          await current?.(connection);
          const result = await reader.read();
          if (result.done) {
            if ((binding?.size ?? size) !== undefined && total !== (binding?.size ?? size))
              throw new OpdsError('source-changed', 'OPDS 文件下载不完整或大小已改变。');
            release();
            controller.close();
            return;
          }
          total += result.value.byteLength;
          if (total > DOWNLOAD_LIMIT)
            throw new OpdsError('too-large', '下载文件超过 512 MiB 上限。');
          if (binding?.size && total > binding.size)
            throw new OpdsError('source-changed', 'OPDS 文件下载大小已改变。');
          controller.enqueue(result.value);
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          release();
          controller.error(
            error instanceof OpdsError ? error : new OpdsError('network', 'OPDS 下载中断。'),
          );
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
        release();
      },
    });
    return { stream, size };
  }
}
