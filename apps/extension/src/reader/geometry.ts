import type {Page,Settings} from '../types';

export function pageFrame(page: Pick<Page,'width'|'height'>, viewport: {width:number;height:number}, fit: Settings['fit'], zoom=100, compare=false) {
  const ratio = Math.max(1,page.width) / Math.max(1,page.height) * (compare ? 2 : 1);
  // On a narrow canvas, comparison is a horizontally pannable pair of readable
  // pages, not two half-phone thumbnails. Existing scroll/anchor handling applies.
  const availableWidth = Math.max(1,viewport.width) * (compare && viewport.width <= 700 ? 2 : 1);
  const availableHeight = Math.max(1,viewport.height);
  const width = (fit === 'window' ? Math.min(availableWidth,availableHeight * ratio) : availableWidth) * zoom / 100;
  return {width, height:width / ratio};
}

export const thumbnailRowHeight = 112;
/** One spare row on either side; page dimensions do not affect directory layout. */
export function thumbnailWindow(count: number, scrollTop: number, height: number) {
  if (!count || height <= 0) return {start: 0, end: 0};
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, count * thumbnailRowHeight - height)));
  return {
    start: Math.max(0, Math.floor(top / thumbnailRowHeight) - 1),
    end: Math.min(count, Math.ceil((top + height) / thumbnailRowHeight) + 1),
  };
}
