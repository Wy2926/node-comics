import {expect, it, vi} from 'vitest';
import {readReviewPage} from '../reviews';
import type {WorkProvider, WorkReviewPage} from '../types';

it('isolates review caches by provider, opaque work ID and page; a late cancelled page is not cached', async () => {
  const page = (title: string): WorkReviewPage => ({work: {title, url: 'https://example.org/work'}, reviews: [], hasMore: false});
  const provider = (id: string) => ({id, label: id, search: vi.fn(), reviews: vi.fn(async () => page(id))} satisfies WorkProvider);
  const a = provider('first'), b = provider('second'), signal = new AbortController().signal;
  expect((await readReviewPage(a, 'same-id', 1, signal)).work.title).toBe('first');
  expect((await readReviewPage(b, 'same-id', 1, signal)).work.title).toBe('second');
  await readReviewPage(a, 'same-id', 1, signal);
  expect(a.reviews).toHaveBeenCalledTimes(1);
  const cancelled = new AbortController();
  a.reviews.mockImplementationOnce(async () => {cancelled.abort(); return page('stale');});
  await expect(readReviewPage(a, 'same-id', 2, cancelled.signal)).rejects.toMatchObject({name: 'AbortError'});
  expect((await readReviewPage(a, 'same-id', 2, signal)).work.title).toBe('first');
  await readReviewPage(a, 'other-id', 1, signal);
  expect(a.reviews).toHaveBeenCalledTimes(4);
});
