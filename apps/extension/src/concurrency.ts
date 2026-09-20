import {msg} from './i18n/runtime';
export const UPLOAD_CONCURRENCY = 5;

export function normalizeConcurrency(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(10, Math.trunc(value))) : 2;
}

export class StaleOperation extends Error {
  constructor() { super(msg("账户或服务已切换，本次操作已停止。")); }
}
export function assertCurrent(current: () => boolean) { if (!current()) throw new StaleOperation(); }

/** FIFO pool used by uploads, control requests and thumbnail work. Downloads bypass it. */
export class RequestPool {
  private active = 0;
  private waiting: (() => void)[] = [];
  private limit: number;
  constructor(limit = 2) { this.limit = normalizeConcurrency(limit); }
  setLimit(limit: number) { this.limit = normalizeConcurrency(limit); this.drain(); }
  run<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        this.active++;
        Promise.resolve().then(operation).then(resolve, reject).finally(() => { this.active--; this.drain(); });
      });
      this.drain();
    });
  }
  private drain() { while (this.active < this.limit && this.waiting.length) this.waiting.shift()!(); }
}
