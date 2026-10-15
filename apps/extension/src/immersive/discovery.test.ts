import {afterEach, describe, expect, it, vi} from 'vitest';
import type {PageImage} from '../sources/contracts/page';
import {createImmersiveDiscovery, pickImmersiveRoot, selectImmersiveTargets} from './discovery';

vi.mock('../sources/page', () => ({
  MAX_COMIC_IMAGES: 1500,
  sourceDocument: (doc: {lifecycle: unknown}) => doc.lifecycle,
}));
vi.mock('../sources', () => ({sourceFor: (url: string) => {
  const id = new URL(url).hostname.split('.')[0];
  return {definition: {id, ...(id === 'shared-generic' ? {inlineRecognition: 'generic'} : {})}};
}}));
afterEach(() => vi.unstubAllGlobals());

class FixtureElement {
  parentElement: FixtureElement | null = null;
  children: FixtureElement[] = [];
  isConnected = true;
  naturalWidth = 1000;
  naturalHeight = 1400;
  width = 1000;
  height = 1400;
  role = '';
  constructor(readonly ownerDocument: Document, readonly tagName: string, public top = 0, public left = 200, public rectWidth = 800, public rectHeight = 1100) {}
  append(child: FixtureElement) { child.parentElement = this; this.children.push(child); return child; }
  contains(element: FixtureElement): boolean {
    for (let current: FixtureElement | null = element; current; current = current.parentElement) if (current === this) return true;
    return false;
  }
  matches(selector: string) {
    return selector.split(',').some(part => part.startsWith('[role=')
      ? part === `[role="${this.role}"]` : part.toUpperCase() === this.tagName);
  }
  closest(selector: string): FixtureElement | null {
    for (let current: FixtureElement | null = this; current; current = current.parentElement) if (current.matches(selector)) return current;
    return null;
  }
  getBoundingClientRect() {
    return {top: this.top, bottom: this.top + this.rectHeight, left: this.left, right: this.left + this.rectWidth,
      width: this.rectWidth, height: this.rectHeight} as DOMRect;
  }
}
const element = (value: FixtureElement) => value as unknown as Element;
function fixture(sourceId = 'generic', kind: 'reader' | 'catalog' | 'other' = 'reader') {
  let targets: PageImage[] = [];
  const page = {navigationId: 'navigation-one', url: `https://${sourceId}.example/chapter`, controller: new AbortController(),
    location: {sourceId, kind}, session: {direction: 'rtl' as const, inlineTargets: vi.fn(() => targets)}};
  let current = page;
  const doc = {title: 'Comic chapter', defaultView: {innerWidth: 1200, innerHeight: 800},
    lifecycle: {current: () => current}} as unknown as Document;
  const body = new FixtureElement(doc, 'BODY');
  const add = (parent: FixtureElement, tag: string, top = 0, left = 200, width = 800, height = 1100) =>
    parent.append(new FixtureElement(doc, tag.toUpperCase(), top, left, width, height));
  const image = (parent: FixtureElement, name: string, top = 0, left = 200, width = 800, height = 1100, read?: PageImage['read']) => {
    const img = add(parent, 'img', top, left, width, height);
    const url = `https://images.example/${name}`;
    const target: PageImage = {element: img as unknown as HTMLImageElement, key: url, url, ...(read ? {read} : {})};
    targets.push(target);
    return {img, target};
  };
  return {doc, body, add, image, page, targets: () => targets, setTargets: (value: PageImage[]) => { targets = value; },
    navigate: () => { current = {...page, navigationId: 'navigation-two', controller: new AbortController()}; }};
}

