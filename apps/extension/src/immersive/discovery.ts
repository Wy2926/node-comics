import {MAX_COMIC_IMAGES, sourceDocument, type PageImage} from '../sources/page';
import {sourceFor} from '../sources';
import {randomId} from '../random-id';

export interface ImmersivePage extends PageImage {
  id: string;
  order: number;
  width: number;
  height: number;
}
export interface ImmersiveSnapshot {
  navigationId: string;
  url: string;
  title: string;
  sourceId: string;
  direction: 'ltr' | 'rtl';
  /** Rendered targets never prove that a chapter or even the current document is complete. */
  partial: true;
  root: Element | null;
  pages: ImmersivePage[];
  anchor: {id: string; offset: number} | null;
  limited: boolean;
}

const excludedRegion = 'nav,aside,header,footer,[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"]';
const contentRegion = 'main,article,[role="main"]';
const ancestorLimit = 16;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ancestors = (element: Element) => {
  const result: Element[] = [];
  for (let parent = element.parentElement; parent && result.length < ancestorLimit; parent = parent.parentElement) {
    result.push(parent);
    if (parent.tagName === 'BODY') break;
  }
  return result;
};
const attached = (target: PageImage, doc: Document) => target.element.isConnected && target.element.ownerDocument === doc;

/** One scan owns these caches; each image/ancestor geometry and ancestor style is read at most once. */
function scanLayout(doc: Document) {
  type Bounds = {left: number; right: number; top: number; bottom: number};
  const rects = new Map<Element, DOMRect>(), paths = new Map<Element, Element[]>(), clips = new Map<Element, Bounds | null>();
  const width = doc.defaultView?.innerWidth ?? 0, height = doc.defaultView?.innerHeight ?? 0;
  const rect = (element: Element) => {
    let value = rects.get(element);
    if (!value) {value = element.getBoundingClientRect(); rects.set(element, value);}
    return value;
  };
  const path = (element: Element) => {
    let value = paths.get(element);
    if (!value) {value = ancestors(element); paths.set(element, value);}
    return value;
  };
  const viewport = (element: Element) => {
    const visible: Bounds = {left: 0, right: width, top: 0, bottom: height};
    for (const parent of path(element)) {
      // Root overflow propagates to the window, including the reader's temporary page lock.
      if (parent.tagName === 'BODY' || parent.tagName === 'HTML') break;
      if (!clips.has(parent)) {
        const style = getComputedStyle(parent), clipsX = /^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowX),
          clipsY = /^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowY);
        const bounds = clipsX || clipsY ? rect(parent) : null;
        clips.set(parent, bounds ? {
          left: clipsX ? bounds.left + parent.clientLeft : -Infinity,
          right: clipsX ? bounds.left + parent.clientLeft + parent.clientWidth : Infinity,
          top: clipsY ? bounds.top + parent.clientTop : -Infinity,
          bottom: clipsY ? bounds.top + parent.clientTop + parent.clientHeight : Infinity,
        } : null);
      }
      const clip = clips.get(parent);
      if (clip) {
        visible.left = Math.max(visible.left, clip.left); visible.right = Math.min(visible.right, clip.right);
        visible.top = Math.max(visible.top, clip.top); visible.bottom = Math.min(visible.bottom, clip.bottom);
      }
    }
    return visible;
  };
  return {rect, path, viewport, height};
}
type ScanLayout = ReturnType<typeof scanLayout>;

/** Exit restoration uses the same clipped reading edge as entry discovery. */
export function immersiveViewportTop(element: Element, doc: Document): number {
  return scanLayout(doc).viewport(element).top;
}

function closestToViewport(targets: readonly PageImage[], layout: ScanLayout): PageImage | undefined {
  let selected: PageImage | undefined, best = Infinity, selectedVisible = false;
  for (const target of targets) {
    const rect = layout.rect(target.element), viewport = layout.viewport(target.element);
    if (!(rect.width > 0 && rect.height > 0)) continue;
    if (viewport.right <= viewport.left || viewport.bottom <= viewport.top) continue;
    const visible = rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right;
    const distance = rect.top > viewport.top ? rect.top - viewport.top : rect.bottom < viewport.top ? viewport.top - rect.bottom : 0;
    const horizontal = rect.right <= viewport.left || rect.left >= viewport.right ? viewport.right - viewport.left
      : Math.abs(rect.left + rect.width / 2 - (viewport.left + viewport.right) / 2) / 100;
    const score = distance + horizontal;
    if (visible && !selectedVisible || visible === selectedVisible && score < best) {best = score; selected = target; selectedVisible = visible;}
  }
  return selected ?? targets[0];
}

