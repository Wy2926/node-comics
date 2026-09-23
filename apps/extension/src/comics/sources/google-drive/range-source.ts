import type {RandomAccessSource, SourceSnapshot} from '../../formats/contracts';
import {checkDriveResponse, DriveError} from './errors';
import {DRIVE_API, driveHeaders, fetchDriveMetadata, type DriveBinding, type DriveFetch} from './metadata';

export interface DriveRangeOptions {
  token: () => Promise<string>;
  fetch?: DriveFetch;
  maxRequestBytes?: number;
  maxNetworkBytes?: number;
  timeoutMs?: number;
  allowWholeFile200?: boolean;
  onAccessLost?: (binding: DriveBinding) => Promise<void>;
}

/** No persistent token or source bytes. Every delivered range is bracketed by version checks. */
export class DriveRangeSource implements RandomAccessSource {
  readonly snapshot: SourceSnapshot;
  private readonly controller = new AbortController();
  private readonly request: DriveFetch;
  private used = 0;
  private changed = false;
  private readonly inFlight = new Map<string, {controller: AbortController; promise: Promise<Uint8Array>; consumers: number}>();
  constructor(readonly binding: DriveBinding, private readonly options: DriveRangeOptions) {
    if (!Number.isSafeInteger(binding.size) || binding.size <= 0) throw new DriveError('invalid-response', '无效的文件大小。');
    this.snapshot = {identity: `google-drive:${binding.accountId}:${binding.fileId}`, version: binding.version, size: binding.size, local: false};
    // Calling an unbound browser fetch as this.request gives it a DriveRangeSource receiver.
    this.request = (options.fetch ?? fetch).bind(globalThis);
  }
  get networkBytes() { return this.used; }
  private signal(signal?: AbortSignal) {
    return AbortSignal.any([this.controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(this.options.timeoutMs ?? 30_000)]);
  }
  private async metadata(signal: AbortSignal) {
    const result = await fetchDriveMetadata(this.binding, await this.options.token(), signal, this.request);
    if (result.version !== this.binding.version || result.size !== this.binding.size) {
      this.changed = true; this.controller.abort();
      throw new DriveError('source-changed', 'Google Drive 文件已变化，请建立新版本后继续阅读。');
    }
    return result;
  }
  async validate(signal?: AbortSignal): Promise<'unchanged' | 'changed' | 'unavailable'> {
    if (this.changed) return 'changed';
    try { await this.metadata(this.signal(signal)); return 'unchanged'; }
    catch (error) {
      if (error instanceof DriveError && error.code === 'source-changed') return 'changed';
      if (error instanceof DriveError && ['access-revoked', 'download-forbidden'].includes(error.code)) await this.options.onAccessLost?.(this.binding);
      if (signal?.aborted) throw signal.reason;
      return 'unavailable';
    }
  }
  async readAt(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const key = `${offset}:${length}`;
    let job = this.inFlight.get(key);
    if (!job) {
      const controller = new AbortController();
      job = {controller, promise: this.readRange(offset, length, controller.signal), consumers: 0};
      this.inFlight.set(key, job);
      const current = job;
      void job.promise.finally(() => { if (this.inFlight.get(key) === current) this.inFlight.delete(key); }).catch(() => {});
    }
    job.consumers++;
    const current = job;
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const release = () => {
        if (settled) return false;
        settled = true; signal?.removeEventListener('abort', cancel);
        if (--current.consumers === 0) current.controller.abort();
        return true;
      };
      const cancel = () => { if (release()) reject(signal?.reason); };
      signal?.addEventListener('abort', cancel, {once: true});
      current.promise.then(bytes => { if (release()) resolve(bytes.slice()); }, error => { if (release()) reject(error); });
    });
  }
  private async readRange(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.changed) throw new DriveError('source-changed', 'Google Drive 文件已变化。');
    const combined = this.signal(signal); combined.throwIfAborted();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > this.snapshot.size - length)
      throw new RangeError('读取范围超出文件边界。');
    if (length === 0) return new Uint8Array();
    if (length > (this.options.maxRequestBytes ?? 32 * 1024 * 1024) || this.used + length > (this.options.maxNetworkBytes ?? 64 * 1024 * 1024))
      throw new DriveError('budget-exceeded', '本次云端读取超出字节预算，请重试当前页或从本地导入。');
    // Reserve before awaiting; parallel requests cannot both spend the same remaining budget.
    this.used += length;
    try {
      await this.metadata(combined);
      const headers = driveHeaders(await this.options.token(), this.binding);
      headers.set('Range', `bytes=${offset}-${offset + length - 1}`);
      const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(this.binding.fileId)}?alt=media&supportsAllDrives=true`, {
        headers, signal: combined, cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      await checkDriveResponse(response);
      const whole = offset === 0 && length === this.snapshot.size && this.options.allowWholeFile200 === true;
      if (response.status !== 206 && !(response.status === 200 && whole)) {
        await response.body?.cancel();
        throw new DriveError('range-unsupported', '云盘没有按范围返回文件，已停止读取；请从本地导入。');
      }
      if (response.status === 206 && response.headers.get('Content-Range') !== `bytes ${offset}-${offset + length - 1}/${this.snapshot.size}`) {
        await response.body?.cancel(); throw new DriveError('invalid-response', 'Google Drive 返回了错误的文件范围。');
      }
      const reported = response.headers.get('Content-Length');
      if (reported !== null && Number(reported) !== length) {
        await response.body?.cancel(); throw new DriveError('invalid-response', 'Google Drive 返回了错误的字节长度。');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DriveError('invalid-response', 'Google Drive 未返回文件字节。');
      const bytes = new Uint8Array(length);
      let written = 0;
      try {
        while (true) {
          combined.throwIfAborted();
          const {done, value} = await reader.read();
          if (done) break;
          if (written + value.byteLength > length) throw new DriveError('invalid-response', 'Google Drive 返回字节超出请求范围。');
          bytes.set(value, written); written += value.byteLength;
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      if (written !== length) throw new DriveError('invalid-response', 'Google Drive 返回的文件范围不完整。');
      await this.metadata(combined);
      combined.throwIfAborted();
      return bytes;
    } catch (error) {
      if (error instanceof DriveError && ['access-revoked', 'download-forbidden'].includes(error.code)) {
        this.controller.abort(); await this.options.onAccessLost?.(this.binding);
      }
      if (error instanceof TypeError && !combined.aborted) throw new DriveError('offline', '无法连接 Google Drive，已缓存页面仍可阅读。');
      throw error;
    }
  }
  async close() { this.controller.abort(); }
}
