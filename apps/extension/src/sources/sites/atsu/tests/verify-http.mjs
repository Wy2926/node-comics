// Read-only public API and CDN probe. No accounts, cookies, token extraction or model requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.cwd(), out = path.join(root, 'artifacts/atsu/http');
await mkdir(out, {recursive: true});
const temporary = await mkdtemp(path.join(out, 'probe-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: temporary, emptyOutDir: false, lib: {entry: path.join(root, 'apps/extension/src/sources/sites/atsu/network.ts'), formats: ['es'], fileName: () => 'network.mjs'},
}});
const {network} = await import(pathToFileURL(path.join(temporary, 'network.mjs')).href);
const userAgent = process.env.ATSU_HTTP_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
let requests = 0;
const context = {request: async (target, options) => {
  assert.equal(new URL(target).origin, 'https://atsu.moe'); requests++;
  const response = await fetch(target, {headers: {Accept: 'application/json', 'User-Agent': userAgent, Referer: options.referer}, signal: AbortSignal.timeout(30000)});
  assert(response.ok, `Atsumaru API HTTP ${response.status}`); return response.text();
}};
async function image(url, referer) {
  assert.equal(new URL(url).origin, 'https://cdn.atsu.moe');
  const response = await fetch(url, {headers: {'User-Agent': userAgent, Referer: referer}, signal: AbortSignal.timeout(30000)});
  assert(response.ok, `Atsumaru image HTTP ${response.status}`);
  assert.match(response.headers.get('content-type') ?? '', /^image\//);
  const bytes = (await response.arrayBuffer()).byteLength; assert(bytes > 0); return bytes;
}
const source = await network.catalog(process.env.ATSU_CATALOG_URL || 'https://atsu.moe/manga/RkOOE', context);
assert(source.complete && source.groups.every(group => group.complete));
assert(source.entries.length > 0, 'Public source catalog has no chapter entries');
assert.equal(new Set(source.entries.map(entry => entry.id)).size, source.entries.length);
const readable = source.entries.filter(entry => entry.readable !== false);
assert(readable.length > 0, 'Public source catalog has no readable chapter entries');
const selected = new Map();
for (const group of source.groups) {
  const entries = readable.filter(entry => group.entryIds.includes(entry.id));
  for (const entry of entries.length ? [entries[0], entries.at(-1)] : []) selected.set(entry.id, {entry, groupId: group.id});
}
assert(selected.size > 0, 'Readable source chapters have no release groups');
const chapters = [];
for (const {entry, groupId} of selected.values()) {
  const snapshot = await network.pages(entry.url, context);
  assert(snapshot.discoveryComplete && snapshot.knownTotal > 0);
  assert.equal(snapshot.knownTotal, snapshot.items.length);
  assert(snapshot.items.every((item, index) => item.order === index));
  assert(snapshot.items.every(item => item.resource.kind === 'http'));
  assert.equal(new Set(snapshot.items.map(item => item.id)).size, snapshot.items.length);
  chapters.push({chapterId: entry.id, groupId, title: entry.title, pages: snapshot.knownTotal,
    firstImageBytes: await image(snapshot.items[0].resource.url, entry.url)});
}
assert(source.cover, 'Public source catalog has no dedicated cover');
const coverBytes = await image(source.cover.url, source.url);
const request = {siteId: 'atsu', query: source.title}, first = await network.search(request, context);
assert(first.items.some(hit => hit.catalogId === source.id));
assert(first.items.every(hit => hit.contentLanguages === undefined));
const broad = {siteId: 'atsu', query: 'love'}, broadFirst = await network.search(broad, context);
assert(broadFirst.nextCursor);
const second = await network.search({...broad, cursor: broadFirst.nextCursor}, context);
assert(second.items.length > 0);
assert(second.items.every(hit => !broadFirst.items.some(previous => previous.catalogId === hit.catalogId)));
const empty = await network.search({siteId: 'atsu', query: 'zzqv987654321nonexistentmanga'}, context);
assert.equal(empty.items.length, 0);
const report = {catalogId: source.id, releases: source.entries.length, groups: source.groups.length, chapters, coverBytes,
  search: {titleMatches: first.items.length, pagination: [broadFirst.items.length, second.items.length], empty: empty.items.length}, requests,
  boundary: 'Live public HTTP and CDN image transfer; no installed extension, browser decoding, permission revocation, source login or translation model validation.'};
await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
