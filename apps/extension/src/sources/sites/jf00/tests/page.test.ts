import {describe, expect, it, vi} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {breadcrumb, image, reader, title, url} from './fixtures';

describe('漫画猫 DOM session', () => {
  it('hosts native import anchors and uses reader parent metadata, with expired navigation sessions', async () => {
    const anchor = {} as Element;
    let canonical = url, selected = '';
    const doc = {title: 'Chapter only', querySelector: (selector: string) => {
      selected = selector;
      if (selector === 'link[rel="canonical"]') return {getAttribute: () => canonical};
      if (selector === '.comic-meta-info h1') return {textContent: title};
      return anchor;
    }, querySelectorAll: () => [{textContent: breadcrumb()}]} as unknown as Document;
    const nav = createSourceNavigation(doc), first = nav.get(url).session;
    expect(first.importAnchor?.()).toBe(anchor); expect(selected).toBe('.comic-actions');
    expect(first.describeWork?.()).toMatchObject({status: 'ready', value: {title, catalogUrl: url}});
    const next = nav.get(reader).session; canonical = reader;
    expect(() => first.importAnchor?.()).toThrow();
    expect(next.importAnchor?.()).toBe(anchor); expect(selected).toBe('.reader-nav .nav-right');
    expect(await next.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
    expect(next.describeWork?.()).toMatchObject({status: 'ready', value: {title, catalogUrl: url}});
    canonical = reader.replace('123_11', '123_12'); expect(next.describeWork?.().status).toBe('not-ready');
    nav.dispose(); expect(() => next.snapshot()).toThrow();
  });
  it('selects loaded site正文 images, distinct repeated URLs, excludes ads and failed/lazy images', () => {
    const img = (alt: string, src = image, complete = true, width = 800) => ({alt, src, complete, naturalWidth: width, naturalHeight: 1200});
    const doc = {title: '', querySelectorAll: () => [img('Work - 第1张图'), img('Work - 第2张图'), img('Work - 第3张图', image, false),
      img('Work - 第4张图', image, true, 0), img('Advertisement'), img('Work - 第5张图', 'https://evil.test/ad.jpg')]} as unknown as Document;
    const nav = createSourceNavigation(doc), targets = nav.get(reader).session.inlineTargets();
    expect(targets).toHaveLength(2); expect(targets[0].key).not.toBe(targets[1].key);
    expect(nav.get(url).session.inlineTargets()).toEqual([]); nav.dispose();
  });
  it('invalidates alt-only body changes and disconnects the observer when navigation ends', () => {
    class FixtureImage {
      alt = 'Work - 第1张图'; src = image; complete = true; naturalWidth = 800; naturalHeight = 1200;
      matches() {return true;}
      querySelector() {return null;}
    }
    const img = new FixtureImage();
    let observer: FixtureObserver | undefined;
    class FixtureObserver {
      attributes: string[] = [];
      disconnect = vi.fn();
      constructor(readonly changed: (records: MutationRecord[]) => void) {observer = this;}
      observe(_root: unknown, options: MutationObserverInit) {this.attributes = options.attributeFilter ?? [];}
      mutate(attribute: string) {
        if (this.attributes.includes(attribute)) this.changed([{type: 'attributes', target: img} as unknown as MutationRecord]);
      }
    }
    vi.stubGlobal('Element', FixtureImage);
    vi.stubGlobal('MutationObserver', FixtureObserver);
    const doc = {title: '', documentElement: img, querySelectorAll: () => [img],
      addEventListener: vi.fn(), removeEventListener: vi.fn()} as unknown as Document;
    const nav = createSourceNavigation(doc);
    try {
      const session = nav.get(reader).session, changed = vi.fn();
      session.observe!(changed);
      const oldKey = session.inlineTargets()[0].key;
      img.alt = 'Advertisement'; observer!.mutate('alt');
      expect(changed).toHaveBeenCalledTimes(1); expect(session.inlineTargets()).toEqual([]);
      img.alt = 'Work - 第2张图'; observer!.mutate('alt');
      expect(changed).toHaveBeenCalledTimes(2); expect(session.inlineTargets()[0].key).not.toBe(oldKey);
      nav.dispose();
      expect(observer!.disconnect).toHaveBeenCalledTimes(1);
      expect(doc.removeEventListener).toHaveBeenCalledWith('load', expect.any(Function), true);
      expect(() => session.inlineTargets()).toThrow();
    } finally {nav.dispose(); vi.unstubAllGlobals();}
  });
});
