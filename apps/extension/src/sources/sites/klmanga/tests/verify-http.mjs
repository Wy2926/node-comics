// Real public source/CDN only; no credentials, product API or translation models.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/klmanga/http');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/');
const probe = path.join(out, 'probe.mjs');
await writeFile(probe, `export {network} from '${source}/sources/sites/klmanga/network.ts';
  export {definition} from '${source}/sources/sites/klmanga/definition.ts';
  export {validateCatalog} from '${source}/sources/core/catalog.ts';
  export {validatePages} from '${source}/sources/core/pages.ts';
  export {imageMimeFromBytes} from '${source}/comics/formats/identify.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'probe-built.mjs'},
}});
const {network, definition, validateCatalog, validatePages, imageMimeFromBytes} =
  await import(pathToFileURL(path.join(out, 'probe-built.mjs')).href);
let requests = 0, formRequests = 0, imageRequests = 0;
// Native fetch keeps TLS verification enabled and bounds each request/body.
async function readHttp(url, {referer, form, timeout = 30} = {}) {
  const target = new URL(url);
  assert(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password);
  const headers = {'User-Agent': 'Mozilla/5.0'};
  if (referer) headers.Referer = referer.split('#')[0];
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  const response = await fetch(target, {
    method: form ? 'POST' : 'GET', headers, body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(timeout * 1000),
  });
  assert(response.ok, `Source HTTP ${response.status}`);
  assert(response.body, 'Source HTTP body is missing');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > 64 * 1024 * 1024) {
        await reader.cancel(); throw Error('HTTP body exceeds validation budget');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {reader.releaseLock();}
}
const request = async (url, options) => {
  assert.equal(new URL(url).origin, 'https://klmanga.zone');
  requests++; if (options?.form) formRequests++;
  return (await readHttp(url, options)).toString('utf8');
};
async function readImage(url, referer) {
  imageRequests++;
  const bytes = await readHttp(url, {referer, timeout: 60}), mime = imageMimeFromBytes(bytes);
  assert(bytes.length > 1000 && mime, 'Source body is not a recognized image');
  return {host: new URL(url).host, mime, bytes: bytes.length};
}
const onePieceCatalog = 'https://klmanga.zone/manga-raw/' + encodeURIComponent('ワンピース-raw-free') + '/';
const samples = process.env.KLMANGA_CATALOG_URL ? [process.env.KLMANGA_CATALOG_URL] : [
  'https://klmanga.zone/manga-raw/hunter-x-hunter-raw-free/',
  'https://klmanga.zone/manga-raw/御子神かれんの隠しごと-raw-free/',
  onePieceCatalog,
];
const started = Date.now(), works = [], failures = [];
for (const url of samples) {
  const work = {url, chapters: []}; works.push(work);
  try {
    const catalog = validateCatalog(await network.catalog(url, {request}), [definition]);
    assert(catalog.complete && catalog.entries.length > 0);
    Object.assign(work, {title: catalog.title, entries: catalog.entries.length});
    assert(catalog.cover); work.cover = await readImage(catalog.cover.url, catalog.url);
    // ONE PIECE's default first chapter exercises a complete multi-batch import.
    // Recent/decimal releases also retain coverage of merged images and source labels.
    const selected = new Map();
    const readable = catalog.entries.filter(entry => entry.readable !== false);
    const first = catalog.url === onePieceCatalog ? readable.find(entry => entry.id === catalog.defaultEntryId) : undefined;
    for (const entry of [first, readable.at(-1), readable.at(-2), [...readable].reverse().find(entry => /\d[.．]\d/.test(entry.title))].filter(Boolean))
      selected.set(entry.id, entry);
    assert(selected.size > 0, 'Catalog has no readable chapters');
    let fullChapter = true;
    for (const entry of selected.values()) {
      const before = requests, beforeForms = formRequests, chapterStarted = Date.now();
      const location = definition.identify(new URL(entry.url));
      assert.equal(location?.catalog?.key, catalog.id);
      const pages = validatePages(await network.pages(entry.url, {request}), location);
      assert(pages.discoveryComplete && pages.knownTotal > 0 && pages.knownTotal === pages.items.length);
      const indices = fullChapter ? pages.items.map((_, index) => index)
        : [...new Set([0, Math.floor(pages.items.length / 2), pages.items.length - 1])];
      const images = [];
      for (const index of indices) images.push({page: index + 1, ...await readImage(pages.items[index].resource.url, entry.url)});
      work.chapters.push({title: entry.title, pages: pages.items.length, allImagesRead: fullChapter, requests: requests - before,
        formRequests: formRequests - beforeForms, defaultEntry: entry.id === catalog.defaultEntryId,
        elapsedMs: Date.now() - chapterStarted, images});
      fullChapter = false;
    }
    work.status = 'passed';
  } catch (error) {work.status = 'failed'; work.error = error.message; failures.push({url, error: error.message});}
  console.log(JSON.stringify({status: work.status, title: work.title, entries: work.entries, chapters: work.chapters.length, error: work.error}));
}
let search;
try {
  const found = await network.search({siteId: 'klmanga', query: process.env.KLMANGA_SEARCH_QUERY || 'キングダム'}, {request});
  const empty = await network.search({siteId: 'klmanga', query: 'NodeLaneFixtureNoSuchTitle'}, {request});
  assert(found.items.length > 0); assert.equal(empty.items.length, 0);
  assert(found.items.every(hit => definition.identify(new URL(hit.catalogUrl))?.kind === 'catalog'));
  search = {hits: found.items.length, empty: empty.items.length};
} catch (error) {failures.push({search: true, error: error.message});}
const result = {status: failures.length ? 'failed' : 'passed', works, search, failures,
  requests, formRequests, imageRequests, elapsedMs: Date.now() - started, liveSource: true, liveProvider: false};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({out, ...result}, null, 2));
if (failures.length) process.exitCode = 1;