/** A user-chosen image stays a single-image scope when no bounded content ancestor exists. */
export function pickImmersiveRoot(element: Element, targets: readonly PageImage[]): Element | null {
  if (element.tagName === 'BODY' || element.tagName === 'HTML') return null;
  const inside = targets.filter(target => element.contains(target.element));
  if (inside.length > 1) return element;
  const target = inside[0] ?? targets.find(item => item.element.contains(element));
  if (!target) return null;
  for (const parent of ancestors(target.element)) {
    if (parent.tagName === 'BODY' || parent.tagName === 'HTML') break;
    if (targets.filter(item => parent.contains(item.element)).length > 1) return parent;
    if (parent.matches(contentRegion)) break;
  }
  return inside.length ? element : target.element;
}

type SelectionOptions = {
  document: Document;
  generic: boolean;
  root?: Element | null;
};
/** Only candidate metadata and layout are inspected; this never scrolls, reads pixels or requests resources. */
export function selectImmersiveTargets(targets: readonly PageImage[], options: SelectionOptions) {
  return selectTargets(targets, options, scanLayout(options.document));
}
function selectTargets(targets: readonly PageImage[], options: SelectionOptions, layout: ScanLayout): {root: Element | null; targets: PageImage[]} {
  const {document: doc, generic, root} = options;
  const available = targets.slice(0, MAX_COMIC_IMAGES).filter(target => attached(target, doc));
  if (root) return root.ownerDocument === doc && root.isConnected
    ? {root, targets: available.filter(target => root.contains(target.element))}
    : {root: null, targets: []};
  if (!generic) return {root: null, targets: available};
  const candidates = available.filter(target => !target.element.closest(excludedRegion));
  const counts = new Map<Element, number>(), paths = new Map<PageImage, Element[]>();
  for (const target of candidates) {
    const path = layout.path(target.element);
    paths.set(target, path);
    for (const parent of path) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  // The nearest shared container partitions a reader from neighbouring recommendation grids.
  const groups = new Map<Element, PageImage[]>();
  for (const target of candidates) {
    const owner = paths.get(target)!.find(parent => counts.get(parent)! > 1) ?? target.element;
    const group = groups.get(owner) ?? [];
    group.push(target);
    groups.set(owner, group);
  }
  let chosen: {root: Element | null; targets: PageImage[]} = {root: null, targets: []}, best = -Infinity;
  const viewportHeight = Math.max(1, layout.height);
  for (const [owner, group] of groups) {
    const anchor = closestToViewport(group, layout)!;
    const reference = layout.rect(anchor.element), viewport = layout.viewport(anchor.element);
    if (!(reference.width > 0 && reference.height > 0)) continue;
    if (viewport.right <= viewport.left || viewport.bottom <= viewport.top) continue;
    // A column of comic pages is distinct from a row/grid of equally large cover images.
    const column = group.filter(target => {
      const rect = layout.rect(target.element);
      return rect.width > 0 && rect.height > 0 &&
        Math.abs(rect.left + rect.width / 2 - reference.left - reference.width / 2) <= Math.min(rect.width, reference.width) * 0.3 &&
        Math.min(rect.width, reference.width) / Math.max(rect.width, reference.width) >= 0.5;
    });
    if (group.length >= 3 && column.length * 2 <= group.length) {
      const inColumn = new Set(column);
      if (group.some(target => {
        const rect = layout.rect(target.element);
        return !inColumn.has(target) && Math.abs(rect.top - reference.top) < Math.min(rect.height, reference.height) * 0.25;
      })) continue;
    }
    const distance = reference.top > viewport.bottom ? reference.top - viewport.bottom : reference.bottom < viewport.top ? viewport.top - reference.bottom : 0;
    const score = (distance === 0 ? 4 : 0) - Math.min(4, distance / viewportHeight) +
      Math.min(3, Math.log2(column.length || 1)) + (owner.closest(contentRegion) ? 2 : 0) -
      (owner.tagName === 'BODY' || owner.tagName === 'HTML' ? 4 : 0);
    if (score > best) { best = score; chosen = {root: owner, targets: column}; }
  }
  return chosen;
}

export function immersiveAnchor(pages: readonly ImmersivePage[], doc: Document): ImmersiveSnapshot['anchor'] {
  return anchorFor(pages, scanLayout(doc));
}
function anchorFor(pages: readonly ImmersivePage[], layout: ScanLayout): ImmersiveSnapshot['anchor'] {
  const target = closestToViewport(pages, layout) as ImmersivePage | undefined;
  if (!target) return null;
  const rect = layout.rect(target.element), viewport = layout.viewport(target.element);
  return {id: target.id, offset: rect.height > 0 ? clamp((viewport.top - rect.top) / rect.height) : 0};
}

/** Shares the source document's lifecycle and observation; the caller owns its subscription. */
export function createImmersiveDiscovery(doc: Document) {
  const lifecycle = sourceDocument(doc);
  let navigationId = '', generation = 0;
  let previous: Array<{target: PageImage; id: string}> = [];
  let latestTargets: PageImage[] = [];
  function reset() { navigationId = ''; generation++; previous = []; latestTargets = []; }
  return {
    reset,
    rootFor(element: Element) {
      if (lifecycle.current().navigationId !== navigationId) return null;
      return pickImmersiveRoot(element, latestTargets);
    },
    scan(root?: Element | null): ImmersiveSnapshot {
      const page = lifecycle.current();
      if (page.navigationId !== navigationId) { reset(); navigationId = page.navigationId; }
      const {definition} = sourceFor(page.url);
      const generic = definition.id === 'generic' || definition.inlineRecognition === 'generic';
      const found = !generic && page.location.kind !== 'reader' ? [] : page.session.inlineTargets();
      const limited = found.length >= MAX_COMIC_IMAGES;
      latestTargets = [...new Map(found.slice(0, MAX_COMIC_IMAGES).filter(target => attached(target, doc))
        .map(target => [target.element, target])).values()];
      const layout = scanLayout(doc), selected = selectTargets(latestTargets, {document: doc, generic, root}, layout);
      const byElement = new Map(previous.map(slot => [slot.target.element, slot]));
      const retained = new Map(latestTargets.flatMap(target => {
        const slot = byElement.get(target.element);
        return slot?.target.key === target.key && slot.target.url === target.url ? [[target.element, slot] as const] : [];
      }));
      const used = new Set([...retained.values()].map(slot => slot.id));
      const reusable = new Map<string, typeof previous>();
      const identity = (target: PageImage) => JSON.stringify([target.key, target.url]);
      for (const slot of [...previous].reverse()) {
        if (used.has(slot.id)) continue;
        const key = identity(slot.target), group = reusable.get(key) ?? [];
        group.push(slot); reusable.set(key, group);
      }
      previous = latestTargets.map(target => ({target: {...target},
        id: (retained.get(target.element) ?? reusable.get(identity(target))?.pop())?.id ?? randomId(),
      }));
      const ids = new Map(previous.map(slot => [slot.target.element, slot.id]));
      const currentGeneration = generation;
      const pages: ImmersivePage[] = selected.targets.map((target, order) => {
        const {element} = target;
        const read = target.read;
        return {...target, id: ids.get(element)!, order,
          width: 'naturalWidth' in element ? element.naturalWidth : element.width,
          height: 'naturalHeight' in element ? element.naturalHeight : element.height,
          ...(read ? {read: async (requestSignal?: AbortSignal) => {
            const signal = AbortSignal.any([page.controller.signal, ...(requestSignal ? [requestSignal] : [])]);
            const active = () => {
              signal.throwIfAborted();
              if (generation !== currentGeneration || lifecycle.current().navigationId !== page.navigationId || !attached(target, doc))
                throw Error('SOURCE_RESOURCE_EXPIRED');
            };
            active();
            const blob = await read(signal);
            active();
            return blob;
          }} : {}),
        };
      });
      return {navigationId: page.navigationId, url: page.url, title: doc.title.slice(0, 160), sourceId: page.location.sourceId,
        direction: page.session.direction, partial: true, root: selected.root, pages, anchor: anchorFor(pages, layout), limited};
    },
  };
}
