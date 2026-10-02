import {describe, expect, it, vi} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {image, reader, url} from './fixtures';
const selector = '#vertical-content > .iv-card > img.image-vertical, #horizontal-content > .iv-card > img.image-vertical';
function img(alt: string, src = image) {
  return {alt, src, currentSrc: '', complete: true, naturalWidth: 800, naturalHeight: 60,
    getAttribute: (name: string) => name === 'data-src' ? src : null};
}
describe('RawOtaku tab translation and document lifecycle', () => {
  it('selects loaded short slices, preserves duplicate slots and excludes lazy, broken and invalid-path images', () => {
    const images = [img('0'), img('1'), {...img('2'), complete: false}, {...img('3'), naturalWidth: 0},
      img('ad'), img('4', 'data:image/gif;base64,placeholder'), img('5', 'https://evil.test/1.webp')];
    const doc = {title: '', querySelectorAll: (query: string) => {expect(query).toBe(selector); return images;}} as unknown as Document;
    const navigation = createSourceNavigation(doc), session = navigation.get(reader).session;
    const targets = session.inlineTargets(); expect(targets).toHaveLength(2); expect(targets[0].key).not.toBe(targets[1].key);
    images[0].src = image.replace('1.webp', '2.webp');
    expect(session.inlineTargets()).toHaveLength(1); // Loaded src no longer matches the site's pending data-src.
    expect(navigation.get(url).session.inlineTargets()).toEqual([]);
    expect(() => session.inlineTargets()).toThrow();
    expect(navigation.get('https://rawotaku.com/home/').session.inlineTargets()).toEqual([]);
    navigation.dispose();
  });
  it('recognizes extensionless originals on any CDN host while requiring the loaded URL to match data-src', () => {
    const original = image.replace('sv1.freeimgmg.online', 'cdn.fixture.test').replace('.webp', '');
    const images = [img('0', original), {...img('1', original), currentSrc: original.replace('/1', '/2')}];
    const doc = {title: '', querySelectorAll: () => images} as unknown as Document;
    const navigation = createSourceNavigation(doc);
    try {
      const targets = navigation.get(reader).session.inlineTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0].url).toBe(original);
    } finally {navigation.dispose();}
  });
  it('uses the work heading for search and hosts both native import anchors', async () => {
    const anchor = {} as Element; let canonical = url;
    const doc = {title: 'Chapter title only', querySelector: (query: string) => {
      if (query === 'link[rel="canonical"]') return {getAttribute: () => canonical};
      if (query === 'a.hr-manga') return {getAttribute: () => url};
      if (query.includes('h2.manga-name')) return {textContent: 'Work title'};
      return anchor;
    }} as unknown as Document;
    const nav = createSourceNavigation(doc), first = nav.get(url).session;
    expect(first.importAnchor?.()).toBe(anchor);
    expect(first.describeWork?.()).toMatchObject({status: 'ready', value: {title: 'Work title', catalogUrl: url}});
    canonical = reader; const next = nav.get(reader).session;
    expect(() => first.snapshot()).toThrow(); expect(next.importAnchor?.()).toBe(anchor);
    expect(await next.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
    expect(next.describeWork?.()).toMatchObject({status: 'ready', value: {title: 'Work title'}});
    canonical = reader.replace('chapter-1-', 'chapter-2-'); expect(next.describeWork?.().status).toBe('not-ready');
    nav.dispose(); expect(() => next.describeWork?.()).toThrow();
  });
  it('observes page slot and lazy URL changes and disconnects after navigation', () => {
    class FixtureElement {
      matches() {return true;}
      querySelector() {return null;}
    }
    const element = new FixtureElement();
    let observed: FixtureObserver | undefined;
    class FixtureObserver {
      options: MutationObserverInit = {}; disconnect = vi.fn();
      constructor(readonly changed: (records: MutationRecord[]) => void) {observed = this;}
      observe(_root: unknown, options: MutationObserverInit) {this.options = options;}
    }
    vi.stubGlobal('Element', FixtureElement); vi.stubGlobal('MutationObserver', FixtureObserver);
    const doc = {title: '', documentElement: element, addEventListener: vi.fn(), removeEventListener: vi.fn()} as unknown as Document;
    const nav = createSourceNavigation(doc);
    try {
      const session = nav.get(reader).session, changed = vi.fn(); session.observe!(changed);
      expect(observed!.options.attributeFilter).toEqual(expect.arrayContaining(['alt', 'data-src', 'src', 'class']));
      observed!.changed([{type: 'attributes', target: element} as unknown as MutationRecord]); expect(changed).toHaveBeenCalledTimes(1);
      nav.get(url); expect(observed!.disconnect).toHaveBeenCalledTimes(1);
      expect(doc.removeEventListener).toHaveBeenCalledWith('load', expect.any(Function), true);
    } finally {nav.dispose(); vi.unstubAllGlobals();}
  });
});