describe('current-tab immersive region selection', () => {
  it('selects a comic column rather than header, sidebar and large recommendation cards', () => {
    const f = fixture();
    f.image(f.add(f.body, 'header'), 'header', 0);
    f.image(f.add(f.body, 'aside'), 'sidebar', 0, 900, 300, 500);
    const main = f.add(f.body, 'main'), reader = f.add(main, 'section');
    const comic = [f.image(reader, 'page1', -1300), f.image(reader, 'page2', -200), f.image(reader, 'page3', 900)];
    const related = f.add(main, 'section');
    for (let i = 0; i < 3; i++) f.image(related, 'cover' + i, 2200, i * 350, 300, 500);
    const snapshot = createImmersiveDiscovery(f.doc).scan();
    expect(snapshot.pages.map(page => page.element)).toEqual(comic.map(page => page.target.element));
    expect(snapshot.root).toBe(reader);
    expect(snapshot.partial).toBe(true);
    expect(snapshot.anchor).toEqual({id: snapshot.pages[1].id, offset: 200 / 1100});
    expect(snapshot).not.toHaveProperty('knownTotal');
  });

  it('uses the current viewport to choose between separated content regions', () => {
    const f = fixture(), main = f.add(f.body, 'main'), previous = f.add(main, 'section'), current = f.add(main, 'section');
    f.image(previous, 'previous1', -4000); f.image(previous, 'previous2', -2800);
    const expected = [f.image(current, 'current1', -100), f.image(current, 'current2', 1000)];
    const result = selectImmersiveTargets(f.targets(), {document: f.doc, generic: true});
    expect(result.targets).toEqual(expected.map(item => item.target));
  });

  it('does not turn a cover grid into a full-page comic list', () => {
    const f = fixture(), grid = f.add(f.body, 'main');
    for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) f.image(grid, `${row}-${col}`, row * 500, col * 350, 300, 450);
    const result = selectImmersiveTargets(f.targets(), {document: f.doc, generic: true});
    expect(result.targets).toEqual([]);
    expect(selectImmersiveTargets(f.targets(), {document: f.doc, generic: true, root: element(grid)}).targets).toHaveLength(6);
  });

  it('retains dedicated adapters selection without generic geometry or semantic heuristics', () => {
    const f = fixture('dedicated');
    const expected = [f.image(f.add(f.body, 'aside'), 'spread-left', 0, 0, 300, 500),
      f.image(f.body, 'spread-right', 0, 400, 900, 600)];
    const result = createImmersiveDiscovery(f.doc).scan();
    expect(result.pages.map(page => page.element)).toEqual(expected.map(item => item.target.element));
    expect(result.partial).toBe(true);
  });

  it('applies generic region selection to registered inlineRecognition generic sources', () => {
    const f = fixture('shared-generic', 'catalog'), main = f.add(f.body, 'main');
    const page = f.image(main, 'main');
    f.image(f.add(f.body, 'aside'), 'sidebar');
    expect(createImmersiveDiscovery(f.doc).scan().pages.map(item => item.element)).toEqual([page.target.element]);
  });

  it('does not activate dedicated adapter candidates outside their reader location', () => {
    const f = fixture('dedicated', 'catalog');
    f.image(f.body, 'cover');
    const result = createImmersiveDiscovery(f.doc).scan();
    expect(result.pages).toEqual([]);
    expect(result.partial).toBe(true);
    expect(f.page.session.inlineTargets).not.toHaveBeenCalled();
  });

  it('honors explicit single-image and region selection without broadening their scope', () => {
    const f = fixture(), main = f.add(f.body, 'main'), reader = f.add(main, 'section');
    const first = f.image(reader, 'first'), second = f.image(reader, 'second', 1200);
    f.image(f.add(f.body, 'aside'), 'related');
    const discovery = createImmersiveDiscovery(f.doc);
    expect(discovery.scan(element(first.img)).pages.map(page => page.element)).toEqual([first.target.element]);
    expect(discovery.scan(element(reader)).pages.map(page => page.element)).toEqual([first.target.element, second.target.element]);
    expect(discovery.rootFor(element(first.img))).toBe(reader);
    expect(f.page.session.inlineTargets).toHaveBeenCalledTimes(2);
  });

  it('does not expand an isolated clicked image to the body', () => {
    const f = fixture(), first = f.image(f.body, 'first'), second = f.image(f.body, 'second', 1200);
    expect(pickImmersiveRoot(element(first.img), [first.target, second.target])).toBe(first.img);
    expect(pickImmersiveRoot(element(f.body), f.targets())).toBeNull();
  });

  it('rejects foreign and detached selections and detached targets', () => {
    const f = fixture(), page = f.image(f.body, 'page'), discovery = createImmersiveDiscovery(f.doc);
    const other = fixture(), foreign = other.image(other.body, 'foreign');
    expect(discovery.scan(element(foreign.img)).pages).toEqual([]);
    page.img.isConnected = false;
    expect(discovery.scan(element(page.img)).pages).toEqual([]);
    expect(discovery.scan().pages).toEqual([]);
  });
});

