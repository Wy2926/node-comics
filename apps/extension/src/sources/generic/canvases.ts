import type {SourcePageContext} from '../contracts/page';
import {comicImageRect, MAX_COMIC_IMAGES} from '../shared/geometry';
import {stableCanvasTargets} from '../shared/stable-canvases';

/** Unknown surfaces have no reliable page order: keep the visible-only policy. */
export function canvasTargets(context: SourcePageContext) {
  return stableCanvasTargets(context, () => {
    const view = context.document.defaultView;
    if (!view) return [];
    const found: HTMLCanvasElement[] = [];
    for (const canvas of [...context.document.querySelectorAll<HTMLCanvasElement>('canvas')].slice(0, MAX_COMIC_IMAGES)) {
      if (canvas.tagName !== 'CANVAS') continue;
      const rect = comicImageRect(canvas);
      if (rect && rect.right > 0 && rect.left < view.innerWidth && rect.bottom > 0 && rect.top < view.innerHeight) found.push(canvas);
      if (found.length === 4) break;
    }
    return found;
  });
}
