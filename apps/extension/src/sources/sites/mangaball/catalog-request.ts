import type {SourceNetworkContext} from '../../contracts/network';

// Keep a 100-page catalog's pacing below 50 seconds of the public 120-second lifetime.
const interval = 500;
const retryDelays = [1000, 2000, 4000];
const retryWaitBudget = 30000;

function rateLimit(error: unknown): {retryAfter?: number} | undefined {
  if (!(error instanceof Error)) return;
  const source = error as Error & {kind?: unknown; details?: unknown};
  if (source.kind !== undefined && source.kind !== 'http') return;
  if (!source.details || typeof source.details !== 'object' || Array.isArray(source.details)) return;
  const details = source.details as {status?: unknown; retryAfter?: unknown};
  if (details.status !== 429) return;
  return {retryAfter: typeof details.retryAfter === 'number' && Number.isFinite(details.retryAfter) && details.retryAfter > 0
    ? details.retryAfter * 1000 : undefined};
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, {once: true});
  });
}

/** Per-operation pacing; retries retain completed catalog pages and never change the transport. */
export function createCatalogRequest(context: SourceNetworkContext): SourceNetworkContext['request'] {
  let lastAttemptAt: number | undefined, retryWait = 0;
  return async (url, options) => {
    for (let attempt = 0; ; attempt++) {
      context.signal?.throwIfAborted();
      if (lastAttemptAt !== undefined) await wait(Math.min(interval, Math.max(0, interval - (Date.now() - lastAttemptAt))), context.signal);
      context.signal?.throwIfAborted();
      lastAttemptAt = Date.now();
      try {
        const body = await context.request(url, options);
        context.signal?.throwIfAborted();
        return body;
      } catch (error) {
        context.signal?.throwIfAborted();
        const limited = rateLimit(error);
        if (!limited || attempt >= retryDelays.length) throw error;
        const delay = Math.max(retryDelays[attempt], limited.retryAfter ?? 0);
        // Long Retry-After values are preserved by failing, rather than retrying too early.
        if (delay > retryWaitBudget - retryWait) throw error;
        retryWait += delay;
        await wait(delay, context.signal);
      }
    }
  };
}
