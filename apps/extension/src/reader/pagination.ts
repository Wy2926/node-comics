import type {Page} from '../types';

type PageSize = Pick<Page, 'width' | 'height'>;

export interface PageSpread {
  start: number;
  /** Exclusive page index. */
  end: number;
}

/** Missing source dimensions remain a square placeholder until the image is known. */
function aspectRatio(page: PageSize): number {
  const ratio = page.width / page.height;
  return Number.isFinite(page.width) && page.width > 0 && Number.isFinite(page.height) && page.height > 0
    && Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** The cover and landscape images stand alone; portrait pairs never cross a chapter. */
export function pageSpreads(pages: readonly PageSize[]): PageSpread[] {
  const spreads: PageSpread[] = [];
  for (let start = 0; start < pages.length;) {
    const spread = spreadStartingAt(pages,start)!;
    spreads.push(spread);
    start = spread.end;
  }
  return spreads;
}

/** Start is a known group boundary, so lookahead need not rebuild every spread in the chapter. */
export function spreadStartingAt(pages:readonly PageSize[],start:number):PageSpread|undefined{
  if(!Number.isInteger(start)||start<0||start>=pages.length)return;
  const paired=start>0&&aspectRatio(pages[start])<=1&&start+1<pages.length&&aspectRatio(pages[start+1])<=1;
  return {start,end:start+(paired?2:1)};
}

export function spreadAt(spreads: readonly PageSpread[], index: number): PageSpread | undefined {
  if (!Number.isInteger(index) || index < 0) return;
  let low = 0, high = spreads.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), spread = spreads[middle];
    if (index < spread.start) high = middle - 1;
    else if (index >= spread.end) low = middle + 1;
    else return spread;
  }
}

/** Fit the whole spread at one height; comparison doubles pane width, never the canvas. */
export function spreadFrames(pages: readonly PageSize[], viewport: {width: number; height: number}, compare = false): {width: number; height: number}[] {
  if (!pages.length) return [];
  const ratios = pages.map(page => aspectRatio(page) * (compare ? 2 : 1));
  const availableWidth = Number.isFinite(viewport.width) ? Math.max(0, viewport.width - 24) : 0;
  const availableHeight = Number.isFinite(viewport.height) ? Math.max(0, viewport.height - 24) : 0;
  const height = Math.min(availableHeight, availableWidth / ratios.reduce((sum, ratio) => sum + ratio, 0));
  return ratios.map(ratio => ({width: height * ratio, height}));
}
