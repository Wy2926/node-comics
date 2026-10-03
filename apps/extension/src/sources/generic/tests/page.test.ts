import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageManifest } from '../../contracts/source';
import { createSourceNavigation, discoverDocument } from '../../page';
import { comicImageRect } from '../../shared/geometry';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function image(name: string, options: Record<string, unknown> = {}) {
  return {
    src: `https://images.example/${name}`,
    currentSrc: '',
    dataset: {},
    complete: true,
    naturalWidth: 320,
    naturalHeight: 400,
    getBoundingClientRect: () => ({ width: 400, height: 500 }),
    checkVisibility: () => true,
    ...options,
  } as unknown as HTMLImageElement;
}
describe('shared webpage image candidates', () => {
  it('keeps image identities across remounts without merging duplicate URLs or stealing a surviving slot', () => {
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', opacity: '1' }));
    let images = [image('same'), image('same'), image('last')];
    const doc = { title: 'Page', querySelectorAll: () => images } as unknown as Document;
    const session = createSourceNavigation(doc).get('https://example.test/page').session;
    const wire = () => {
      const snapshot = session.snapshot();
      return {
        ...snapshot,
        items: snapshot.items.map(({ resource, ...item }) => ({
          ...item,
          url: resource.kind === 'http' ? resource.url : '',
        })),
      } as PageManifest;
    };
    const first = wire();
    images = [image('same'), images[1], image('last')];
    const second = wire();
    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    expect(new Set(second.items.map((item) => item.id)).size).toBe(3);
    images = [image('different')];
  });
  it('uses rendered size, load status and visibility for both discovery and translation', () => {
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', opacity: '1' }));
    const images = [
      image('small-source'),
      image('strip', { getBoundingClientRect: () => ({ width: 300, height: 8000 }) }),
      image('thumbnail', {
        naturalWidth: 2000,
        naturalHeight: 3000,
        getBoundingClientRect: () => ({ width: 100, height: 150 }),
      }),
      image('banner', { getBoundingClientRect: () => ({ width: 1600, height: 400 }) }),
      image('loading', { complete: false }),
      image('placeholder', {
        naturalWidth: 1,
        naturalHeight: 1,
        dataset: { src: 'https://images.example/full' },
      }),
      image('hidden', { checkVisibility: () => false }),
    ];
    expect(images.filter((img) => comicImageRect(img)).map((img) => img.src)).toEqual(
      images.slice(0, 2).map((img) => img.src),
    );
    const doc = { title: 'Page', querySelectorAll: () => images } as unknown as Document;
    const manifest = discoverDocument(doc, 'https://example.test/page');
    const session = createSourceNavigation(doc).get('https://example.test/page').session;
    expect(session.inlineTargets().map(({ element }) => element)).toEqual(images.slice(0, 2));
    expect(
      manifest.items.map((item) => (item.resource.kind === 'http' ? item.resource.url : undefined)),
    ).toEqual(images.slice(0, 2).map((img) => img.src));
    expect(manifest.items[0]).toMatchObject({ width: 320, height: 400 });
    expect(manifest.discoveryComplete).toBe(false);
  });
  it.each([
    { visibility: 'hidden', opacity: '1' },
    { visibility: 'visible', opacity: '0' },
  ])('rejects hidden CSS %j', (css) => {
    vi.stubGlobal('getComputedStyle', () => css);
    expect(comicImageRect(image('hidden'))).toBeUndefined();
  });
  it('uses currentSrc like inline translation, keeps duplicate URLs as separate slots and IDs across refresh', () => {
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', opacity: '1' }));
    const img = image('fallback', {
      currentSrc: 'https://images.example/current',
      dataset: { src: 'https://images.example/lazy' },
    });
    const second = image('second'),
      duplicate = image('fallback', { currentSrc: img.currentSrc });
    const doc = { title: 'Page', querySelectorAll: () => [img, duplicate, second] } as unknown as Document;
    const session = createSourceNavigation(doc).get('https://example.test/page').session,
      first = session.snapshot();
    expect(
      first.items.map((item) => (item.resource.kind === 'http' ? item.resource.url : undefined)),
    ).toEqual([img.currentSrc, img.currentSrc, 'https://images.example/second']);
    Object.assign(doc, { querySelectorAll: () => [second] });
    const next = session.snapshot();
    expect(next.items[0].id).toBe(first.items[2].id);
  });
});

