import {afterEach, describe, expect, it, vi} from 'vitest';
import {createPage} from '../page';
import {definition} from '../definition';
import {createSourceNavigation} from '../../../page';
import {bareUrl, boundReader, chapterTitle, cover, image, modernImage, reader, title, url} from './fixtures';

const selector = 'chapter-page img.js-page';
function img(number: number, src = image) {
  let summary = `page ${number}/3`, pending = src;
  return {alt: `${chapterTitle} Page ${number}`, src, currentSrc: '', complete: true,
    naturalWidth: 1066, naturalHeight: 60,
    getAttribute: (name: string) => name === 'data-src' ? pending : null,
    closest: (name: string) => name === 'chapter-page' ? {querySelector: () => ({get textContent() {return summary;}})} : null,
    setSummary: (value: string) => {summary = value;}, setPending: (value: string) => {pending = value;}};
}
function session(document: Document, target = reader, signal = new AbortController().signal) {
  return createPage({document, location: definition.identify(new URL(target))!, signal});
}
function readerDoc(images: ReturnType<typeof img>[]) {
  return {title: chapterTitle, querySelector: (query: string) => {
    if (query === 'h1#top') return {textContent: chapterTitle};
    return null;
  }, querySelectorAll: (query: string) => {expect(query).toBe(selector); return images;}} as unknown as Document;
}
afterEach(() => vi.unstubAllGlobals());

