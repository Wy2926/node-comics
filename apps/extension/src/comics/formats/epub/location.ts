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
  views?: {all(): {section: {index: number}; element: HTMLElement}[]};
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

/** Move by one viewport in the continuous document, not by a whole XHTML resource. */
export async function turnEpub(rendition: Rendition, direction: -1 | 1) {
  await (direction === 1 ? rendition.next() : rendition.prev());
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
  view.resize(width, height, location?.start?.cfi);
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
  // Fixed pages never reflow with fonts/themes; do not destroy and load the same
  // fixed frame a second time just to restore its unchanged element CFI.
  if (rendition.settings?.layout !== 'pre-paginated') await restoreEpubLocation(session, rendition, location);
}

function sectionGeometry(rendition: Rendition, index?: number) {
  const manager = managerFor(rendition);
  const { container, settings } = manager;
  const vertical = settings.axis !== "horizontal";
  let offset = vertical ? container.scrollTop : container.scrollLeft;
  if (!vertical && settings.direction === "rtl") {
    offset =
      settings.rtlScrollType === "default"
        ? container.scrollWidth - container.clientWidth - offset
        : Math.abs(offset);
  }
  const frame = manager.views?.all().find(view => view.section.index === index);
  if (frame) {
    const bounds = frame.element.getBoundingClientRect(), viewport = container.getBoundingClientRect();
    const origin = offset + (vertical ? bounds.top - viewport.top : settings.direction === 'rtl' ? viewport.right - bounds.right : bounds.left - viewport.left);
    return {origin, offset, extent: vertical ? bounds.height : bounds.width};
  }
  return {origin: 0, offset, extent: vertical ? container.scrollHeight : container.scrollWidth};
}

/** Progress belongs to one resource, never to the changing virtual-window scroll height. */
export function epubProgression(rendition: Rendition, location?: Location): number {
  const index = location?.start?.index ?? (managerFor(rendition).views ? currentEpubLocation(rendition)?.start?.index : undefined);
  const {origin, offset, extent} = sectionGeometry(rendition, index);
  return Math.max(0, Math.min(1, (offset - origin) / Math.max(1, extent)));
}

function restoreProgression(rendition: Rendition, progression: number, index: number) {
  const manager = managerFor(rendition);
  const { container, settings } = manager;
  const vertical = settings.axis !== "horizontal";
  const {extent, origin} = sectionGeometry(rendition, index);
  const scrollExtent = vertical ? container.scrollHeight : container.scrollWidth;
  const visible = vertical ? container.clientHeight : container.clientWidth;
  let offset = Math.max(0, Math.min(1, progression)) * extent;
  if (manager.isPaginated) {
    const step = vertical ? manager.layout.height : manager.layout.delta;
    if (step > 0) offset = Math.floor(offset / step) * step;
  }
  offset = Math.min(Math.max(0, scrollExtent - visible), origin + offset);
  if (!vertical && settings.direction === "rtl") {
    offset =
      settings.rtlScrollType === "default"
        ? scrollExtent - visible - offset
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
        // A fixed page's element CFI identifies the page, not the viewport's offset
        // inside it. Preserve that offset independently (image-only pages have no text).
        if (rendition.settings?.layout === 'pre-paginated' && Number.isFinite(location.progression)) {
          const index = session.book.spine.get(location.cfi)?.index;
          if (index !== undefined) restoreProgression(rendition, location.progression!, index);
        }
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
    restoreProgression(rendition, location!.progression!, section.index);
}
