import {DiscoveryError, type WorkProvider, type WorkReviewPage} from './types';

const pages = new Map<string, {value: WorkReviewPage; at: number}>();

/** Cache completed public pages only. A caller owns and can cancel its own request. */
export async function readReviewPage(provider: WorkProvider, workId: string, page: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!provider.reviews) throw new DiscoveryError('unavailable');
  const key = JSON.stringify([provider.id, workId, page]), cached = pages.get(key);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  const value = await provider.reviews(workId, page, signal);
  signal.throwIfAborted();
  pages.delete(key);
  pages.set(key, {value, at: Date.now()});
  if (pages.size > 20) pages.delete(pages.keys().next().value!);
  return value;
}
