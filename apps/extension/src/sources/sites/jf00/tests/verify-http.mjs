// From repository root. Public source/CDN requests only; no product API or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = process.cwd(), base = path.join(root, 'artifacts/jf00/http');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: out, emptyOutDir: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/jf00/network.ts'), formats: ['es'], fileName: () => 'network.mjs'}}});
const {network} = await import(pathToFileURL(path.join(out, 'network.mjs')).href);
let requests = 0;
async function request(url) {
  assert.equal(new URL(url).origin, 'https://www.00jf.com'); requests++;
  const response = await fetch(url, {headers: {'User-Agent': 'Mozilla/5.0'}, signal: AbortSignal.timeout(30000)});
  assert(response.ok, `Source HTTP ${response.status}`); return response.text();
}
const query = {siteId: 'jf00', query: '一人'}, first = await network.search(query, {request});
assert.equal(first.items.length, 30); assert(first.nextCursor);
const second = await network.search({...query, cursor: first.nextCursor}, {request}); assert(second.items.length > 0 && !second.nextCursor);
const exact = await network.search({siteId: 'jf00', query: '一人之下'}, {request});
const hit = exact.items.find(row => row.title === '一人之下'); assert(hit);
const catalog = await network.catalog(hit.catalogUrl, {request}); assert(catalog.complete && catalog.entries.length >= 800);
const native = JSON.parse(await request('https://www.00jf.com/api/comic/chapter?mid=13871'));
assert.equal(native.code, 1); assert.deepEqual(native.data.map(row => String(row.id)), catalog.entries.map(row => row.remoteId));
const large = await network.catalog('https://www.00jf.com/comic_13824.html', {request}); assert(large.complete && large.entries.length > 3800);
const pages = await network.pages(catalog.entries[0].url, {request}); assert(pages.discoveryComplete && pages.items.length === 18);
const short = await network.catalog('https://www.00jf.com/comic_81629.html', {request}); assert(short.complete && short.entries.length === 1);
const shortPages = await network.pages(short.entries[0].url, {request}); assert(shortPages.discoveryComplete && shortPages.items.length >= 20);
const empty = await network.search({siteId: 'jf00', query: 'zzqv987654nonexistent'}, {request}); assert.deepEqual(empty.items, []);
const bytes = [];
for (const url of [catalog.cover.url, pages.items[0].resource.url, short.cover.url, shortPages.items.at(-1).resource.url]) {
  const response = await fetch(url, {headers: {'User-Agent': 'Mozilla/5.0', Referer: 'https://www.00jf.com/'}, signal: AbortSignal.timeout(30000)});
  assert(response.ok && response.headers.get('content-type')?.startsWith('image/')); bytes.push((await response.arrayBuffer()).byteLength);
}
const result = {status: 'passed', requests, search: first.items.length + second.items.length, entries: catalog.entries.length,
  largeEntries: large.entries.length, pages: pages.items.length, shortEntries: short.entries.length, shortPages: shortPages.items.length, bytes};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({out, ...result}));
