// Public read-only source verification. No credentials, model calls or signed CDN URLs are logged.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.cwd(), base = path.join(root, 'artifacts/heros/http');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, lib: {entry: path.join(root, 'apps/extension/src/sources/sites/heros/network.ts'),
    formats: ['es'], fileName: () => 'network.mjs'},
}});
const {network} = await import(pathToFileURL(path.join(out, 'network.mjs')).href);
let requests = 0;
const started = performance.now();
const context = {request: async (url, options) => {
  assert.equal(new URL(url).origin, 'https://heros-web.com');
  requests++;
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  assert(response.ok || options?.acceptStatuses?.includes(response.status), `Source HTTP ${response.status}`);
  return response.text();
}};
const results = [];
try {
  const queries = process.env.HEROS_SEARCH_QUERIES?.split(',') ?? ['クウガ', 'ULTRAMAN'];
  for (const query of queries) {
    const hits = await network.search({siteId: 'heros', query}, context);
    assert(hits.items.length > 0, 'Expected live search results');
    const hit = hits.items[0], catalog = await network.catalog(hit.catalogUrl, context);
    assert(catalog.complete && catalog.id === hit.catalogId && catalog.entries.length > 0);
    assert.equal(new Set(catalog.entries.map(entry => entry.id)).size, catalog.entries.length);
    assert(catalog.entries.every(entry => entry.catalogId === catalog.id));
    const entry = catalog.entries.find(entry => entry.readable !== false);
    assert(entry, 'Expected a publicly readable episode');
    const resolved = await network.resolveCatalog(entry.url.split('#')[0], context);
    const owned = await network.catalog(resolved, context);
    assert.equal(owned.id, catalog.id);
    assert.equal(new Set(owned.entries.map(entry => entry.id)).size, catalog.entries.length);
    const pages = await network.pages(entry.url, context);
    assert(pages.discoveryComplete && pages.items.length > 0 && pages.items.length === pages.knownTotal);
    assert.equal(new Set(pages.items.map(page => page.id)).size, pages.items.length);
    const first = pages.items[0];
    assert.equal(first.resource.kind, 'http');
    // Match the public image pipeline's default strict-origin-when-cross-origin Referer.
    const image = await fetch(first.resource.url, {headers: {Referer: 'https://heros-web.com/'},
      signal: AbortSignal.timeout(30000)});
    assert(image.ok && image.headers.get('content-type')?.startsWith('image/'), `Page HTTP ${image.status}`);
    const imageBytes = (await image.arrayBuffer()).byteLength;
    assert(imageBytes > 1000);
    assert(catalog.cover?.url, 'Expected dedicated work artwork');
    const cover = await fetch(catalog.cover.url, {signal: AbortSignal.timeout(30000)});
    assert(cover.ok && cover.headers.get('content-type')?.startsWith('image/'), `Cover HTTP ${cover.status}`);
    const coverBytes = (await cover.arrayBuffer()).byteLength;
    assert(coverBytes > 1000);
    results.push({query, catalogId: catalog.id, entries: catalog.entries.length,
      pages: pages.items.length,
      processing: first.resource.processing?.split(':')[0] ?? null, imageBytes, coverBytes});
  }
  const empty = await network.search({siteId: 'heros', query: 'zzqv987654nonexistent'}, context);
  assert.deepEqual(empty.items, []);
  const broad = await network.search({siteId: 'heros', query: 'の'}, context);
  assert(broad.nextCursor, 'Expected pagination in broad title search');
  const next = await network.search({siteId: 'heros', query: 'の', cursor: broad.nextCursor}, context);
  // Source ranking can move equal-ranked works between requests; the search session deduplicates by identity.
  assert(next.items.length && next.items.some(hit => !broad.items.some(first => first.catalogId === hit.catalogId)));
  const overlap = next.items.filter(hit => broad.items.some(first => first.catalogId === hit.catalogId)).length;
  const result = {status: 'passed', requests, results, searchPagination: true,
    searchPageOverlap: overlap, elapsedMs: Math.round(performance.now() - started), liveSource: true, liveProvider: false};
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({out, ...result}, null, 2));
} catch (error) {
  const message = String(error.message).replace(/https?:\/\/[^\s"']+/g, '[source URL]');
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', requests, results,
    error: message, liveSource: true, liveProvider: false}, null, 2));
  console.log(JSON.stringify({out, requests, error: message}, null, 2));
  throw Error(message);
}
