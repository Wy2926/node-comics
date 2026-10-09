import {afterEach, describe, expect, it, vi} from 'vitest';
import {createPage} from '../page';
import {definition, episodeUrl} from '../definition';
import {episode, fixture, second, work} from './fixtures';

afterEach(() => vi.unstubAllGlobals());
function setup(targetEpisode = episode) {
  let now = 0, current = 0, raw = JSON.stringify(fixture()), canonical = episodeUrl(work, targetEpisode);
  vi.stubGlobal('performance', {now: () => now});
  vi.stubGlobal('getComputedStyle', () => ({visibility: 'visible', opacity: '1'}));
  const pages = Array.from({length: 8}, (_, index) => ({tagName: 'CANVAS', width: 800, height: 1100, isConnected: true,
    ink: index + 1, blank: false, tainted: false, checkVisibility: () => true,
    getBoundingClientRect: () => ({left: (current - index) * 1000, right: (current - index + 1) * 1000, top: 0, bottom: 800, width: 1000, height: 800}),
    toBlob: vi.fn((done: (b: Blob) => void) => done(new Blob(['page ' + index], {type: 'image/png'}))),
  }));
  let source = pages[0]; const samples = vi.fn();
  vi.stubGlobal('OffscreenCanvas', class {getContext() {return {
    clearRect() {}, drawImage(canvas: typeof source) {samples(); if (canvas.tainted) throw Error('SecurityError'); source = canvas;},
    getImageData() {const bytes = new Uint8ClampedArray(4096).fill(255); if (!source.blank) bytes[0] = source.ink; return {data: bytes};},
  };}});
  const doc = {hidden: false, title: 'Fixture', defaultView: {innerWidth: 1000, innerHeight: 800},
    querySelector: (selector: string) => selector === '#__NEXT_DATA__' ? {textContent: raw} : {href: canonical}, querySelectorAll: () => pages,
  } as unknown as Document;
  const controller = new AbortController(), session = createPage({document: doc,
    location: definition.identify(new URL(episodeUrl(work, targetEpisode)))!, signal: controller.signal});
  return {session, pages, doc, samples, controller, advance: () => {now += 500;}, turn: (index: number) => {current = index;},
    metadata: (value: unknown) => {raw = JSON.stringify(value);}, canonical: (value: string) => {canonical = value;}};
}
describe('ComicWalker bounded canvas lookahead', () => {
  it('discovers offscreen next pages without sampling the entire chapter', async () => {
    const f = setup(); expect(f.session.inlineTargets()).toEqual([]); expect(f.samples).toHaveBeenCalledTimes(5);
    f.advance(); const targets = f.session.inlineTargets(); expect(targets.map(t => t.element)).toEqual(f.pages.slice(0, 5));
    expect(f.samples).toHaveBeenCalledTimes(10);
    await targets[1].read!(); expect(f.pages[1].toBlob).toHaveBeenCalledOnce();
    expect(f.pages.slice(5).every(c => !c.toBlob.mock.calls.length)).toBe(true);
    expect(await f.session.discoverPages()).toMatchObject({status: 'unsupported'});
    expect(f.session.describeWork!()).toMatchObject({status: 'ready', value: {title: 'Fixture Work'}});
  });
  it('keeps blank/tainted/unstable pages out, revokes old bytes after redraw and permits retry', async () => {
    const f = setup(); f.pages[1].blank = true; f.pages[2].tainted = true;
    f.session.inlineTargets(); f.advance(); const target = f.session.inlineTargets()[0];
    expect(f.session.inlineTargets().map(t => t.element)).toEqual([f.pages[0], f.pages[3], f.pages[4]]);
    f.pages[0].ink++; f.advance(); await expect(target.read!()).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
    f.advance(); expect(f.session.inlineTargets()[0].url).not.toBe(target.url);
    f.pages[1].blank = false; f.pages[2].tainted = false; f.advance(); f.session.inlineTargets(); f.advance();
    expect(f.session.inlineTargets()).toHaveLength(5);
  });
  it('rejects reads outside the window, hidden documents, navigation, replacement and disposal', async () => {
    const f = setup(); f.session.inlineTargets(); f.advance(); const target = f.session.inlineTargets()[0];
    f.turn(6); await expect(target.read!()).rejects.toThrow(); f.turn(0);
    Object.defineProperty(f.doc, 'hidden', {value: true, configurable: true});
    expect(f.session.inlineTargets()).toEqual([]); await expect(target.read!()).rejects.toThrow();
    Object.defineProperty(f.doc, 'hidden', {value: false});
    f.pages[0].isConnected = false; await expect(target.read!()).rejects.toThrow(); f.pages[0].isConnected = true;
    f.canonical(episodeUrl(work, second));
    expect(f.session.inlineTargets()).toEqual([]); await expect(target.read!()).rejects.toThrow();
    f.metadata(fixture()); f.session.dispose(); await expect(target.read!()).rejects.toThrow();
  });
  it('recognizes the current reader after homepage or cross-work SPA entry with stale initial metadata', () => {
    const f = setup(); f.metadata({props: {pageProps: {dehydratedState: {queries: []}}}});
    f.session.inlineTargets(); f.advance(); expect(f.session.inlineTargets()).toHaveLength(5);
    expect(f.session.describeWork!()).toMatchObject({status: 'not-ready'});
    const data = fixture(); data.props.pageProps.workCode = 'KC_000002_S'; f.metadata(data);
    expect(f.session.inlineTargets()).toHaveLength(5);
    f.canonical(episodeUrl('KC_000002_S', second)); expect(f.session.inlineTargets()).toEqual([]);
  });
  it('does not require a complete chapter for inline recognition, but rejects a missing live chapter binding', () => {
    const f = setup(); f.pages.pop(); f.session.inlineTargets(); f.advance(); expect(f.session.inlineTargets()).toHaveLength(5);
    f.canonical(''); expect(f.session.inlineTargets()).toEqual([]);
    f.canonical('https://comic-walker.com/detail/' + work); expect(f.session.inlineTargets()).toEqual([]);
    f.canonical('https://example.com/detail/' + work + '/episodes/' + episode); expect(f.session.inlineTargets()).toEqual([]);
  });
  it('recognizes a same-work SPA chapter without depending on the stale initial episode', () => {
    const f = setup(second), data = fixture();
    const details = JSON.parse(JSON.stringify(data.props.pageProps.dehydratedState.queries[0].state.data));
    details.firstEpisodes.result[1].isActive = true;
    data.props.pageProps.dehydratedState.queries[0].state.data = details; f.metadata(data);
    f.session.inlineTargets(); f.advance(); expect(f.session.inlineTargets()).toHaveLength(5);
    f.canonical(episodeUrl('KC_000002_S', second)); expect(f.session.inlineTargets()).toEqual([]);
  });
});
