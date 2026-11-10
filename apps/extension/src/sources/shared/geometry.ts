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

/** Inline controls live in the top document even when an adapter selects a same-origin frame image.
 * Clip at frame viewports: hidden readers and off-frame preload images must not enter the reading window. */
export function inlineImageRect(image: ComicElement): DOMRect | undefined {
  let rect = renderedImageRect(image), doc = image.ownerDocument;
  if (!rect) return;
  try {
    while (doc !== document) {
      const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null;
      if (!frame?.isConnected || !frame.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return;
      const box = frame.getBoundingClientRect();
      if (!frame.offsetWidth || !frame.offsetHeight || !box.width || !box.height) return;
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const right = Math.min(frame.clientWidth, rect.right), bottom = Math.min(frame.clientHeight, rect.bottom);
      if (right <= left || bottom <= top) return;
      const sx = box.width / frame.offsetWidth, sy = box.height / frame.offsetHeight;
      rect = new DOMRect(box.left + (frame.clientLeft + left) * sx, box.top + (frame.clientTop + top) * sy,
        (right - left) * sx, (bottom - top) * sy);
      doc = frame.ownerDocument;
    }
    return rect;
  } catch {return;}
}

/** Unknown sites use CSS size heuristics to exclude thumbnails, placeholders and banners. */
export function comicImageRect(image: ComicElement): DOMRect | undefined {
  const rect = renderedImageRect(image);
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height;
  return rect && comicSize(rect.width, rect.height) && width >= 80 && height >= 80 ? rect : undefined;
}
