// Public source/CDN requests only. No credentials, product API or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/mangapill/http');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.mjs');
await writeFile(probe, `export {network} from '${source}/sources/sites/mangapill/network.ts';
export {definition} from '${source}/sources/sites/mangapill/definition.ts';
export {validateCatalog} from '${source}/sources/core/catalog.ts';
export {validatePages} from '${source}/sources/core/pages.ts';
export {imageMimeFromBytes} from '${source}/comics/formats/identify.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'probe-built.mjs'},
}});
const {network, definition, validateCatalog, validatePages, imageMimeFromBytes} = await import(pathToFileURL(path.join(out, 'probe-built.mjs')).href);
let requests = 0, imageRequests = 0;
const request = async (url, options) => {
  assert.equal(new URL(url).origin, 'https://mangapill.com'); requests++;
  // Match production HTML transport: source redirects must be resolved by the adapter.
  const response = await fetch(url, {redirect: 'error', headers: {'User-Agent': 'Mozilla/5.0', ...(options?.referer ? {Referer: options.referer} : {})}, signal: AbortSignal.timeout(30000)});
  assert(response.ok, `Source HTTP ${response.status}`); return response.text();
};
async function readImage(url, referer) {
  imageRequests++;
  const response = await fetch(url, {headers: {'User-Agent': 'Mozilla/5.0', Referer: referer}, signal: AbortSignal.timeout(60000)});
  assert(response.ok, `Image HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()), mime = imageMimeFromBytes(bytes);
  assert(bytes.length > 1000 && mime, 'Body is not a recognized original image');
  return {host: new URL(url).hostname, suffix: path.extname(new URL(url).pathname), mime, bytes: bytes.length};
}
const samples = process.env.MANGAPILL_CATALOG_URL ? [process.env.MANGAPILL_CATALOG_URL] : [
  'https://mangapill.com/manga/2/one-piece',
  'https://mangapill.com/manga/1/berserk',
  'https://mangapill.com/manga/5454/choujin-x',
  'https://mangapill.com/manga/5677/look-back',
];
const works = new Array(samples.length), failures = [], started = Date.now();
async function verifyWork(url, index) {
  const work = {url, status: 'running', chapters: []}; works[index] = work;
  try {
    const catalog = validateCatalog(await network.catalog(url, {request}), [definition]);
    assert(catalog.complete && catalog.entries.length > 0 && catalog.groups.every(group => group.complete));
    assert.equal(definition.identify(new URL(catalog.url))?.catalog?.key, catalog.id);
    Object.assign(work, {catalogId: catalog.id, title: catalog.title, entries: catalog.entries.length,
      groups: catalog.groups.map(group => ({id: group.id, title: group.title, entries: group.entryIds.length})),
      sequences: [...new Set(catalog.entries.map(entry => entry.sequenceId))]});
    const originalChapter = new URL(catalog.entries[0].url); originalChapter.hash = '';
    const beforeResolve = requests;
    const resolved = await network.resolveCatalog(originalChapter.href, {request});
    assert.equal(definition.identify(new URL(resolved))?.catalog?.key, catalog.id);
    assert.equal(resolved, catalog.url);
    work.resolution = {chapter: originalChapter.href, catalog: resolved, requests: requests - beforeResolve};
    const selected = new Map();
    const entriesById = new Map(catalog.entries.map(entry => [entry.id, entry]));
    for (const group of catalog.groups) {
      const entries = group.entryIds.map(id => entriesById.get(id));
      for (const entry of entries.length ? [entries[0], entries[Math.floor(entries.length / 2)], entries.at(-1)] : []) selected.set(entry.id, entry);
    }
    const fractional = catalog.entries.filter(entry => /\bChapter\s+\d+\.\d+\b/i.test(entry.title));
    work.fractionalEntries = fractional.length;
    for (const entry of fractional.length ? [fractional[0], fractional.at(-1)] : []) selected.set(entry.id, entry);
    for (const entry of selected.values()) {
      const chapter = {entryId: entry.id, title: entry.title, url: entry.url}; work.chapters.push(chapter);
      try {
        const location = definition.identify(new URL(entry.url)); assert.equal(location?.pageKey, entry.id);
        const snapshot = validatePages(await network.pages(entry.url, {request}), location);
        assert(snapshot.discoveryComplete && snapshot.items.length > 0);
        chapter.pages = snapshot.items.length;
        chapter.imageHosts = [...new Set(snapshot.items.map(item => new URL(item.resource.url).hostname))];
        chapter.images = [];
        for (const page of new Set([0, Math.floor(snapshot.items.length / 2), snapshot.items.length - 1]))
          chapter.images.push({page: page + 1, ...await readImage(snapshot.items[page].resource.url, entry.url)});
        chapter.status = 'passed';
      } catch (error) {chapter.status = 'failed'; chapter.error = error.message; failures.push({catalogId: catalog.id, entryId: entry.id, error: error.message});}
    }
    assert(catalog.cover, 'Dedicated work cover is missing');
    work.cover = await readImage(catalog.cover.url, catalog.url);
    work.status = work.chapters.every(chapter => chapter.status === 'passed') ? 'passed' : 'failed';
  } catch (error) {work.status = 'failed'; work.error = error.message; failures.push({url, error: error.message});}
  console.log(JSON.stringify({work: index + 1, total: samples.length, status: work.status, entries: work.entries,
    chapters: work.chapters.length, pages: work.chapters.reduce((sum, chapter) => sum + (chapter.pages || 0), 0), error: work.error}));
}
let next = 0;
await Promise.all(Array.from({length: Math.min(2, samples.length)}, async () => {
  while (next < samples.length) {const index = next++; await verifyWork(samples[index], index);}
}));
let search;
try {
  const query = {siteId: 'mangapill', query: 'one'};
  const found = await network.search(query, {request}); assert(found.items.length > 0);
  const second = found.nextCursor ? await network.search({...query, cursor: found.nextCursor}, {request}) : null;
  if (second) assert(second.items.length > 0);
  const empty = await network.search({siteId: 'mangapill', query: 'NodeLaneFixtureNoSuchTitle987654'}, {request});
  assert.equal(empty.items.length, 0);
  search = {status: 'passed', firstPage: found.items.length, secondPage: second?.items.length, empty: empty.items.length};
} catch (error) {search = {status: 'failed', error: error.message}; failures.push(search);}
const chapters = works.flatMap(work => work.chapters), images = chapters.flatMap(chapter => chapter.images || []);
const result = {status: failures.length ? 'failed' : 'passed', summary: {
  works: works.length, passedWorks: works.filter(work => work.status === 'passed').length,
  entries: works.reduce((sum, work) => sum + (work.entries || 0), 0), chapters: chapters.length,
  passedChapters: chapters.filter(chapter => chapter.status === 'passed').length,
  manifestPages: chapters.reduce((sum, chapter) => sum + (chapter.pages || 0), 0),
  transferredImages: images.length, imageBytes: images.reduce((sum, image) => sum + image.bytes, 0),
  imageHosts: [...new Set(chapters.flatMap(chapter => chapter.imageHosts || []))], imageMimes: [...new Set(images.map(image => image.mime))],
  requests, imageRequests, elapsedMs: Date.now() - started,
}, search, works, failures, liveSource: true, liveProvider: false,
boundary: 'Real public full catalogs, selected chapter manifests and sampled original image bytes. Browser decoding, permissions and model effects require separate verification.'};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({out, status: result.status, summary: result.summary, failures}, null, 2));
if (failures.length) process.exitCode = 1;
