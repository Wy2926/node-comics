import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageManifest } from '../../contracts/source';
import { refreshChoices } from '../../core/selection';
import { createSourceNavigation, discoverDocument } from '../../page';
import { comicImageRect } from '../../shared/geometry';

afterEach(() => vi.unstubAllGlobals());
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
  it('keeps deselection across remounts without merging duplicate URLs or stealing a surviving slot', () => {
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
    const first = wire(),
      choices = first.items.map((item) => ({ ...item, selected: false }));
    images = [image('same'), images[1], image('last')];
    const second = wire();
    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    expect(new Set(second.items.map((item) => item.id)).size).toBe(3);
    expect(refreshChoices(choices, second).every((item) => !item.selected)).toBe(true);
    images = [image('different')];
    expect(refreshChoices(choices, wire())[0].selected).toBe(true);
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
