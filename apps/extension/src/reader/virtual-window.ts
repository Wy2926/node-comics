import type {Page, ReadingEntry, Settings} from '../types';
import {DECODED_PAGE_WINDOW} from '../image-resources';
import {spreadStartingAt} from './pagination';
import {completePageList} from './model';

export interface ChapterWindow {
  copy: ReadingEntry;
  /** Prefix sums use the same page heights as the rendered frames; no invented inter-page gaps. */
  offsets: number[];
  start: number;
  end: number;
  before: number;
  after: number;
}
export interface ChapterGeometry {
  copy: ReadingEntry;
  offsets: number[];
  width: number;
}
/** Reuse immutable page lists from the preceding window, only with the same frame settings. */
export function chapterGeometry(copies: readonly ReadingEntry[], frame: (page: Page) => {width: number; height: number}, previous: readonly ChapterGeometry[] = []): ChapterGeometry[] {
  return copies.map(copy => {
    const measured = previous.find(chapter => chapter.copy.id === copy.id && chapter.copy.pages === copy.pages);
    if (measured) return measured.copy === copy ? measured : {...measured, copy};
    const offsets = [0];
    let width = 0;
    for (const page of copy.pages) {
      const size = frame(page);
      offsets.push(offsets.at(-1)! + Math.max(1, size.height));
      width = Math.max(width, size.width);
    }
    return {copy, offsets, width};
  });
}
export function chapterWindow(sequence: ReadingEntry[], current: ReadingEntry): ReadingEntry[] {
  const at = sequence.findIndex(copy => copy.id === current.id);
  if (at < 0) return [current];
  return sequence.slice(Math.max(0, at - 1), at + 2).map(copy => copy.id === current.id ? current : copy);
}
/** Paged layouts prepare only the selected next chapter, close to a confirmed chapter end. */
export function chapterResources(stream:ReadingEntry[],current:ReadingEntry,index:number,next:ReadingEntry|undefined,layout:Settings['layout']):ReadingEntry[]{
  if(layout==='continuous')return stream;
  return next&&completePageList(current)&&index>=current.pages.length-3?[current,next]:[current];
}
export function pageWindow(chapters: readonly ChapterGeometry[], entryId: string, index: number): ChapterWindow[] {
  let active = 0, count = 0;
  for (const {copy} of chapters) {
    if (copy.id === entryId) active = count + Math.max(0, Math.min(index, copy.pages.length - 1));
    count += copy.pages.length;
  }
  const start = Math.max(0, Math.min(active - Math.floor(DECODED_PAGE_WINDOW / 2), count - DECODED_PAGE_WINDOW));
  const end = Math.min(count, start + DECODED_PAGE_WINDOW);
  let cursor = 0;
  return chapters.map(({copy, offsets}) => {
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

/** Layouts choose a range; all use the same bounded byte-prefetch pipeline outside the mounted window. */
export function nextImagePages(windows:readonly ChapterWindow[],layout:Settings['layout'],next?:ReadingEntry):Page[]{
  const tail=[...windows].reverse().find(window=>window.end>window.start);
  if(!tail)return [];
  const {copy,end:start}=tail;
  const end=layout==='double'?spreadStartingAt(copy.pages,start)?.end??start:start+(layout==='single'?1:2);
  const pages=copy.pages.slice(start,end),limit=layout==='single'?1:2;
  // Never skip an unfinished manifest, mix two chapters into a spread, or recurse through the catalog.
  if(!next||next.id===copy.id||!completePageList(copy)||pages.length>=limit||layout==='double'&&pages.length)return pages;
  const opening=layout==='double'?spreadStartingAt(next.pages,0)?.end??0:limit-pages.length;
  return [...pages,...next.pages.slice(0,opening)];
}
