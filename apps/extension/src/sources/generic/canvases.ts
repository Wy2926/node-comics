import type { PageImage, SourcePageContext } from '../contracts/page';
import { canvasImage } from '../shared/canvas';
import { comicImageRect, MAX_COMIC_IMAGES } from '../shared/geometry';

const sampleInterval = 250, settleTime = 250, pollInterval = 500;
interface CanvasState {
  pixels?: string;
  url?: string;
  sampledAt: number;
  changedAt: number;
}

/** Unknown canvases have no load event or source URL. Inspect only a small visible
 * window, wait for stable pixels, and never replace the site's drawing surface. */
export function canvasTargets(context: SourcePageContext) {
  const states = new WeakMap<HTMLCanvasElement, CanvasState>();
  let probe: OffscreenCanvas | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let hasCanvas = false;
  const observers = new Set<() => void>();
  let disposed = false;
  const active = () => {
    context.signal.throwIfAborted();
    if (disposed) throw Error('SOURCE_SESSION_EXPIRED');
  };
  const visible = (canvas: HTMLCanvasElement) => {
    const view = context.document.defaultView, rect = comicImageRect(canvas);
    return !context.document.hidden && view && rect && rect.right > 0 &&
      rect.left < view.innerWidth && rect.bottom > 0 && rect.top < view.innerHeight;
  };
  function inspect(canvas: HTMLCanvasElement, force = false) {
    const previous = states.get(canvas), now = performance.now();
    if (!force && previous && now - previous.sampledAt < sampleInterval) return previous;
    try {
      probe ??= new OffscreenCanvas(32, 32);
      const drawing = probe.getContext('2d', { willReadFrequently: true })!;
      drawing.clearRect(0, 0, 32, 32);
      drawing.drawImage(canvas, 0, 0, 32, 32);
      const data = drawing.getImageData(0, 0, 32, 32).data;
      // Empty and uniform loading surfaces are not ready comic pages.
      if (!data.some((value, i) => value !== data[i % 4])) {
        states.set(canvas, { sampledAt: now, changedAt: now });
        return;
      }
      const pixels = `${canvas.width}:${canvas.height}:` + String.fromCharCode(...data);
      const state = previous?.pixels === pixels ? previous : {
        pixels, url: 'page-image:' + crypto.randomUUID(), sampledAt: now, changedAt: now,
      };
      state.sampledAt = now;
      states.set(canvas, state);
      return state;
    } catch {
      // A tainted canvas cannot be read. Discard the probe's tainted context too.
      probe = undefined;
      states.set(canvas, { sampledAt: now, changedAt: now });
    }
  }
  return {
    targets(): PageImage[] {
      active();
      const found: PageImage[] = [];
      let inspected = 0;
      const canvases = [...context.document.querySelectorAll<HTMLCanvasElement>('canvas')];
      hasCanvas = canvases.some(canvas => canvas.tagName === 'CANVAS');
      for (const canvas of canvases.slice(0, MAX_COMIC_IMAGES)) {
        if (canvas.tagName !== 'CANVAS' || !visible(canvas)) continue;
        if (++inspected > 4) break;
        const state = inspect(canvas);
        if (!state?.url || state.sampledAt - state.changedAt < settleTime) continue;
        const url = state.url;
        found.push({ element: canvas, key: url, url, read: async () => {
          const current = () => {
            active();
            if (!canvas.isConnected || !visible(canvas) || inspect(canvas, true)?.url !== url)
              throw Error('SOURCE_RESOURCE_EXPIRED');
          };
          current();
          const blob = await canvasImage(canvas, context.signal);
          current();
          return blob;
        } });
      }
      return found;
    },
    observe(changed: () => void) {
      observers.add(changed);
      timer ??= setInterval(() => {
        if (!context.document.hidden && hasCanvas) for (const notify of observers) notify();
      }, pollInterval);
      return () => {
        observers.delete(changed);
        if (!observers.size) { clearInterval(timer); timer = undefined; }
      };
    },
    dispose() { disposed = true; clearInterval(timer); timer = undefined; observers.clear(); probe = undefined; },
  };
}
