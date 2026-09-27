// Public read-only source verification. No credentials, model calls or signed URLs are logged.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.cwd(), base = path.join(root, 'artifacts/sunday-webry/http');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, lib: {entry: path.join(root, 'apps/extension/src/sources/sites/sundaywebry/network.ts'), formats: ['es'], fileName: () => 'network.mjs'},
}});
const {network} = await import(pathToFileURL(path.join(out, 'network.mjs')).href);
let requests = 0;
const context = {request: async (url, options) => {
  assert.equal(new URL(url).origin, 'https://www.sunday-webry.com'); requests++;
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  assert(response.ok || options?.acceptStatuses?.includes(response.status), `HTTP ${response.status}`);
  return response.text();
}};
const results = [];
for (const query of ['コナン', 'フリーレン']) {
  const hits = await network.search({siteId: 'sundaywebry', query}, context); assert(hits.items.length);
  const hit = hits.items.find(hit => hit.title === (query === 'コナン' ? '名探偵コナン' : '葬送のフリーレン')) ?? hits.items[0];
  const catalog = await network.catalog(hit.catalogUrl, context);
  assert(catalog.complete && catalog.id === hit.catalogId && catalog.entries.length);
  assert.equal(new Set(catalog.entries.map(e => e.id)).size, catalog.entries.length);
  const entry = catalog.entries.find(e => e.readable); assert(entry);
  const resolved = await network.resolveCatalog(entry.url.split('#')[0], context);
  assert.equal(new URL(resolved).hash, new URL(catalog.url).hash);
  const pages = await network.pages(entry.url, context);
  assert(pages.discoveryComplete && pages.items.length === pages.knownTotal);
  const image = await fetch(pages.items[0].resource.url, {signal: AbortSignal.timeout(30000)});
  assert(image.ok && image.headers.get('content-type').startsWith('image/'));
  const imageBytes = (await image.arrayBuffer()).byteLength; assert(imageBytes > 1000);
  const cover = await fetch(catalog.cover.url); assert(cover.ok && cover.headers.get('content-type').startsWith('image/'));
  results.push({catalogId: catalog.id, entries: catalog.entries.length, readable: catalog.entries.filter(e => e.readable).length,
    pages: pages.items.length, imageBytes, coverBytes: (await cover.arrayBuffer()).byteLength});
}
const empty = await network.search({siteId: 'sundaywebry', query: 'zzqv987654nonexistent'}, context);
assert.deepEqual(empty.items, []);
await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', requests, results}, null, 2));
console.log(JSON.stringify({out, requests, results}, null, 2));
