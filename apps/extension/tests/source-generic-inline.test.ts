import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {definitions} from '../src/sources/registry/definitions';
import {pageFactories} from '../src/sources/registry/pages';
import {inlineImageSize, sourceFor} from '../src/sources';
import {createSourceNavigation} from '../src/sources/page';
import {networkOperation} from '../src/sources/runtime/network';

beforeEach(() => vi.stubGlobal('getComputedStyle', () => ({visibility: 'visible', opacity: '1'})));
afterEach(() => vi.unstubAllGlobals());

function fixture(url: string) {
  const origin = new URL(url).origin;
  const image = (src: string, options = {}) => ({src, currentSrc: '', tagName: 'IMG', complete: true,
    naturalWidth: 800, naturalHeight: 1200, isConnected: true, dataset: {},
    getBoundingClientRect: () => ({width: 400, height: 600}), checkVisibility: () => true, ...options});
  const good = [image('https://images.test/page.png'), image(`blob:${origin}/page`), image(`blob:${origin}/page`)];
  const images = [...good, image('https://images.test/thumb.png', {getBoundingClientRect: () => ({width: 80, height: 80})}),
    image(`blob:${origin}/loading`, {complete: false}), image('blob:https://foreign.test/page'),
    image('https://images.test/hidden.png', {checkVisibility: () => false})];
  const querySelectorAll = vi.fn((selector: string) => selector === 'canvas' ? [] : images);
  return {good, querySelectorAll, document: {title: 'Fixture', querySelectorAll, defaultView: null} as unknown as Document};
}

describe('generic recognition is independent of import classification', () => {
  for (const definition of definitions.filter(source => source.inlineRecognition === 'generic')) {
    it.each(['reader', 'catalog', 'other'] as const)(`${definition.id} scans %s pages without changing their identity`, async kind => {
      const url = definition.sites![0].url, {document, good, querySelectorAll} = fixture(url);
      const location = Object.freeze({sourceId: definition.id, pageKey: 'fixture', kind, url});
      const controller = new AbortController(), session = pageFactories[definition.id]({document, location, signal: controller.signal});
      const targets = session.inlineTargets();
      expect(targets.map(target => target.element)).toEqual(good);
      expect(targets.slice(1).every(target => !!target.read)).toBe(true);
      expect(location.kind).toBe(kind);
      expect(querySelectorAll.mock.calls.map(([selector]) => selector)).toEqual(['img:not([data-nc-canvas-translation])', 'img,canvas']);
      expect(await session.discoverPages()).toEqual({status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'});
      controller.abort(Error('navigation'));
      expect(() => session.inlineTargets()).toThrow('navigation');
      await expect(targets[1].read!()).rejects.toThrow('navigation');
      session.dispose();
      const fresh = pageFactories[definition.id]({document, location, signal: new AbortController().signal});
      fresh.dispose(); expect(() => fresh.inlineTargets()).toThrow('SOURCE_SESSION_EXPIRED');
    });
  }

  it.each([
    ['comicfuz', 'https://comic-fuz.com/manga/2062'],
    ['comickz', 'https://comickz.co.uk/comic/fixture'],
    ['klmanga', 'https://klmanga.toys/manga-raw/fixture/'],
    ['rawlazy', 'https://rawlazy.io/manga-lazy/fixture/'],
    ['pixiv', 'https://www.pixiv.net/users/123/artworks'],
  ])('%s retains real catalog identity, import routing and generic dimensions', (id, url) => {
    const {definition, location} = sourceFor(url), {document, good} = fixture(url);
    expect(definition.id).toBe(id); expect(location.kind).toBe('catalog');
    const navigation = createSourceNavigation(document), page = navigation.get(url);
    expect(page.location).toEqual(location);
    expect(page.session.inlineTargets().map(target => target.element)).toEqual(good);
    expect(inlineImageSize(800, 1200, url)).toBe(true); expect(inlineImageSize(80, 80, url)).toBe(false);
    expect(inlineImageSize(760, 60, url)).toBe(false);
    expect(networkOperation(url, 'catalog')).toBeTypeOf('function');
    expect(() => networkOperation(url, 'pages')).toThrow('SOURCE_OPERATION_UNSUPPORTED');
    navigation.get(new URL('/', url).href);
    expect(() => page.session.inlineTargets()).toThrow(); navigation.dispose();
  });

  it.each(['baozimh', 'dm5', 'jf00', 'mangacopy', 'mangadot', 'naver', 'rawotaku', 'comix', 'comicpash', 'heros', 'comicdays', 'sundaywebry'])(
    '%s keeps its dedicated recognizer out of non-reader pages', id => {
      for (const kind of ['catalog', 'other'] as const) {
        const querySelectorAll = vi.fn(() => {throw Error('Unexpected DOM scan');});
        const session = pageFactories[id]({document: {querySelectorAll} as unknown as Document,
          location: {sourceId: id, pageKey: 'fixture', url: 'https://fixture.test/', kind}, signal: new AbortController().signal});
        expect(session.inlineTargets()).toEqual([]); expect(querySelectorAll).not.toHaveBeenCalled(); session.dispose();
      }
    });
});