describe('immersive page identities and original-resource lifetime', () => {
  it('keeps duplicate URLs separate and reserves surviving elements before remount reconciliation', () => {
    const f = fixture('dedicated'), parent = f.add(f.body, 'main');
    const first = f.image(parent, 'same'), second = f.image(parent, 'same', 1200), last = f.image(parent, 'last', 2400);
    const discovery = createImmersiveDiscovery(f.doc), initial = discovery.scan();
    const replacement = f.image(parent, 'same');
    f.setTargets([replacement.target, second.target, last.target]);
    first.img.isConnected = false;
    const updated = discovery.scan();
    expect(updated.pages.map(page => page.id)).toEqual(initial.pages.map(page => page.id));
    expect(new Set(updated.pages.map(page => page.id)).size).toBe(3);
    expect(discovery.scan(element(second.img)).pages[0].id).toBe(initial.pages[1].id);
    expect(discovery.scan().pages.map(page => page.id)).toEqual(initial.pages.map(page => page.id));
  });

  it('replaces the slot when the source key changes on the same canvas or image element', () => {
    const f = fixture('dedicated'), original = f.image(f.body, 'page'), discovery = createImmersiveDiscovery(f.doc);
    const first = discovery.scan().pages[0];
    f.setTargets([{...original.target, key: 'new-content'}]);
    expect(discovery.scan().pages[0].id).not.toBe(first.id);
  });

  it('snapshots source identity even if an adapter reuses and mutates its target object', () => {
    const f = fixture('dedicated'), original = f.image(f.body, 'page'), discovery = createImmersiveDiscovery(f.doc);
    const first = discovery.scan().pages[0];
    original.target.key = 'changed-in-place';
    expect(discovery.scan().pages[0].id).not.toBe(first.id);
  });

  it('deduplicates the same element without merging distinct elements sharing a URL', () => {
    const f = fixture('dedicated'), first = f.image(f.body, 'same'), second = f.image(f.body, 'same', 1200);
    f.setTargets([first.target, first.target, second.target]);
    const result = createImmersiveDiscovery(f.doc).scan();
    expect(result.pages).toHaveLength(2);
    expect(new Set(result.pages.map(page => page.id)).size).toBe(2);
  });

  it('preserves original source handles without reading CSS translations, fetching or scrolling during discovery', async () => {
    const f = fixture('dedicated'), original = new Blob(['original bytes']), read = vi.fn(async () => original);
    const item = f.image(f.body, 'original', 0, 200, 800, 1100, read);
    Object.assign(item.img, {style: {content: 'url(blob:translated)'}, scrollIntoView: vi.fn()});
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const snapshot = createImmersiveDiscovery(f.doc).scan();
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(snapshot.pages[0].url).toBe(item.target.url);
    expect(await snapshot.pages[0].read!()).toBe(original);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]).toHaveLength(1);
    expect(f.page.session.inlineTargets).toHaveBeenCalledTimes(1);
  });

  it('expires page-bound reads and stable ids across source navigation', async () => {
    const f = fixture('dedicated'), read = vi.fn(async () => new Blob(['original']));
    f.image(f.body, 'blob', 0, 200, 800, 1100, read);
    const discovery = createImmersiveDiscovery(f.doc), first = discovery.scan();
    f.navigate();
    await expect(first.pages[0].read!()).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
    expect(read).not.toHaveBeenCalled();
    expect(discovery.rootFor(first.pages[0].element)).toBeNull();
    expect(discovery.scan().pages[0].id).not.toBe(first.pages[0].id);
  });

  it('passes caller cancellation to adapter-owned Blob/canvas reads', async () => {
    const f = fixture('dedicated'), read = vi.fn(async (signal?: AbortSignal) => { signal?.throwIfAborted(); return new Blob(['original']); });
    f.image(f.body, 'canvas', 0, 200, 800, 1100, read);
    const snapshot = createImmersiveDiscovery(f.doc).scan(), controller = new AbortController();
    controller.abort();
    await expect(snapshot.pages[0].read!(controller.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    f.page.controller.abort();
    await expect(snapshot.pages[0].read!()).rejects.toThrow();
  });

  it('checks document lifetime again after an asynchronous read', async () => {
    const f = fixture('dedicated');
    let finish!: (blob: Blob) => void;
    f.image(f.body, 'canvas', 0, 200, 800, 1100, () => new Promise(resolve => { finish = resolve; }));
    const discovery = createImmersiveDiscovery(f.doc), pending = discovery.scan().pages[0].read!();
    discovery.reset(); finish(new Blob(['stale canvas']));
    await expect(pending).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
  });

  it('bounds candidate references and declares truncation without claiming completeness', () => {
    const f = fixture('dedicated');
    for (let i = 0; i < 1501; i++) f.image(f.body, 'page' + i, i * 1200);
    const result = createImmersiveDiscovery(f.doc).scan();
    expect(result.pages).toHaveLength(1500);
    expect(result.limited).toBe(true);
    expect(result.partial).toBe(true);
  });

  it('groups a 1500-page chapter with bounded layout reads and no resource reads', () => {
    const f = fixture(), reader = f.add(f.add(f.body, 'main'), 'section'), read = vi.fn(async () => new Blob(['original']));
    for (let i = 0; i < 1500; i++) f.image(f.add(reader, 'div'), 'page' + i, i * 1200, 200, 800, 1100, read);
    const geometry = vi.spyOn(FixtureElement.prototype, 'getBoundingClientRect');
    try {
      expect(createImmersiveDiscovery(f.doc).scan().pages).toHaveLength(1500);
      expect(geometry.mock.calls.length).toBeLessThanOrEqual(5000);
      expect(read).not.toHaveBeenCalled();
      expect(f.page.session.inlineTargets).toHaveBeenCalledTimes(1);
    } finally { geometry.mockRestore(); }
  });
});