describe('MangaPill inline targets and page lifetime', () => {
  it('selects only loaded owned body slices and preserves duplicate URLs as distinct slots', () => {
    const images = [img(1), img(2), {...img(3), complete: false}, {...img(3), naturalWidth: 0},
      img(3, image.replace('/42/', '/43/')), img(3, image.replace('/10001000/', '/10002000/')),
      img(3, image.replace('.com/', '.com.evil.test/')), img(3, 'data:image/png;base64,fixture')];
    const page = session(readerDoc(images));
    const targets = page.inlineTargets(); expect(targets).toHaveLength(2);
    expect(targets[0].url).toBe(targets[1].url); expect(targets[0].key).not.toBe(targets[1].key);
    expect(page.snapshot()).toMatchObject({adapter: 'mangapill', discoveryComplete: false, items: []});
    images[0].src = image.replace('1.jpeg', '2.jpeg'); expect(page.inlineTargets()).toHaveLength(1);
    images[0].setPending(images[0].src); expect(page.inlineTargets()).toHaveLength(2);
    expect(session(readerDoc(images), url).inlineTargets()).toEqual([]);
    page.dispose(); expect(() => page.inlineTargets()).toThrow('SOURCE_SESSION_EXPIRED');
  });
  it('checks summary, alt and source data-src without excluding small source slices', () => {
    const pictures = [img(1, modernImage), img(2, modernImage), img(3, modernImage), img(3, modernImage)];
    pictures[1].setSummary('page 2/1'); pictures[2].alt = `${chapterTitle} Page 2`;
    pictures[3].setSummary('advertisement');
    const page = session(readerDoc(pictures));
    expect(page.inlineTargets()).toHaveLength(1); expect(page.inlineTargets()[0].url).toBe(modernImage);
    pictures[0].setPending(image); expect(page.inlineTargets()).toEqual([]);
  });
  it('uses dedicated work metadata for name lookup and native heading parents for import', async () => {
    const anchor = {} as Element; let owner = '/manga/42', label = title + ' Chapters', heading = title;
    let artwork = cover; const coverImg = {alt: title, getAttribute: () => artwork};
    const document = {title: 'Misleading document or chapter title', querySelector: (query: string) => {
      if (query === '#chapter-selector-modal-title') return {textContent: label};
      if (query === 'h1' || query === 'h1#top') return {textContent: query === 'h1' ? heading : chapterTitle, parentElement: anchor};
      return null;
    }, querySelectorAll: (query: string) => {
      if (query === 'a[data-hotkey="m"]') return [{getAttribute: () => owner}];
      if (query === 'img[data-src]') return [coverImg];
      if (query === selector) return [];
      throw Error(query);
    }} as unknown as Document;
    const catalog = session(document, url), chapterPage = session(document);
    expect(catalog.describeWork?.()).toEqual({status: 'ready', value: {title, catalogId: 'mangapill:42', catalogUrl: url}});
    expect(chapterPage.describeWork?.()).toEqual({status: 'ready', value: {title, catalogId: 'mangapill:42', catalogUrl: bareUrl}});
    expect(session(document, boundReader).describeWork?.()).toEqual({status: 'ready', value: {title, catalogId: 'mangapill:42', catalogUrl: url}});
    expect(chapterPage.importAnchor?.()).toBe(anchor); expect(catalog.importAnchor?.()).toBe(anchor);
    expect(await chapterPage.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
    owner = '/manga/43'; expect(chapterPage.describeWork?.().status).toBe('not-ready'); owner = '/manga/42';
    label = chapterTitle; expect(chapterPage.describeWork?.().status).toBe('not-ready');
    heading = 'Other'; expect(catalog.describeWork?.().status).toBe('not-ready'); heading = title;
    artwork = cover.replace('/42.', '/43.'); expect(catalog.describeWork?.().status).toBe('not-ready');
    expect(session(document, 'https://mangapill.com/search?q=Fixture').importAnchor?.()).toBeNull();
  });
  it('rejects cancelled or navigated sessions and permits a fresh recovered document', async () => {
    const document = readerDoc([img(1)]), controller = new AbortController();
    const cancelled = session(document, reader, controller.signal); controller.abort();
    expect(() => cancelled.snapshot()).toThrow(); expect(() => cancelled.inlineTargets()).toThrow();
    await expect(cancelled.discoverPages()).rejects.toThrow();
    const navigation = createSourceNavigation(document, undefined, {definitions: [definition], pages: {mangapill: createPage}});
    const first = navigation.get(reader).session; expect(first.inlineTargets()).toHaveLength(1);
    const recovered = navigation.get(reader.replace('-10001000/', '-10002000/')).session;
    expect(() => first.inlineTargets()).toThrow(); expect(recovered.inlineTargets()).toEqual([]);
    expect(navigation.get(reader).session.inlineTargets()).toHaveLength(1);
    navigation.dispose(); expect(() => recovered.snapshot()).toThrow();
  });
  it('observes lazy sources, summaries and heading changes and cleans up on navigation', () => {
    class FixtureElement {matches() {return true;} querySelector() {return null;}}
    const element = new FixtureElement(); let observer: FixtureObserver | undefined;
    class FixtureObserver {
      options: MutationObserverInit = {}; disconnect = vi.fn();
      constructor(readonly changed: (records: MutationRecord[]) => void) {observer = this;}
      observe(_root: unknown, options: MutationObserverInit) {this.options = options;}
    }
    vi.stubGlobal('Element', FixtureElement); vi.stubGlobal('MutationObserver', FixtureObserver);
    const document = {title: '', documentElement: element, addEventListener: vi.fn(), removeEventListener: vi.fn()} as unknown as Document;
    const navigation = createSourceNavigation(document, undefined, {definitions: [definition], pages: {mangapill: createPage}});
    const first = navigation.get(reader).session, changed = vi.fn(); first.observe!(changed);
    expect(observer!.options.attributeFilter).toEqual(expect.arrayContaining(['src', 'data-src', 'alt', 'data-summary']));
    observer!.changed([{type: 'attributes', target: element} as unknown as MutationRecord]);
    expect(changed).toHaveBeenCalledTimes(1);
    navigation.get(url); expect(observer!.disconnect).toHaveBeenCalledTimes(1);
    expect(document.removeEventListener).toHaveBeenCalledWith('load', expect.any(Function), true);
    navigation.dispose();
  });
});
