import {describe, expect, it} from 'vitest';
import {createPage} from '../page';
import {definition} from '../definition';
import {plain, reader, readerHtml, scrambled, title, url} from './fixtures';

function fixture() {
  const anchor = {} as Element;
  let owner = url, canonical = reader;
  const elements = [
    {tagName: 'IMG', id: 'page1', complete: true, naturalWidth: 900, naturalHeight: 1200, src: plain, currentSrc: ''},
    {tagName: 'CANVAS', parentElement: {id: 'page2'}, width: 837, height: 1206},
    {tagName: 'IMG', id: 'page3', complete: true, naturalWidth: 900, naturalHeight: 1200, src: plain.replace('fixture_work', 'other')},
    {tagName: 'IMG', id: 'advertisement', complete: true, naturalWidth: 900, naturalHeight: 1200, src: plain},
  ];
  const document = {
    title: title + ' Ch.3', documentElement: {outerHTML: readerHtml()},
    querySelectorAll: (selector: string) => {
      if (selector === 'link[rel="canonical"]') return [{getAttribute: () => canonical}];
      if (selector === 'a#series' || selector === 'h1') return [{textContent: title, getAttribute: () => owner}];
      if (selector === '#pic_container img, #pic_container span.wsp canvas') return elements;
      throw Error(selector);
    },
    querySelector: () => ({parentElement: anchor}),
  } as unknown as Document;
  return {document, anchor, elements, setOwner: (value: string) => {owner = value;}, setCanonical: (value: string) => {canonical = value;}};
}
function session(document: Document, signal = new AbortController().signal, target = reader) {
  return createPage({document, location: definition.identify(new URL(target))!, signal});
}
describe('Mangago page integration', () => {
  it('binds loaded image and canvas slots to the complete HTTP manifest', async () => {
    const f = fixture(), page = session(f.document);
    expect(page.inlineTargets()).toEqual([]);
    expect(await page.discoverPages()).toMatchObject({status: 'ready', value: {knownTotal: 3, discoveryComplete: true}});
    const targets = page.inlineTargets();
    expect(targets.map(t => t.url)).toEqual([plain, scrambled]);
    expect(targets[0].element).toBe(f.elements[0]); expect(targets[1].element).toBe(f.elements[1]);
    expect(targets[0].key).not.toBe(targets[1].key);
    f.elements[0].src = plain + '?1';
    expect(page.inlineTargets()[0].url).toBe(plain + '?1');
    f.elements[0].src = plain.replace('42_100', '42_101');
    expect(page.inlineTargets()).toHaveLength(1);
    page.dispose(); expect(() => page.inlineTargets()).toThrow('SOURCE_SESSION_EXPIRED');
  });
  it('uses owned work metadata and exposes the source import anchor', async () => {
    const f = fixture(), page = session(f.document);
    await page.discoverPages();
    expect(page.describeWork!()).toEqual({status: 'ready', value: {title, catalogId: 'mangago:fixture_work', catalogUrl: url}});
    expect(page.importAnchor!()).toBe(f.anchor);
    f.setOwner(url.replace('fixture_work', 'other')); expect(page.describeWork!().status).toBe('not-ready');
    f.setOwner(url); f.setCanonical(reader.replace('-42', '-43')); expect(page.describeWork!().status).toBe('not-ready');
    expect(session(f.document, undefined, 'https://www.mangago.me/').importAnchor!()).toBeNull();
  });
  it('does not expose partial pages when decoding fails and respects cancellation', async () => {
    const f = fixture(); f.document.documentElement.outerHTML = readerHtml().replace('total_pages=3', 'total_pages=4');
    const page = session(f.document);
    expect(await page.discoverPages()).toMatchObject({status: 'not-ready'});
    expect(page.inlineTargets()).toEqual([]);
    const controller = new AbortController(), cancelled = session(f.document, controller.signal); controller.abort();
    await expect(cancelled.discoverPages()).rejects.toThrow();
    expect(() => cancelled.inlineTargets()).toThrow();
  });
});
