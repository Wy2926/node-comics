// Public source/CDN requests only. No cookies, product API or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = process.cwd(), base = path.join(root, 'artifacts/rawotaku/http');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: out, emptyOutDir: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/rawotaku/network.ts'), formats: ['es'], fileName: () => 'network.mjs'}}});
const {network} = await import(pathToFileURL(path.join(out, 'network.mjs')).href);
let requests = 0;
const request = async (url, options) => {
  assert.equal(new URL(url).origin, 'https://rawotaku.com'); requests++;
  const response = await fetch(url, {headers: {'User-Agent': 'Mozilla/5.0', ...(options?.referer ? {Referer: options.referer} : {})}, signal: AbortSignal.timeout(30000)});
  assert(response.ok, `Source HTTP ${response.status}`); return response.text();
};
const catalog = await network.catalog(process.env.RAWOTAKU_CATALOG_URL || 'https://rawotaku.com/read/ブルーロック-raw/', {request});
assert(catalog.complete && catalog.entries.length > 0 && catalog.cover);
const first = catalog.entries[0], latest = catalog.entries.at(-1);
const chapters = [];
for (const entry of [first, latest]) {
  const snapshot = await network.pages(entry.url, {request});
  assert(snapshot.discoveryComplete && snapshot.knownTotal === snapshot.items.length && snapshot.items.length > 0);
  const response = await fetch(snapshot.items[0].resource.url, {headers: {Referer: entry.url}, signal: AbortSignal.timeout(30000)});
  assert(response.ok && response.headers.get('content-type')?.startsWith('image/'));
  const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length > 1000);
  chapters.push({entryId: entry.id, pages: snapshot.items.length, firstImageBytes: bytes.length});
}
const artwork = await fetch(catalog.cover.url, {signal: AbortSignal.timeout(30000)});
assert(artwork.ok && artwork.headers.get('content-type')?.startsWith('image/'));
const found = await network.search({siteId: 'rawotaku', query: 'blue'}, {request}); assert(found.items.length > 0);
const empty = await network.search({siteId: 'rawotaku', query: 'NodeLaneFixtureNoSuchTitle'}, {request}); assert.equal(empty.items.length, 0);
const result = {status: 'passed', chapters, entries: catalog.entries.length, groups: catalog.groups.length,
  cover: true, searchHits: found.items.length, requests, liveSource: true, liveProvider: false};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({out, ...result}, null, 2));
