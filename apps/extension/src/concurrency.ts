export function normalizeConcurrency(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(10, Math.trunc(value))) : 2;
}

export class StaleOperation extends Error {
  constructor() { super('账户或服务已切换，本次操作已停止。'); }
}
export function assertCurrent(current: () => boolean) { if (!current()) throw new StaleOperation(); }

/** One shared, adjustable FIFO pool for this reader's network requests. */
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

/** Bound page preparation too, so queued uploads do not retain a whole book in memory. */
export async function mapConcurrent<T, R>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(items.length, normalizeConcurrency(concurrency))}, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = {status: 'fulfilled', value: await operation(items[index], index)}; }
      catch (reason) { results[index] = {status: 'rejected', reason}; }
    }
  }));
  return results;
}
