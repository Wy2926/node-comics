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

function closestToViewport(targets: readonly PageImage[], doc: Document): PageImage | undefined {
  const width = doc.defaultView?.innerWidth ?? 0;
  let selected: PageImage | undefined, best = Infinity;
  for (const target of targets) {
    const rect = target.element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) continue;
    const distance = rect.top > 0 ? rect.top : rect.bottom < 0 ? -rect.bottom : 0;
    const horizontal = rect.right <= 0 || rect.left >= width ? width : Math.abs(rect.left + rect.width / 2 - width / 2) / 100;
    const score = distance + horizontal;
    if (score < best) { best = score; selected = target; }
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

/** Only candidate metadata and layout are inspected; this never scrolls, reads pixels or requests resources. */
export function selectImmersiveTargets(targets: readonly PageImage[], options: {
  document: Document;
  generic: boolean;
  root?: Element | null;
}): {root: Element | null; targets: PageImage[]} {
  const {document: doc, generic, root} = options;
  const available = targets.slice(0, MAX_COMIC_IMAGES).filter(target => attached(target, doc));
  if (root) return root.ownerDocument === doc && root.isConnected
    ? {root, targets: available.filter(target => root.contains(target.element))}
    : {root: null, targets: []};
  if (!generic) return {root: null, targets: available};
  const candidates = available.filter(target => !target.element.closest(excludedRegion));
  const counts = new Map<Element, number>(), paths = new Map<PageImage, Element[]>();
  for (const target of candidates) {
    const path = ancestors(target.element);
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
  const viewportHeight = Math.max(1, doc.defaultView?.innerHeight ?? 1);
  for (const [owner, group] of groups) {
    const anchor = closestToViewport(group, doc)!;
    const reference = anchor.element.getBoundingClientRect();
    if (!(reference.width > 0 && reference.height > 0)) continue;
    // A column of comic pages is distinct from a row/grid of equally large cover images.
    const column = group.filter(target => {
      const rect = target.element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        Math.abs(rect.left + rect.width / 2 - reference.left - reference.width / 2) <= Math.min(rect.width, reference.width) * 0.3 &&
        Math.min(rect.width, reference.width) / Math.max(rect.width, reference.width) >= 0.5;
    });
    if (group.length >= 3 && column.length * 2 <= group.length) {
      const inColumn = new Set(column);
      if (group.some(target => {
        const rect = target.element.getBoundingClientRect();
        return !inColumn.has(target) && Math.abs(rect.top - reference.top) < Math.min(rect.height, reference.height) * 0.25;
      })) continue;
    }
    const distance = reference.top > viewportHeight ? reference.top - viewportHeight : reference.bottom < 0 ? -reference.bottom : 0;
    const score = (distance === 0 ? 4 : 0) - Math.min(4, distance / viewportHeight) +
      Math.min(3, Math.log2(column.length || 1)) + (owner.closest(contentRegion) ? 2 : 0) -
      (owner.tagName === 'BODY' || owner.tagName === 'HTML' ? 4 : 0);
    if (score > best) { best = score; chosen = {root: owner, targets: column}; }
  }
  return chosen;
}

export function immersiveAnchor(pages: readonly ImmersivePage[], doc: Document): ImmersiveSnapshot['anchor'] {
  const target = closestToViewport(pages, doc) as ImmersivePage | undefined;
  if (!target) return null;
  const rect = target.element.getBoundingClientRect();
  return {id: target.id, offset: rect.height > 0 ? clamp(-rect.top / rect.height) : 0};
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
      const selected = selectImmersiveTargets(latestTargets, {document: doc, generic, root});
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
        direction: page.session.direction, partial: true, root: selected.root, pages, anchor: immersiveAnchor(pages, doc), limited};
    },
  };
}
