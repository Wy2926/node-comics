import {expect, it} from 'vitest';
import {createSourceNavigation} from '../../../page';
import {createPage} from '../page';
import {definition} from '../definition';
import {cdn, reader, url} from './fixtures';

function documentFixture() {
  const state = {canonical: reader, selected: 'chapter-175-8-8', heading: 'Fixture - Chapter 175.88', secondary: 'chapter-175-8-8'};
  const attribute = (value: string) => ({getAttribute: () => value});
  const images = [1, 2, 3, 4, 5].map(number => ({src: cdn + number + '-abc.jpg', currentSrc: cdn + number + '-abc.jpg',
    alt: 'Fixture - Chapter 175.88 Page ' + number, complete: true, naturalWidth: 720, naturalHeight: 100,
    getAttribute: () => cdn + number + '-abc.jpg'} as unknown as HTMLImageElement));
  Object.defineProperty(images[1], 'naturalWidth', {value: 0}); images[2].alt = 'Advertisement';
  images[3].getAttribute = () => cdn + 'wrong.jpg';
  images[4].src = cdn.replace('/175.88/', '/174/') + '5-abc.jpg';
  Object.defineProperty(images[4], 'currentSrc', {value: images[4].src});
  images[4].getAttribute = () => images[4].src;
  const anchor = {} as Element;
  const catalogAnchor = {} as Element;
  const doc = {title: 'Fixture',
    querySelector: (selector: string) => selector === 'link[rel="canonical"]' ? attribute(state.canonical)
      : selector === '.navi-change-chapter option:checked' ? {...attribute(state.selected), textContent: 'Chapter 175.88'}
      : selector === 'h1' ? {textContent: state.heading} : selector === '.post-title' ? catalogAnchor
      : selector === '.c-breadcrumb' ? anchor : null,
    querySelectorAll: (selector: string) => selector === '.breadcrumb a' ? [{href: url, textContent: 'Fixture'}]
      : selector === '.navi-change-chapter option:checked' ? [state.selected, state.secondary].map(value => ({...attribute(value), textContent: 'Chapter 175.88'}))
      : selector === '.post-title h1' ? [{textContent: 'Fixture'}] : images,
  } as unknown as Document;
  return {doc, state, images, anchor, catalogAnchor};
}
it('recognizes only loaded source body images and reliable work names, and expires cancelled/disposed sessions', async () => {
  const {doc, state, images, anchor} = documentFixture(), controller = new AbortController();
  const session = createPage({document: doc, location: definition.identify(new URL(reader))!, signal: controller.signal});
  expect(await session.discoverPages()).toEqual({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
  expect(session.inlineTargets().map(t => t.element)).toEqual([images[0]]);
  expect(session.describeWork?.()).toEqual({status: 'ready', value: {title: 'Fixture', catalogId: 'mangadna:fixture', catalogUrl: url}});
  expect(session.importAnchor?.()).toBe(anchor);
  state.canonical = url.replace('fixture', 'other') + '/chapter-175-8-8';
  expect(session.inlineTargets()).toEqual([]);
  expect(session.describeWork?.().status).toBe('not-ready');
  state.canonical = reader; state.selected = 'chapter-0';
  expect(session.inlineTargets()).toEqual([]);
  state.selected = 'chapter-175-8-8'; state.secondary = 'chapter-0';
  expect(session.inlineTargets()).toEqual([]);
  state.secondary = state.selected;
  state.heading = 'Fixture - Chapter 175.88 unrelated'; images[0].alt = state.heading + ' Page 1';
  expect(session.inlineTargets()).toEqual([]);
  state.heading = 'Fixture - Chapter 175.88'; images[0].alt = state.heading + ' Page 1501';
  expect(session.inlineTargets()).toEqual([]);
  images[0].alt = state.heading + ' Page 1'; expect(session.inlineTargets()).toHaveLength(1);
  controller.abort();
  expect(() => session.snapshot()).toThrow();
  const live = createPage({document: doc, location: definition.identify(new URL(reader))!, signal: new AbortController().signal});
  live.dispose(); expect(() => live.inlineTargets()).toThrow('SOURCE_SESSION_EXPIRED');
});
it('uses the public navigation lifecycle for catalog/reader entries and rejects the old session after navigation', () => {
  const {doc, state, anchor, catalogAnchor} = documentFixture(), navigation = createSourceNavigation(doc);
  state.canonical = url;
  const catalog = navigation.get(url).session;
  expect(catalog.describeWork?.().status).toBe('ready');
  expect(catalog.inlineTargets()).toEqual([]);
  expect(catalog.importAnchor?.()).toBe(catalogAnchor);
  state.canonical = reader;
  const chapter = navigation.get(reader).session;
  expect(() => catalog.importAnchor?.()).toThrow();
  expect(chapter.inlineTargets()).toHaveLength(1);
  expect(chapter.importAnchor?.()).toBe(anchor);
  navigation.dispose();
  expect(() => chapter.snapshot()).toThrow();
});
it('does not embed a work import entry on an unsupported site page', () => {
  const {doc} = documentFixture();
  const session = createPage({document: doc, location: definition.identify(new URL('https://mangadna.com/search?q=Fixture'))!, signal: new AbortController().signal});
  expect(session.importAnchor?.()).toBeNull();
  session.dispose();
});
