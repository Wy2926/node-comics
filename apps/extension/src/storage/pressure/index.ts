import { sourcePageCache } from '../source-pages';
import { sourceRangeCache } from '../source-ranges';
import { thumbnailCache } from '../thumbnails';
import { translationCache } from '../translations';

/** One bounded cleanup pass. Retained source containers/downloads are deliberately not registered. */
export async function relieveStoragePressure(bytes: number): Promise<number> {
  let remaining = Math.max(0, bytes), released = 0;
  for (const cache of [thumbnailCache, sourceRangeCache, sourcePageCache, translationCache]) {
    if (remaining <= 0) break;
    const amount = await cache.trim(remaining); released += amount; remaining -= amount;
  }
  return released;
}
export async function estimateStorage(): Promise<{ usage: number; quota?: number; available?: number }> {
  const estimate = typeof navigator !== 'undefined' && navigator.storage?.estimate ? await navigator.storage.estimate() : {};
  return { usage: estimate.usage ?? 0, quota: estimate.quota, available: estimate.quota === undefined ? undefined : Math.max(0, estimate.quota - (estimate.usage ?? 0)) };
}
export const isStorageQuotaError = (error: unknown) => error instanceof DOMException && error.name === 'QuotaExceededError';
