import {expect, it} from 'vitest';
import {mkdir, writeFile} from 'node:fs/promises';
import {network} from '../network';
import {definition} from '../definition';
import {validateCatalog} from '../../../core/catalog';
import {validatePages} from '../../../core/pages';
import {imageMimeFromBytes} from '../../../../comics/formats/identify';

it.skipIf(process.env.RUN_LIVE_ZAIMANHUA !== '1')('reads real public search/catalogs/chapter lists/covers and sampled images without logging signed URLs', async () => {
  let requests = 0, metadataBytes = 0;
  const context = {request: async (url: string) => {
    requests++;
    const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw Error(`Source HTTP ${response.status}`);
    const body = await response.text(); metadataBytes += new TextEncoder().encode(body).length; return body;
  }};
  async function image(url: string, label: string) {
    const response = await fetch(url, {headers: {Referer: 'https://www.zaimanhua.com/'}, signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw Error(`${label}: Image HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(imageMimeFromBytes(bytes)).toMatch(/^image\//); expect(bytes.length).toBeGreaterThan(1000); return bytes.length;
  }
  const summaries = [];
  for (const [url, query] of [['https://www.zaimanhua.com/info/doufo.html', '斗佛'], ['https://manhua.zaimanhua.com/details/65391', '琉璃龙龙']]) {
    const start = performance.now(), before = requests;
    const catalog = validateCatalog(await network.catalog(url, context), [definition]);
    const catalogMs = performance.now() - start;
    expect(catalog.complete).toBe(true); expect(catalog.entries.length).toBeGreaterThan(30);
    const search = await network.search({siteId: 'zaimanhua', query}, context);
    expect(search.items.some(hit => hit.catalogId === catalog.id)).toBe(true);
    const chapters = [];
    for (const entry of [catalog.entries[0], catalog.entries.at(-1)!]) {
      const start = performance.now(), manifest = validatePages(await network.pages(entry.url, context), definition.identify(new URL(entry.url))!);
      expect(manifest.discoveryComplete).toBe(true); expect(manifest.items.length).toBeGreaterThan(0);
      const manifestMs = performance.now() - start;
      const first = manifest.items[0].resource, last = manifest.items.at(-1)!.resource;
      if (first.kind !== 'http' || last.kind !== 'http') throw Error('Expected HTTP images');
      const bytes = await image(first.url, entry.id + ':first') + await image(last.url, entry.id + ':last');
      chapters.push({pages: manifest.items.length, manifestMs: Math.round(manifestMs), sampledImageBytes: bytes});
    }
    summaries.push({id: catalog.id, entries: catalog.entries.length, groups: catalog.groups.length, catalogMs: Math.round(catalogMs),
      metadataRequests: requests - before, chapters, coverBytes: await image(catalog.cover!.url, catalog.id + ':cover')});
  }
  const input = {siteId: 'zaimanhua-manga', query: '猫咪'}, first = await network.search(input, context);
  expect(first.nextCursor).toBeTruthy(); const next = await network.search({...input, cursor: first.nextCursor}, context);
  expect(next.items.length).toBeGreaterThan(0);
  expect(next.items.every(hit => !first.items.some(previous => previous.catalogId === hit.catalogId))).toBe(true);
  const result = {liveSource: true, liveProvider: false, summaries, requests, metadataBytes};
  const directory = new URL('../../../../../../../artifacts/zaimanhua/', import.meta.url);
  await mkdir(directory, {recursive: true});
  await writeFile(new URL('http.json', directory), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}, 120000);
