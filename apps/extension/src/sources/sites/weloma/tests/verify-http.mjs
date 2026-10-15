// Bounded public HTTP samples; no source scripts, credentials or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = process.cwd(), base = path.join(root, 'artifacts/weloma/http');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, publicDir: false, logLevel: 'error', build: {outDir: out, emptyOutDir: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/weloma/network.ts'), formats: ['es'], fileName: () => 'probe.mjs'}}});
const {network} = await import(pathToFileURL(path.join(out, 'probe.mjs')).href);
let requests = 0;
const context = {request: async url => {
  assert.equal(new URL(url).origin, 'https://weloma.net'); requests++;
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  assert(response.ok, `Source HTTP ${response.status}`); return response.text();
}};
const image = async (url, referer) => {
  const response = await fetch(url, {headers: {Referer: referer}, signal: AbortSignal.timeout(30000)});
  assert(response.ok, `Image HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer()); assert(bytes.length > 1000);
  assert(response.headers.get('content-type')?.startsWith('image/'));
  return {host: new URL(url).hostname, bytes: bytes.length};
};
const works = [];
for (const work of ['0zlfF', '0Yoyn']) {
  const catalog = await network.catalog('https://weloma.net/m/' + work, context), chapters = [];
  assert(catalog.complete && catalog.entries.length > 0);
  for (const entry of [catalog.entries[0], catalog.entries.at(-1)].filter((e, i, all) => all.findIndex(a => a.id === e.id) === i)) {
    const pages = await network.pages(entry.url, context); assert(pages.discoveryComplete && pages.items.length > 0);
    const bare = entry.url.split('#')[0]; assert.equal(await network.resolveCatalog(bare, context), catalog.url);
    chapters.push({id: entry.id, pages: pages.items.length, image: await image(pages.items[0].resource.url, bare)});
  }
  works.push({id: catalog.id, entries: catalog.entries.length, cover: await image(catalog.cover.url, catalog.url), chapters});
}
const query = {siteId: 'weloma', query: 'isekai'}, first = await network.search(query, context);
assert(first.items.length > 0 && first.nextCursor);
const second = await network.search({...query, cursor: first.nextCursor}, context);
assert(second.items.length > 0 && second.items[0].catalogId !== first.items[0].catalogId);
const empty = await network.search({...query, query: 'NodeLaneFixtureNoSuchTitle987654'}, context); assert.equal(empty.items.length, 0);
const result = {works, search: {first: first.items.length, second: second.items.length, empty: empty.items.length}, requests,
  boundary: 'Real HTTP and image bytes; installed MV3 decoding/reading and model effects are separate checks.'};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({out, ...result}, null, 2));
