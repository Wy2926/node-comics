import type {Page,Settings} from '../types';

export function pageFrame(page: Pick<Page,'width'|'height'>, viewport: {width:number;height:number}, fit: Settings['fit'], zoom=100, compare=false) {
  const ratio = Math.max(1,page.width) / Math.max(1,page.height) * (compare ? 2 : 1);
  const availableWidth = Math.max(1,viewport.width - 24);
  const availableHeight = Math.max(1,viewport.height - 40);
  const width = (fit === 'window' ? Math.min(availableWidth,availableHeight * ratio) : availableWidth) * zoom / 100;
  return {width, height:width / ratio};
}

export function thumbnailRows(pages: Page[], width: number, manage: boolean) {
  let top = 0;
  return pages.map(page => {
    const pictureHeight = Math.max(1,width - 2) * Math.max(1,page.height) / Math.max(1,page.width);
    const row = {top, pictureHeight, height:pictureHeight + 82 + (manage ? 40 : 0)};
    top += row.height;
    return row;
  });
}
