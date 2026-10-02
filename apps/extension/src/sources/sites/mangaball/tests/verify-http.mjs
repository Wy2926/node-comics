// Read-only public verification. Persist only counts and public catalog IDs, never artwork or download URLs.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.cwd(), base = path.join(root, 'artifacts/mangaball/http');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, lib: {entry: path.join(root, 'apps/extension/src/sources/sites/mangaball/network.ts'), formats: ['es'], fileName: () => 'network.mjs'},
}});
const {network} = await import(pathToFileURL(path.join(out, 'network.mjs')).href);
let requests = 0;
const requestFacts = [];
const context = {request: async url => {
  assert.equal(new URL(url).origin, 'https://api.mangaball.com'); requests++;
  const requestUrl = new URL(url), startedAt = performance.now();
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  requestFacts.push({kind: requestUrl.pathname.includes('/title/detail/') ? 'title' : requestUrl.pathname.endsWith('/chapter-listing') ? 'listing' : 'other',
    page: requestUrl.pathname.endsWith('/chapter-listing') ? Number(requestUrl.searchParams.get('page')) : undefined, startedAt, status: response.status});
  if (!response.ok) {
    const value = response.headers.get('retry-after'), seconds = value && (/^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - Date.now()) / 1000);
    const retryAfter = Number.isFinite(seconds) ? Math.min(3600, Math.max(1, Math.ceil(seconds))) : undefined;
    await response.body?.cancel();
    throw Object.assign(Error(`HTTP ${response.status}`), {details: {status: response.status, retryAfter}});
  }
  return response.text();
}};
const request = {siteId: 'mangaball', query: 'Naruto'};
const hits = await network.search(request, context);
assert(hits.items.length && hits.nextCursor);
const next = await network.search({...request, cursor: hits.nextCursor}, context);
assert(next.items.length && next.items.every(hit => !hits.items.some(previous => previous.catalogId === hit.catalogId)));
// Exercise migrated scalar language fields alongside current array-valued records.
const migrated = await network.search({siteId: 'mangaball', query: 'About Teddy Bear'}, context);
assert(migrated.items.some(hit => hit.catalogId === 'mangaball:685205eb68c513c5035d68c5'));
const results = [];
for (const url of (process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://mangaball.com/title-detail/69353ae375f730006ef9b0c9',
  'https://mangaball.com/title-detail/685205eb68c513c5035d68c5',
  'https://mangaball.com/title-detail/68515613702284f834178653',
])) {
  const firstRequest = requestFacts.length, catalogStartedAt = performance.now();
  const catalog = await network.catalog(url, context);
  const catalogElapsedMs = Math.round(performance.now() - catalogStartedAt), catalogFacts = requestFacts.slice(firstRequest);
  const listingPageAttempts = {};
  for (const fact of catalogFacts) if (fact.kind === 'listing') listingPageAttempts[fact.page] = (listingPageAttempts[fact.page] ?? 0) + 1;
  const minRequestStartGapMs = Math.round(Math.min(...catalogFacts.slice(1).map((fact, index) => fact.startedAt - catalogFacts[index].startedAt)));
  assert(minRequestStartGapMs >= 490, 'Catalog API requests must be spaced by at least 500ms (timer precision tolerance 10ms)');
  const catalogRequests = {elapsedMs: catalogElapsedMs, attempts: catalogFacts.length, minRequestStartGapMs,
    rateLimitResponses: catalogFacts.filter(fact => fact.status === 429).length, listingPageAttempts};
  assert(catalog.complete && catalog.entries.length && catalog.cover);
  assert.equal(new Set(catalog.entries.map(row => row.id)).size, catalog.entries.length);
  const entry = catalog.entries.find(row => row.readable !== false); assert(entry);
  assert.equal(await network.resolveCatalog(entry.url.split('#')[0], context), catalog.url);
  const pages = await network.pages(entry.url, context);
  assert(pages.discoveryComplete && pages.items.length === pages.knownTotal);
  const image = await fetch(pages.items[0].resource.url, {signal: AbortSignal.timeout(30000), headers: {Referer: 'https://mangaball.com/'}});
  const imageResponse = image.ok && image.headers.get('content-type')?.startsWith('image/') === true;
  const imageBytes = imageResponse ? (await image.arrayBuffer()).byteLength : 0;
  if (imageResponse) assert(imageBytes > 1000); else await image.body?.cancel();
  const rawNodeImageProbe = {status: image.status, isImageResponse: imageResponse, bytes: imageBytes, contentType: image.headers.get('content-type'),
    cfMitigated: image.headers.get('cf-mitigated'), server: image.headers.get('server')};
  const cover = await fetch(catalog.cover.url, {signal: AbortSignal.timeout(30000), headers: {Referer: 'https://mangaball.com/'}});
  // Node's TLS/request context differs from Chromium. A denial here says nothing about extension cover access.
  const isImageResponse = cover.ok && cover.headers.get('content-type')?.startsWith('image/') === true;
  const bytes = isImageResponse ? (await cover.arrayBuffer()).byteLength : 0;
  if (isImageResponse) assert(bytes > 1000); else await cover.body?.cancel();
  const rawNodeCoverProbe = {status: cover.status, isImageResponse, bytes, contentType: cover.headers.get('content-type'),
    cfMitigated: cover.headers.get('cf-mitigated'), cfCacheStatus: cover.headers.get('cf-cache-status'), server: cover.headers.get('server')};
  results.push({catalogId: catalog.id, entries: catalog.entries.length, slots: new Set(catalog.entries.map(row => row.readingSlotId)).size,
    languages: [...new Set(catalog.entries.map(row => row.contentLanguage))], pages: pages.items.length, catalogRequests, rawNodeImageProbe, rawNodeCoverProbe});
}
const empty = await network.search({siteId: 'mangaball', query: 'zzqv987654nonexistent'}, context);
assert.deepEqual(empty.items, []);
// Public chapter fixture with ordinal-only filenames: metadata and directory must still bind the title and release.
const ordinalChapterId = '685341f06c8186610a00b5c0', ordinalTitleId = '68515613702284f834178653';
const ordinalPages = await network.pages('https://mangaball.com/chapter-detail/' + ordinalChapterId + '#nodelane-mangaball=' + ordinalTitleId, context);
assert(ordinalPages.discoveryComplete); assert.equal(ordinalPages.items.length, 10); assert.equal(ordinalPages.knownTotal, 10);
assert(ordinalPages.title.startsWith('Ch. 1.1'));
assert(ordinalPages.items.every((row, index) => new URL(row.resource.url).pathname.endsWith('/' + String(index + 1).padStart(3, '0') + '.webp')));
const result = {status: 'passed', validationScope: {publicApi: true, nodeImageProbes: true, browserImages: false}, requests,
  searchResults: hits.items.length + next.items.length + migrated.items.length, results,
  ordinalFilenameChapter: {titleId: ordinalTitleId, chapterId: ordinalChapterId, chapterNumber: '1.1', pages: ordinalPages.items.length}};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({out, ...result}, null, 2));
