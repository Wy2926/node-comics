import {describe, expect, it} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {url, reader, image} from './fixtures';

describe('Baozi page sessions', () => {
  it('cleans import anchors on navigation and never substitutes a partial DOM page list', async () => {
    const children: object[] = [];
    const doc = {title: 'chapter title', body: {append: (el: {isConnected: boolean}) => {el.isConnected = true; children.push(el);}},
      querySelector: (selector: string) => selector === '.comics-detail__title' ? {textContent: 'Work title'} : {getAttribute: () => url},
      querySelectorAll: () => [], createElement: () => {const el = {dataset: {}, style: {}, isConnected: false,
        remove() {el.isConnected = false; const index = children.indexOf(el); if (index >= 0) children.splice(index, 1);}}; return el;}} as unknown as Document;
    const navigation = createSourceNavigation(doc), first = navigation.get(url).session;
    expect(first.describeWork?.()).toMatchObject({status: 'ready', value: {title: 'Work title', catalogUrl: url}});
    expect(first.importAnchor?.()).toBe(first.importAnchor?.()); expect(children).toHaveLength(1);
    const next = navigation.get(reader).session;
    expect(children).toHaveLength(0); expect(() => first.importAnchor?.()).toThrow();
    expect(await next.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
    expect(next.describeWork?.().status).toBe('not-ready'); next.importAnchor?.();
    navigation.get('https://cn.baozimh.com/search?q=work'); expect(children).toHaveLength(0);
    navigation.dispose(); expect(() => next.inlineTargets()).toThrow();
  });
  it('keeps repeated rendered pages distinct and excludes loading, failed and foreign images', () => {
    const img = (id: string, src = image, complete = true, naturalWidth = 800) => ({src, complete, naturalWidth, naturalHeight: 1200, getAttribute: () => id});
    const doc = {title: '', querySelectorAll: () => [img('chapter-img-0-0'), img('chapter-img-0-1'), img('chapter-img-0-2', image, false),
      img('chapter-img-0-3', image, true, 0), img('advertisement'), img('chapter-img-0-4', 'https://evil.test/ad.jpg')]} as unknown as Document;
    const navigation = createSourceNavigation(doc), targets = navigation.get(reader).session.inlineTargets();
    expect(targets).toHaveLength(2); expect(targets[0].key).not.toBe(targets[1].key);
    expect(navigation.get(url).session.inlineTargets()).toEqual([]); navigation.dispose();
  });
  it('describes the work from matching reader metadata without treating the chapter title as its name', () => {
    let canonical = reader;
    const doc = {title: 'Chapter only', querySelector: (selector: string) => {
      if (selector === '.header .title') return {textContent: '第1话(1/2)'};
      if (selector.startsWith('amp-img#')) return {getAttribute: () => 'Work - with hyphen - 第1话(1/2) - 1'};
      if (selector === '.header a.goto') return {getAttribute: () => url};
      if (selector.startsWith('link')) return {getAttribute: () => canonical};
      return null;
    }} as unknown as Document;
    const navigation = createSourceNavigation(doc), session = navigation.get(reader).session;
    expect(session.describeWork?.()).toMatchObject({status: 'ready', value: {title: 'Work - with hyphen', catalogUrl: url}});
    canonical = reader.replace('0_0', '0_1'); expect(session.describeWork?.().status).toBe('not-ready'); navigation.dispose();
  });
});
