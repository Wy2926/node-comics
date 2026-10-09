import {expect, it} from 'vitest';
import {network} from '../network';
import {image} from '../image';

it.skipIf(process.env.RUN_LIVE_COMICWALKER !== '1')('validates public HTTP metadata and decodes one real page without logging signed URLs', async () => {
  const times: Record<string, number> = {}, started = performance.now();
  const context = {request: async (url: string) => {const response = await fetch(url); if (!response.ok) throw Error(`HTTP ${response.status}`); return response.text();}};
  const catalog = await network.catalog!('https://comic-walker.com/detail/KC_008597_S', context);
  expect(await network.resolveCatalog!('https://comic-walker.com/viewer/KC_0085970000200011_E', context)).toBe(catalog.url);
  times.catalogMs = performance.now() - started;
  expect(catalog.complete).toBe(true); expect(catalog.entries.length).toBeGreaterThan(8);
  const entry = catalog.entries.find(e => e.remoteId === 'KC_0085970000200011_E')!;
  const pageStart = performance.now(), pages = await network.pages!(entry.url, context);
  times.manifestMs = performance.now() - pageStart; expect(pages.items).toHaveLength(56);
  const resource = pages.items[0].resource; if (resource.kind !== 'http') throw Error('Expected HTTP');
  const response = await fetch(resource.url); expect(response.ok).toBe(true);
  const input = await response.blob(), decodeStart = performance.now();
  const decoded = await image.decode!(input, response.headers, resource.processing);
  times.decodeMs = performance.now() - decodeStart; expect(decoded.type).toBe('image/webp');
  expect(decoded.size).toBeGreaterThan(10000);
  const search = await network.search!({siteId: 'comicwalker', query: 'Dolls'}, context);
  expect(search.items.some(hit => hit.catalogId === catalog.id)).toBe(true);
  console.log(JSON.stringify({catalogEntries: catalog.entries.length, pages: pages.items.length, encodedBytes: input.size, decodedBytes: decoded.size, times}));
}, 60000);
