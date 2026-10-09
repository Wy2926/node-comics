import {afterEach, describe, expect, it, vi} from 'vitest';
import {createPage} from '../page';
import {definition, episodeUrl} from '../definition';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  let viewerId = '0123456789abcdef0123456789abcdef';
  const pixels = new Blob(['pixels'], {type: 'image/png'}), encode = vi.fn((done: BlobCallback) => done(pixels));
  const canvases = [0, 1, 2].map(() => ({width: 654, height: 930, isConnected: true, toBlob: encode}));
  const pages = canvases.map((canvas, index) => ({rendered: index !== 1,
    classList: {contains: () => pages[index].rendered}, matches: () => true,
    querySelector: (selector: string) => selector === '.-cv-page-canvas' ? {} : canvas,
    contains: (element: unknown) => element === canvas}));
  const document = {title: 'Chapter', documentElement: {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => ({getAttribute: () => viewerId}),
    querySelectorAll: () => [...pages, {querySelector: () => null}]} as unknown as Document;
  const controller = new AbortController();
  const session = createPage({document, location: definition.identify(new URL(episodeUrl('first')))!, signal: controller.signal});
  return {session, pixels, encode, canvases, pages, controller, rebind: () => {viewerId = 'fedcba9876543210fedcba9876543210';}};
}
describe('HEROS inline comici lifecycle', () => {
  it('keeps an unloaded slot and excludes non-canvas end screens without scanning pixels', async () => {
    const f = fixture(), first = f.session.snapshot(), second = f.session.snapshot();
    expect(first).toMatchObject({adapter: 'heros', knownTotal: 3, discoveryComplete: false, direction: 'rtl'});
    expect(first.items.map(item => item.order)).toEqual([0, 2]);
    expect(second.items).toEqual(first.items);
    expect(f.encode).not.toHaveBeenCalled();
    expect(await f.session.discoverPages()).toMatchObject({status: 'unsupported', code: 'NETWORK_SOURCE_REQUIRED'});
    expect(await f.session.inlineTargets()[0].read!()).toBe(f.pixels);
    f.session.dispose();
  });
  it.each(['resize', 'detach', 'rebind', 'abort', 'dispose'])('rejects old reads after %s', async mode => {
    const f = fixture(), old = f.session.inlineTargets()[0];
    if (mode === 'resize') f.canvases[0].width++;
    if (mode === 'detach') f.canvases[0].isConnected = false;
    if (mode === 'rebind') f.rebind();
    if (mode === 'abort') f.controller.abort();
    if (mode === 'dispose') f.session.dispose();
    await expect(old.read!()).rejects.toThrow();
    expect(f.encode).not.toHaveBeenCalled();
  });
  it('invalidates repaint handles even when canvas dimensions do not change, and disconnects observers', async () => {
    const observers: Array<{records: MutationRecord[]; disconnect: ReturnType<typeof vi.fn>}> = [];
    vi.stubGlobal('MutationObserver', class {
      records: MutationRecord[] = []; disconnect = vi.fn();
      constructor() {observers.push(this);}
      observe() {}
      takeRecords() {return this.records.splice(0);}
    });
    const f = fixture(), cleanup = f.session.observe!(vi.fn()), old = f.session.inlineTargets()[0];
    f.pages[0].rendered = false;
    observers[1].records.push({target: f.pages[0], attributeName: 'class', oldValue: '-cv-page mode-rendered'} as unknown as MutationRecord);
    expect(f.session.inlineTargets()).toHaveLength(1);
    f.pages[0].rendered = true;
    const replacement = f.session.inlineTargets()[0];
    expect(replacement.url).not.toBe(old.url);
    await expect(old.read!()).rejects.toThrow('EXPIRED');
    cleanup(); f.session.dispose();
    expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true);
  });
  it('gets a work title only from a matching canonical catalog, never a chapter heading', () => {
    const title = '作品', base = 'https://heros-web.com/series/fixture';
    const doc = {querySelector: (selector: string) => selector.startsWith('link') ? {href: base} : {content: title}} as unknown as Document;
    const work = (url: string) => createPage({document: doc, location: definition.identify(new URL(url))!, signal: new AbortController().signal}).describeWork!();
    expect(work(base)).toMatchObject({status: 'ready', value: {title, catalogId: 'heros:series:fixture', catalogUrl: base}});
    expect(work(base.replace('fixture', 'other')).status).toBe('not-ready');
    expect(work(episodeUrl('first')).status).toBe('not-ready');
  });
});
