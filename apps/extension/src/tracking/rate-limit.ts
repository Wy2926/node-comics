const cooldownKey = 'nc-anilist-rate-limit-until';

export interface AniListRateLimit {
  availableAt(): Promise<number>;
  observe(response: Response): Promise<number>;
}

/** Public platform cooldown only: never stores credentials or user/list data. */
export function createAniListRateLimit(now = Date.now, persist = false): AniListRateLimit {
  let retryAt = 0;
  const storage = () => persist && typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
  async function availableAt(): Promise<number> {
    try {
      const value = (await storage()?.get(cooldownKey))?.[cooldownKey];
      if (typeof value === 'number' && Number.isFinite(value)) retryAt = Math.max(retryAt, value);
    } catch { /* A storage failure must not prevent public discovery. */ }
    return retryAt > now() ? retryAt : 0;
  }
  return {
    availableAt,
    async observe(response) {
      if (response.status !== 429 && response.headers.get('X-RateLimit-Remaining') !== '0') return availableAt();
      const time = now(), header = response.headers.get('Retry-After');
      const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : undefined;
      const date = header ? Date.parse(header) : NaN;
      const resetValue = Number(response.headers.get('X-RateLimit-Reset')) * 1000;
      const reset = Number.isFinite(resetValue) ? resetValue : 0;
      const wait = seconds !== undefined ? time + seconds * 1000 : Number.isFinite(date) ? date : 0;
      retryAt = Math.max(await availableAt(), time + 1000, wait, reset);
      if (retryAt <= time + 1000 && !wait && reset <= time) retryAt = time + 60_000;
      try { await storage()?.set({[cooldownKey]: retryAt}); } catch { /* Keep this context's cooldown. */ }
      return retryAt;
    },
  };
}

// This timestamp is advisory across extension contexts; the server owns quota.
export const aniListRateLimit = createAniListRateLimit(Date.now, true);
