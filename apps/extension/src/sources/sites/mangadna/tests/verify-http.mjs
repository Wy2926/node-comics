// Public source/CDN requests. No cookies, product API or translation provider.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {catalogUrls} from './live-samples.mjs';

const root = process.cwd(), base = path.join(root, 'artifacts/mangadna/http');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.mjs');
await writeFile(probe, `export {network} from '${source}/sources/sites/mangadna/network.ts';
  export {definition} from '${source}/sources/sites/mangadna/definition.ts';
  export {validateCatalog} from '${source}/sources/core/catalog.ts';
  export {validatePages} from '${source}/sources/core/pages.ts';
  export {validateSearchPage} from '${source}/sources/core/search.ts';
  export {imageMimeFromBytes} from '${source}/comics/formats/identify.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'probe-built.mjs'},
}});
const {network, definition, validateCatalog, validatePages, validateSearchPage, imageMimeFromBytes} =
  await import(pathToFileURL(path.join(out, 'probe-built.mjs')).href);
let sourceRequests = 0, imageRequests = 0, transportRetries = 0;
async function fetchPublic(url, options) {
  try {return await fetch(url, options);} catch (error) {
    if (!['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code)) throw error;
    transportRetries++;
    return fetch(url, options);
  }
}
async function request(url) {
  assert.equal(new URL(url).origin, 'https://mangadna.com');
  sourceRequests++;
  const response = await fetchPublic(url, {signal: AbortSignal.timeout(30000)});
  assert(response.ok, `Source HTTP ${response.status}`);
  return response.text();
}
async function image(url, referer) {
  imageRequests++;
  const response = await fetchPublic(url, {headers: {Referer: referer}, signal: AbortSignal.timeout(60000)});
  assert(response.ok, `Image HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()), mime = imageMimeFromBytes(bytes);
  assert(bytes.length > 1000 && mime, 'Response is not an original image');
  return {host: new URL(url).hostname, mime, bytes: bytes.length};
}
const samples = process.env.MANGADNA_CATALOG_URL ? [process.env.MANGADNA_CATALOG_URL] : catalogUrls;
const works = new Array(samples.length), failures = [], started = Date.now();
async function verifyWork(url, index) {
  const work = {url, chapters: []}; works[index] = work;
  try {
    const catalog = validateCatalog(await network.catalog(url, {request}), [definition]);
    assert(catalog.complete && catalog.entries.length && catalog.groups.every(g => g.complete));
    work.entries = catalog.entries.length;
    const entries = catalog.entries, selected = new Map();
    const specials = entries.filter(e => !/\/chapter-\d+$/.test(e.url));
    for (const entry of [entries[0], entries[Math.floor(entries.length / 2)], entries.at(-1), specials[0], specials.at(-1)].filter(Boolean))
      selected.set(entry.id, entry);
    for (const entry of selected.values()) {
      const chapter = {entryId: entry.id, images: []}; work.chapters.push(chapter);
      try {
        const loc = definition.identify(new URL(entry.url));
        assert.equal(loc.pageKey, entry.id);
        const pages = validatePages(await network.pages(entry.url, {request}), loc);
        assert(pages.discoveryComplete ? pages.items.length === pages.knownTotal : pages.knownTotal > pages.items.length && pages.note);
        chapter.pages = pages.items.length;
        chapter.complete = pages.discoveryComplete;
        chapter.knownTotal = pages.knownTotal;
        for (const index of new Set([0, Math.floor(pages.items.length / 2), pages.items.length - 1]))
          chapter.images.push({page: index + 1, ...await image(pages.items[index].resource.url, entry.url)});
        chapter.status = 'passed';
      } catch (error) {chapter.status = 'failed'; chapter.error = error.message; failures.push({entryId: entry.id, error: error.message});}
    }
    assert(catalog.cover, 'Dedicated cover missing');
    work.cover = await image(catalog.cover.url, catalog.url);
    work.status = work.chapters.every(c => c.status === 'passed') ? 'passed' : 'failed';
  } catch (error) {work.status = 'failed'; work.error = error.message; failures.push({url, error: error.message});}
  console.log(JSON.stringify({work: index + 1, total: samples.length, status: work.status, entries: work.entries,
    chapters: work.chapters.length, pages: work.chapters.reduce((sum, c) => sum + (c.pages || 0), 0), error: work.error}));
}
let next = 0;
await Promise.all(Array.from({length: Math.min(2, samples.length)}, async () => {
  while (next < samples.length) {const index = next++; await verifyWork(samples[index], index);}
}));
let search;
try {
  const query = 'the', first = validateSearchPage(await network.search({siteId: 'mangadna', query}, {request}), definition, definition.sites[0], [definition]);
  assert(first.items.length > 0 && first.nextCursor);
  const second = validateSearchPage(await network.search({siteId: 'mangadna', query, cursor: first.nextCursor}, {request}), definition, definition.sites[0], [definition]);
  // Source updates can move results between pages; verify that page 2 adds works.
  assert(second.items.some(b => !first.items.some(a => a.catalogId === b.catalogId)));
  const empty = await network.search({siteId: 'mangadna', query: 'NodeLaneFixtureNoSuchTitle'}, {request});
  assert.equal(empty.items.length, 0);
  search = {status: 'passed', first: first.items.length, second: second.items.length, empty: 0};
} catch (error) {search = {status: 'failed', error: error.message}; failures.push(search);}
const chapters = works.flatMap(w => w.chapters), images = chapters.flatMap(c => c.images);
const result = {status: failures.length ? 'failed' : 'passed', summary: {
  works: works.length, passedWorks: works.filter(w => w.status === 'passed').length,
  entries: works.reduce((sum, w) => sum + (w.entries || 0), 0), chapters: chapters.length,
  passedChapters: chapters.filter(c => c.status === 'passed').length, pages: chapters.reduce((sum, c) => sum + (c.pages || 0), 0),
  transferredImages: images.length, imageBytes: images.reduce((sum, i) => sum + i.bytes, 0),
  singlePageChapters: chapters.filter(c => c.pages === 1).length,
  incompleteChapters: chapters.filter(c => c.complete === false).map(c => ({entryId: c.entryId, pages: c.pages, knownTotal: c.knownTotal})),
  imageHosts: [...new Set(images.map(i => i.host))], formats: [...new Set(images.map(i => i.mime))],
  sourceRequests, imageRequests, transportRetries, elapsedMs: Date.now() - started,
}, search, works, failures};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({out, status: result.status, summary: result.summary, search, failures}, null, 2));
if (failures.length) process.exitCode = 1;
