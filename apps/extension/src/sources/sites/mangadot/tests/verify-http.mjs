// Public read-only API probe. No login, cookies, token extraction or model requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.cwd(), out = path.join(root, 'artifacts/mangadot/http');
await mkdir(out, {recursive: true});
const temporary = await mkdtemp(path.join(out, 'probe-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: temporary, emptyOutDir: false, lib: {entry: path.join(root, 'apps/extension/src/sources/sites/mangadot/network.ts'), formats: ['es'], fileName: () => 'network.mjs'},
}});
const {network} = await import(pathToFileURL(path.join(temporary, 'network.mjs')).href);
// Node's default User-Agent is challenged; the extension uses its native browser UA.
const userAgent = process.env.MANGADOT_HTTP_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
let requests = 0;
const context = {request: async (target, options) => {
  assert.equal(new URL(target).origin, 'https://mangadot.net'); requests++;
  const response = await fetch(target, {headers: {Accept: 'application/json, text/html', 'User-Agent': userAgent, Referer: options.referer}, signal: AbortSignal.timeout(30000)});
  assert(response.ok, `MangaDot API HTTP ${response.status}`);
  return response.text();
}};
async function transfer(url, referer) {
  const response = await fetch(url, {headers: {'User-Agent': userAgent, Referer: referer}, signal: AbortSignal.timeout(30000)});
  assert(response.ok, `MangaDot image HTTP ${response.status}`);
  assert.match(response.headers.get('content-type') ?? '', /^image\//);
  const bytes = (await response.arrayBuffer()).byteLength; assert(bytes > 0); return bytes;
}
const source = await network.catalog('https://mangadot.net/manga/3235', context);
assert(source.complete && source.entries.length > 0);
assert.equal(new Set(source.entries.map(e => e.id)).size, source.entries.length);
const languages = [...new Set(source.entries.map(e => e.contentLanguage))];
assert(languages.includes('en') && languages.includes('fr') && languages.includes('es'));
const english = source.entries.find(e => e.contentLanguage === 'en' && e.id.startsWith('mangadot:scraper:'));
const candidates = [english, ...['fr', 'es'].map(lang => source.entries.find(e => e.contentLanguage === lang && e.readingSlotId === english.readingSlotId)),
  source.entries.find(e => e.id.startsWith('mangadot:user:volume:'))];
const pages = [];
for (const entry of candidates) {
  assert(entry?.readable);
  assert.equal(await network.resolveCatalog(entry.url.split('#')[0], context), source.url);
  const snapshot = await network.pages(entry.url, context);
  assert(snapshot.discoveryComplete && snapshot.knownTotal > 0);
  assert(snapshot.items.every((item, i) => item.id === 'page-' + i && item.order === i));
  pages.push({entryId: entry.id, language: entry.contentLanguage, count: snapshot.knownTotal, firstImageBytes: await transfer(snapshot.items[0].resource.url, entry.url.split('#')[0])});
}
const coverBytes = await transfer(source.cover.url, source.url);
const hits = await network.search({siteId: 'mangadot', query: 'Haimiya'}, context);
assert(hits.items.some(hit => hit.catalogId === source.id));
assert.match(hits.items.find(hit => hit.catalogId === source.id).latestLabel, /^Ch\. -?\d+(?:\.\d+)?$/);
assert(hits.items.every(hit => hit.contentLanguages === undefined));
const broad = {siteId: 'mangadot', query: 'love'}, first = await network.search(broad, context);
assert(first.nextCursor);
const second = await network.search({...broad, cursor: first.nextCursor}, context);
assert(second.items.length > 0);
assert(second.items.every(hit => !first.items.some(previous => previous.catalogId === hit.catalogId)));
const empty = await network.search({siteId: 'mangadot', query: 'zzqv987654321nonexistentmanga'}, context);
assert.equal(empty.items.length, 0);
const report = {catalogId: source.id, releases: source.entries.length, chapterSlots: new Set(source.entries.filter(e => e.groupIds.includes('chapter')).map(e => e.readingSlotId)).size,
  volumes: source.entries.filter(e => e.groupIds.includes('volume')).length, languages, pages, coverBytes,
  search: {matches: hits.items.length, pagination: [first.items.length, second.items.length], empty: empty.items.length}, requests,
  boundary: 'Live HTTP responses and image transfer with browser User-Agent and source Referer; no browser decoding, extension UI, installed permissions or model validation.'};
await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
