import {describe, expect, it} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {catalogUrl, releaseUrl} from '../definition';

describe('MangaDot page entry and original targets', () => {
  it('mounts once, clears stale metadata/anchors on navigation, and never falls back to DOM acquisition', async () => {
    const children: object[] = [], meta: Record<string, string> = {'og:url': catalogUrl('7'), 'og:title': 'Work title'};
    const doc = {title: 'Not a work title', body: {append: (el: {isConnected: boolean}) => {children.push(el); el.isConnected = true;}},
      querySelector: (selector: string) => {const key = /og:\w+/.exec(selector)?.[0]; return key ? {getAttribute: () => meta[key]} : null;},
      querySelectorAll: () => [], createElement: () => {const el = {dataset: {}, style: {}, isConnected: false,
        remove() {el.isConnected = false; const index = children.indexOf(el); if (index >= 0) children.splice(index, 1);}}; return el;}} as unknown as Document;
    const navigation = createSourceNavigation(doc), first = navigation.get(catalogUrl('7')).session;
    expect(first.importAnchor?.()).toBe(first.importAnchor?.()); expect(children).toHaveLength(1);
    expect(first.describeWork?.()).toEqual({status: 'ready', value: {title: 'Work title', catalogId: 'mangadot:7', catalogUrl: catalogUrl('7')}});
    meta['og:url'] = catalogUrl('8'); expect(first.describeWork?.().status).toBe('not-ready');
    const next = navigation.get(releaseUrl('1', 'user', 'chapter')).session;
    expect(children).toHaveLength(0); expect(() => first.importAnchor?.()).toThrow();
    expect(next.describeWork?.().status).toBe('not-ready');
    expect(await next.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
    next.importAnchor?.(); expect(children).toHaveLength(1);
    navigation.get('https://mangadot.net/search').session.importAnchor?.(); expect(children).toHaveLength(0);
    navigation.dispose(); expect(() => next.inlineTargets()).toThrow();
  });
  it('selects only loaded source reader images and assigns separate keys for repeated page URLs', () => {
    const image = (alt: string, src: string, complete = true) => ({alt, src, complete, naturalWidth: 800, naturalHeight: 1200, getAttribute: () => alt});
    const src = 'https://mangadot.net/chapters/manga_7/ch1/001.webp';
    const doc = {title: '', querySelectorAll: () => [image('Page 1', src), image('Page 2', src), image('Page 3', src, false),
      image('Cover', src), image('Page 4', 'https://evil.test/chapters/manga_7/ch1/1.webp')]} as unknown as Document;
    const navigation = createSourceNavigation(doc), session = navigation.get(releaseUrl('1', 'user', 'chapter')).session;
    const targets = session.inlineTargets(); expect(targets).toHaveLength(2); expect(targets[0].key).not.toBe(targets[1].key);
    expect(navigation.get(catalogUrl('7')).session.inlineTargets()).toEqual([]); navigation.dispose();
  });
});
