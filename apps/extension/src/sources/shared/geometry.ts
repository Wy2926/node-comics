import type { ComicElement } from '../contracts/page';
import { comicSize } from './dimensions';

export const MAX_COMIC_IMAGES = 1500;

/** Site adapters select comic content themselves; only loading and visibility are shared. */
export function renderedImageRect(image: ComicElement): DOMRect | undefined {
  const rect = image.getBoundingClientRect();
  if (
    !(rect.width > 0 && rect.height > 0) ||
    ('naturalWidth' in image
      ? !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0
      : image.width <= 0 || image.height <= 0)
  )
    return;
  const css = getComputedStyle(image);
  if (
    css.visibility !== 'visible' ||
    Number(css.opacity) === 0 ||
    !image.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  )
    return;
  return rect;
}

/** Unknown sites use CSS size heuristics to exclude thumbnails, placeholders and banners. */
export function comicImageRect(image: ComicElement): DOMRect | undefined {
  const rect = renderedImageRect(image);
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height;
  return rect && comicSize(rect.width, rect.height) && width >= 80 && height >= 80 ? rect : undefined;
}
