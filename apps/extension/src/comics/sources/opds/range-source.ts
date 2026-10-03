import type { RandomAccessSource, SourceSnapshot } from '../../formats/contracts';
import { checkRange } from '../../formats/contracts';
import { OpdsError } from './errors';
import type { PrivateConnection } from './private-store';
import { OpdsTransport } from './transport';

export interface RangeBinding {
  url: string;
  etag?: string;
  lastModified?: string;
  size: number;
  identity: string;
}
export function rangeVersion(binding: Pick<RangeBinding,'etag'|'lastModified'|'size'>):string {
  return binding.etag ?? `modified:${binding.lastModified}:${binding.size}`;
}
export async function probeRange(
  transport: OpdsTransport,
  connection: PrivateConnection,
  url: string,
  signal?: AbortSignal,
): Promise<Omit<RangeBinding, 'url' | 'identity'> | undefined> {
  try {
    const result = await transport.bytes(connection, url, {
        headers: { Range: 'bytes=0-0' },
        status: 206,
        maxBytes: 1,
        signal,
      }),
      match = /^bytes 0-0\/(\d+)$/.exec(result.headers.get('Content-Range') ?? ''),
      tag = result.headers.get('ETag'),
      etag = tag && /^"[^\r\n]+"$/.test(tag) ? tag : undefined,
      modified = result.headers.get('Last-Modified'),
      date = Date.parse(result.headers.get('Date') ?? ''),
      // RFC 9110 requires sufficiently separated server dates for a strong validator;
      // use a conservative 60-second margin for clock skew, never a weak ETag alone.
      lastModified = modified && Number.isFinite(Date.parse(modified)) &&
        Number.isFinite(date) && date-Date.parse(modified)>=60_000 ? modified : undefined;
    if (
      !match ||
      result.bytes.length !== 1 ||
      (!etag && !lastModified)
    )
      return;
    const size = Number(match[1]);
    if (Number.isSafeInteger(size) && size > 0) return { ...(etag ? {etag} : {lastModified}), size };
  } catch (error) {
    if (!(error instanceof OpdsError) || error.code !== 'range-unsupported') throw error;
  }
}
/** A verified HTTP validator and exact 206 response bind every range to one file. */
export class OpdsRangeSource implements RandomAccessSource {
  readonly snapshot: SourceSnapshot;
  private controller = new AbortController();
  private changed = false;
  private transferred = 0;
  constructor(
    private readonly transport: OpdsTransport,
    private readonly connection: PrivateConnection,
    private readonly binding: RangeBinding,
    private readonly current: () => Promise<boolean>,
  ) {
    this.snapshot = {
      identity: binding.identity,
      version: rangeVersion(binding),
      size: binding.size,
      local: false,
    };
  }
  async readAt(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    checkRange(this, offset, length);
    if (!length) return new Uint8Array();
    if (this.changed) throw new OpdsError('source-changed', 'OPDS 文件已更新，请重新打开。');
    if (!(await this.current()))
      throw new OpdsError('disconnected', 'OPDS 连接授权已变更，请重新打开。');
    if (
      length > 64 * 1024 * 1024 ||
      this.transferred + length > this.binding.size + 16 * 1024 * 1024
    )
      throw new OpdsError('too-large', '分段读取超过本次会话限制。');
    this.transferred += length;
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    const result = await this.transport.bytes(this.connection, this.binding.url, {
      headers: {
        Range: `bytes=${offset}-${offset + length - 1}`,
        ...(this.binding.etag ? {'If-Match':this.binding.etag} : {'If-Unmodified-Since':this.binding.lastModified!}),
      },
      status: 206,
      maxBytes: length,
      signal: combined,
    });
    if (
      (this.binding.etag ? result.headers.get('ETag') !== this.binding.etag :
        result.headers.get('Last-Modified') !== this.binding.lastModified) ||
      result.headers.get('Content-Range') !==
        `bytes ${offset}-${offset + length - 1}/${this.binding.size}` ||
      result.bytes.length !== length
    ) {
      this.changed = true;
      throw new OpdsError('source-changed', 'OPDS 文件版本或分段响应已改变，请重新打开。');
    }
    if (!(await this.current()))
      throw new OpdsError('disconnected', 'OPDS 连接授权已变更，请重新打开。');
    return result.bytes;
  }
  async validate(signal?: AbortSignal): Promise<'unchanged' | 'changed' | 'unavailable'> {
    if (this.changed) return 'changed';
    if (!(await this.current())) return 'unavailable';
    try {
      const probe = await probeRange(this.transport, this.connection, this.binding.url, signal);
      if (!probe) return 'unavailable';
      if (rangeVersion(probe) !== rangeVersion(this.binding) || probe.size !== this.binding.size) {
        this.changed = true;
        return 'changed';
      }
      return 'unchanged';
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof OpdsError) return 'unavailable';
      throw error;
    }
  }
  async close() {
    this.controller.abort();
  }
}
