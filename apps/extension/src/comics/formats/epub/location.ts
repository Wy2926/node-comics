import type Rendition from "epubjs/types/rendition";
import type { Location } from "epubjs/types/rendition";
import type { EpubLocation } from "../contracts";
import type { EpubSession } from "./index";

/** The pinned EPUB.js manager exposes geometry not covered by its published TypeScript types. */
interface LayoutManager {
  container: HTMLElement;
  settings: { axis: string; direction: string; rtlScrollType: string };
  isPaginated: boolean;
  layout: { delta: number; height: number };
  scrollTo(left: number, top: number, silent: boolean): void;
}

interface LayoutRendition {
  location?: Location;
  currentLocation(): Location | undefined;
  resize(width: number, height: number, cfi?: string): void;
  getContents(): { document: Document; resizeCheck(): void }[];
}

function layoutView(rendition: Rendition): LayoutRendition {
  return rendition as unknown as LayoutRendition;
}

export function currentEpubLocation(rendition: Rendition) {
  return layoutView(rendition).currentLocation();
}

function managerFor(rendition: Rendition): LayoutManager {
  return (rendition as Rendition & { manager: LayoutManager }).manager;
}

/** EPUB.js 0.3.93 accepts a CFI in resize; its declarations omit that parameter. */
export function resizeEpub(
  rendition: Rendition,
  width: number,
  height: number,
) {
  const view = layoutView(rendition);
  // reportLocation updates its cache on RAF, after chapter display has already resolved.
  const location = view.currentLocation();
  if (location?.start) view.location = location;
  view.resize(width, height, location?.start.cfi);
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Font readiness and the library's ResizeObserver/RAF pipeline precede final CFI placement. */
export async function settleEpubLayout(
  rendition: Rendition,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const lifetime = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(signal ? [signal] : []),
  ]);
  const contents = layoutView(rendition).getContents();
  await withSignal(
    Promise.all(contents.map((content) => content.document.fonts?.ready)),
    lifetime,
  );
  for (let pass = 0; pass < 2; pass++) {
    let frame = 0;
    try {
      await withSignal(
        new Promise<void>((resolve) => {
          frame = requestAnimationFrame(() => resolve());
        }),
        lifetime,
      );
    } finally {
      cancelAnimationFrame(frame);
    }
    lifetime.throwIfAborted();
    for (const content of contents) content.resizeCheck();
  }
}

/** Initial display resolves before EPUB.js finishes its theme content hooks. */
export async function initializeEpubLocation(
  session: EpubSession,
  rendition: Rendition,
  location: EpubLocation | undefined,
  configureAppearance: () => void,
) {
  let rendered!: () => void;
  const ready = new Promise<void>((resolve) => {
    rendered = resolve;
  });
  rendition.on("rendered", rendered);
  try {
    configureAppearance();
    await withSignal(
      Promise.all([restoreEpubLocation(session, rendition, location), ready]),
      session.signal,
    );
  } finally {
    rendition.off("rendered", rendered);
  }
  await settleEpubLayout(rendition, session.signal);
  await restoreEpubLocation(session, rendition, location);
}

/** Resource-relative progress, independent of the number of sections in the book. */
export function epubProgression(rendition: Rendition): number {
  const manager = managerFor(rendition);
  const { container, settings } = manager;
  const vertical = settings.axis !== "horizontal";
  const extent = vertical ? container.scrollHeight : container.scrollWidth;
  let offset = vertical ? container.scrollTop : container.scrollLeft;
  if (!vertical && settings.direction === "rtl") {
    offset =
      settings.rtlScrollType === "default"
        ? container.scrollWidth - container.clientWidth - offset
        : Math.abs(offset);
  }
  return Math.max(0, Math.min(1, offset / Math.max(1, extent)));
}

function restoreProgression(rendition: Rendition, progression: number) {
  const manager = managerFor(rendition);
  const { container, settings } = manager;
  const vertical = settings.axis !== "horizontal";
  const extent = vertical ? container.scrollHeight : container.scrollWidth;
  const visible = vertical ? container.clientHeight : container.clientWidth;
  let offset = Math.max(0, Math.min(1, progression)) * extent;
  if (manager.isPaginated) {
    const step = vertical ? manager.layout.height : manager.layout.delta;
    if (step > 0) offset = Math.floor(offset / step) * step;
  }
  offset = Math.min(Math.max(0, extent - visible), offset);
  if (!vertical && settings.direction === "rtl") {
    offset =
      settings.rtlScrollType === "default"
        ? extent - visible - offset
        : -offset;
  }
  manager.scrollTo(vertical ? 0 : offset, vertical ? offset : 0, true);
  void rendition.reportLocation();
}

/** Validate CFI before queueing display: EPUB.js leaves a failed display task pending. */
export async function restoreEpubLocation(
  session: EpubSession,
  rendition: Rendition,
  location?: EpubLocation,
) {
  session.signal?.throwIfAborted();
  if (location?.cfi) {
    try {
      if (await session.book.getRange(location.cfi)) {
        session.signal?.throwIfAborted();
        await rendition.display(location.cfi);
        return;
      }
    } catch {
      session.signal?.throwIfAborted();
      // A stale CFI may still have a usable source href and resource-relative progression.
    }
  }
  const href = location?.href;
  const section = href
    ? session.book.spine.get(href) || session.book.spine.get(`/${href}`)
    : undefined;
  const target = section
    ? section.href +
      (href?.includes("#") ? `#${href.split("#").slice(1).join("#")}` : "")
    : undefined;
  await rendition.display(target);
  session.signal?.throwIfAborted();
  if (section && Number.isFinite(location?.progression))
    restoreProgression(rendition, location!.progression!);
}
