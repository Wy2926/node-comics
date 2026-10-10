import type { PageImage, SourcePageContext } from '../contracts/page';
import { canvasImage } from './canvas';

const sampleInterval = 250, settleTime = 250, pollInterval = 500;
interface CanvasState {
  pixels?: string;
  url?: string;
  sampledAt: number;
  changedAt: number;
}

/** Sample only the caller's bounded window. Blank, tainted and changing surfaces
 * are never readable; every read revalidates membership and pixels. */
export function stableCanvasTargets(context: SourcePageContext, candidates: () => HTMLCanvasElement[]) {
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
      if (context.document.hidden) return found;
      const canvases = candidates();
      hasCanvas = canvases.length > 0;
      for (const canvas of canvases) {
        const state = inspect(canvas);
        if (!state?.url || state.sampledAt - state.changedAt < settleTime) continue;
        const url = state.url;
        found.push({ element: canvas, key: url, url, read: async (requestSignal?:AbortSignal) => {
          const signal=AbortSignal.any([context.signal,...(requestSignal?[requestSignal]:[])]);
          const current = () => {
            signal.throwIfAborted();
            active();
            if (!canvas.isConnected || context.document.hidden || !candidates().includes(canvas) || inspect(canvas, true)?.url !== url)
              throw Error('SOURCE_RESOURCE_EXPIRED');
          };
          current();
          const blob = await canvasImage(canvas, signal);
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