function canvasFixture() {
  let now = 0;
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', opacity: '1' }));
  const canvas = {
    tagName: 'CANVAS', width: 800, height: 1100, isConnected: true,
    ink: 32, uniform: false, tainted: false, left: 0,
    getBoundingClientRect() { return { width: 400, height: 550, top: 0, bottom: 550, left: this.left, right: this.left + 400 }; },
    checkVisibility: () => true,
    toBlob: vi.fn((done: (blob: Blob) => void) => done(new Blob(['canvas pixels'], { type: 'image/png' }))),
  };
  const draw = vi.fn();
  vi.stubGlobal('OffscreenCanvas', class {
    private source = canvas;
    getContext() {
      return {
        clearRect() {},
        drawImage: (source: typeof canvas) => { draw(); if (source.tainted) throw Error('SecurityError'); this.source = source; },
        getImageData: () => {
          const data = new Uint8ClampedArray(32 * 32 * 4).fill(255);
          if (!this.source.uniform) data[0] = this.source.ink;
          return { data };
        },
      };
    }
  });
  const original = { ...image('ordinary'), tagName: 'IMG' };
  const overlay = { ...image('overlay'), tagName: 'IMG', dataset: { ncCanvasTranslation: '' } };
  let elements = [canvas, overlay, original];
  const doc = {
    title: 'Canvas page', hidden: false, defaultView: { innerWidth: 1000, innerHeight: 800 },
    documentElement: {}, addEventListener() {}, removeEventListener() {},
    querySelector: (selector: string) => selector === 'canvas' ? elements.find(e => e.tagName === 'CANVAS') : null,
    querySelectorAll: (selector: string) => elements.filter(e => selector === 'img,canvas' ||
      (selector === 'canvas' ? e.tagName === 'CANVAS' : e.tagName === 'IMG' && !('ncCanvasTranslation' in ('dataset' in e ? e.dataset : {})))),
  };
  const navigation = createSourceNavigation(doc as unknown as Document);
  const session = navigation.get('https://example.test/canvas').session;
  return { canvas, original, overlay, doc, session, navigation, draw,
    advance: (ms = 500) => { now += ms; },
    replace: (next: typeof canvas) => { elements = [next, overlay, original]; },
  };
}

describe('generic canvas inline targets', () => {
  it('waits for stable visible pixels, preserves DOM order, excludes its own overlay and reads native canvas bytes', async () => {
    const { canvas, original, session, advance, draw } = canvasFixture();
    expect(session.inlineTargets().map(t => t.element)).toEqual([original]);
    advance();
    const targets = session.inlineTargets();
    expect(targets.map(t => t.element)).toEqual([canvas, original]);
    expect(targets[0].url).toMatch(/^page-image:/);
    expect(session.inlineTargets()[0].url).toBe(targets[0].url);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(await targets[0].read!()).toEqual(new Blob(['canvas pixels'], { type: 'image/png' }));
    // Generic discovery/import remains HTTP-only.
    expect(session.snapshot().items).toHaveLength(1);
  });
  it('waits for loading pixels and detects same-size redraws without any DOM mutation', async () => {
    const { canvas, session, advance } = canvasFixture();
    canvas.uniform = true;
    expect(session.inlineTargets().filter(t => t.read)).toEqual([]);
    canvas.uniform = false; advance(); session.inlineTargets(); advance();
    const previous = session.inlineTargets()[0];
    canvas.ink = 80; advance();
    expect(session.inlineTargets().filter(t => t.read)).toEqual([]);
    await expect(previous.read!()).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
    expect(canvas.toBlob).not.toHaveBeenCalled();
    advance();
    expect(session.inlineTargets()[0].url).not.toBe(previous.url);
  });
  it.each(['offscreen', 'hidden', 'tainted', 'blank'])('skips %s canvases without encoding source images', change => {
    const { canvas, doc, session, advance, draw } = canvasFixture();
    if (change === 'offscreen') canvas.left = -1000;
    if (change === 'hidden') doc.hidden = true;
    if (change === 'tainted') canvas.tainted = true;
    if (change === 'blank') canvas.uniform = true;
    session.inlineTargets(); advance();
    expect(session.inlineTargets().filter(t => t.read)).toEqual([]);
    expect(canvas.toBlob).not.toHaveBeenCalled();
    if (change === 'offscreen' || change === 'hidden') expect(draw).not.toHaveBeenCalled();
  });
  it.each(['detach', 'resize', 'replace', 'navigate', 'dispose'])('expires source reads after %s', async change => {
    const { canvas, session, navigation, advance, replace } = canvasFixture();
    session.inlineTargets(); advance(); const target = session.inlineTargets()[0];
    if (change === 'detach') canvas.isConnected = false;
    if (change === 'resize') canvas.width++;
    if (change === 'replace') { canvas.isConnected = false; replace({ ...canvas, isConnected: true }); }
    if (change === 'navigate') navigation.get('https://example.test/next');
    if (change === 'dispose') session.dispose();
    await expect(target.read!()).rejects.toThrow();
    expect(canvas.toBlob).not.toHaveBeenCalled();
  });
  it('rejects pixels changed during asynchronous encoding', async () => {
    const { canvas, session, advance } = canvasFixture();
    session.inlineTargets(); advance(); const target = session.inlineTargets()[0];
    canvas.toBlob.mockImplementation(done => { canvas.ink++; done(new Blob(['changed'])); });
    await expect(target.read!()).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
  });
  it('polls only subscribed foreground canvas pages and stops on cleanup', () => {
    vi.useFakeTimers();
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
    const { session, doc } = canvasFixture(), changed = vi.fn();
    const stop = session.observe!(changed);
    session.inlineTargets();
    vi.advanceTimersByTime(500); expect(changed).toHaveBeenCalledTimes(1);
    doc.hidden = true; vi.advanceTimersByTime(1000); expect(changed).toHaveBeenCalledTimes(1);
    stop(); doc.hidden = false; vi.advanceTimersByTime(1000); expect(changed).toHaveBeenCalledTimes(1);
  });
});
