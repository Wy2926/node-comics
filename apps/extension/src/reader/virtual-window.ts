import type {Page, ReadingEntry} from '../types';

export interface ChapterWindow {
  copy: ReadingEntry;
  /** Prefix sums use the same page heights as the rendered frames; no invented inter-page gaps. */
  offsets: number[];
  start: number;
  end: number;
  before: number;
  after: number;
}
export function chapterWindow(sequence: ReadingEntry[], current: ReadingEntry): ReadingEntry[] {
  const at = sequence.findIndex(copy => copy.id === current.id);
  if (at < 0) return [current];
  return sequence.slice(Math.max(0, at - 1), at + 2).map(copy => copy.id === current.id ? current : copy);
}
export function pageWindow(copies: ReadingEntry[], entryId: string, index: number, height: (page: Page) => number, limit = 11): ChapterWindow[] {
  let active = 0, count = 0;
  for (const copy of copies) {
    if (copy.id === entryId) active = count + Math.max(0, Math.min(index, copy.pages.length - 1));
    count += copy.pages.length;
  }
  const size = Math.max(1, Math.trunc(limit));
  const start = Math.max(0, Math.min(active - Math.floor(size / 2), count - size));
  const end = Math.min(count, start + size);
  let cursor = 0;
  return copies.map(copy => {
    const offsets = [0];
    for (const page of copy.pages) offsets.push(offsets.at(-1)! + Math.max(1, height(page)));
    const from = Math.max(0, Math.min(copy.pages.length, start - cursor));
    const to = Math.max(from, Math.min(copy.pages.length, end - cursor));
    cursor += copy.pages.length;
    return {copy, offsets, start: from, end: to, before: offsets[from], after: offsets.at(-1)! - offsets[to]};
  });
}
/** Locate pages in unmounted spacers too, including large scrollbar jumps. */
export function pageAtHeight(offsets: number[], y: number): number {
  if (offsets.length < 2) return -1;
  let lo = 0, hi = offsets.length - 2;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (offsets[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo;
}
