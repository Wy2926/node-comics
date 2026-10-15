// Public HTTP acceptance only. From any directory: node <this-file> [site-id].
// Reads one fixed work/chapter per site; never executes source scripts or calls translation providers.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const extensionRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const root = path.resolve(extensionRoot, '../..');
const samples = [
  {id: 'lagoonscans', origin: 'https://lagoonscans.com', catalogSlug: '30-years-since-the-prologue',
    chapterSlug: '30-years-since-the-prologue-chapter-20', query: 'Prologue', paginationQuery: 'the', minimumEntries: 20, pages: 18},
  {id: 'undertranslations', origin: 'https://undertranslations.com', catalogSlug: 'puedo-pedirle-una-ultima-cosa',
    chapterSlug: 'scarlet-capitulo-478', query: 'última', paginationQuery: 'el', minimumEntries: 49, pages: 25},
  {id: 'arenascans', origin: 'https://arenascan.com', catalogSlug: '100-year-old-top-chef',
    chapterSlug: '100-year-old-top-chef-70', query: '100-Year-Old', paginationQuery: 'chef', minimumEntries: 70, pages: 59},
];
const selectedId = process.argv[2];
assert(process.argv.length <= 3 && (!selectedId || samples.some(sample => sample.id === selectedId)),
  'Usage: node verify-http.mjs [lagoonscans|undertranslations|arenascans]');
const selected = selectedId ? samples.filter(sample => sample.id === selectedId) : samples;
const limits = {timeoutMs: 20000, maxRequestsPerSite: 18, maxHtmlBytes: 2 * 1024 * 1024,
  imagePrefixBytes: 512, maxImageReadBytes: 64 * 1024, maxSiteBytes: 8 * 1024 * 1024, maxRedirects: 3};
const base = path.join(root, 'artifacts/mangathemesia/http');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const source = path.join(extensionRoot, 'src').replaceAll('\\', '/');
const virtualEntry = path.join(extensionRoot, '__mangathemesia_http_probe__.ts').replaceAll('\\', '/');
const {build} = createRequire(path.join(extensionRoot, 'package.json'))('vite');
await build({configFile: false, root: extensionRoot, logLevel: 'error', plugins: [{
  name: 'mangathemesia-http-verification',
  resolveId(id) {if (id.replaceAll('\\', '/') === virtualEntry) return '\0mangathemesia-http-verification';},
  load(id) {
    if (id !== '\0mangathemesia-http-verification') return;
    return selected.map(sample => `import * as ${sample.id}Network from '${source}/sources/sites/${sample.id}/network.ts';
      import {definition as ${sample.id}Definition} from '${source}/sources/sites/${sample.id}/definition.ts';`).join('\n') + `
      export const adapters = {${selected.map(sample => `${sample.id}: {...${sample.id}Network, definition: ${sample.id}Definition}`).join(',')}};
      export {validateCatalog} from '${source}/sources/core/catalog.ts';
      export {validatePages} from '${source}/sources/core/pages.ts';
      export {imageMimeFromBytes} from '${source}/comics/formats/identify.ts';`;
  },
}], build: {outDir: out, emptyOutDir: false,
  lib: {entry: virtualEntry, formats: ['es'], fileName: () => 'probe.mjs'}}});
const {adapters, validateCatalog, validatePages, imageMimeFromBytes} =
  await import(pathToFileURL(path.join(out, 'probe.mjs')).href);
const started = performance.now(), results = [];
const sanitize = error => String(error?.message ?? error).replace(/https?:\/\/[^\s"']+/g, '[source URL]').slice(0, 500);

async function verifySite(sample) {
  const {network, definition, parsePages} = adapters[sample.id];
  const requests = [], result = {siteId: sample.id, status: 'running', requests};
  const began = performance.now();
  let operation = '', totalBytes = 0, readerHtml;
  const chapterPath = `/${sample.chapterSlug}/`, catalogUrl = `${sample.origin}/manga/${sample.catalogSlug}/`;

  async function readHttp(target, {image = false, referer} = {}) {
    const signal = AbortSignal.timeout(limits.timeoutMs);
    let url = new URL(target);
    for (let redirects = 0; ; redirects++) {
      assert(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'Invalid public HTTPS target');
      if (!image) assert.equal(url.origin, sample.origin, 'Source request left the selected site');
      assert(requests.length < limits.maxRequestsPerSite, 'Request budget exceeded');
      const begin = performance.now();
      const record = {operation, kind: image ? 'image-prefix' : 'html', host: url.hostname, bytesRead: 0};
      requests.push(record);
      let response;
      try {
        response = await fetch(url, {redirect: 'manual', credentials: 'omit', signal,
          headers: {Accept: image ? 'image/avif,image/webp,image/png,image/jpeg,*/*' : 'text/html,application/xhtml+xml',
            ...(referer ? {Referer: referer.split('#')[0]} : {})}});
        record.status = response.status;
        record.contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          assert(redirects < limits.maxRedirects, 'Redirect budget exceeded');
          const location = response.headers.get('location');
          assert(location, 'Redirect has no destination');
          url = new URL(location, url);
          record.redirect = true;
          continue;
        }
        assert(response.ok, `Public ${image ? 'image' : 'source'} HTTP ${response.status}`);
        if (!image) assert(['text/html', 'application/xhtml+xml'].includes(record.contentType), 'Expected source HTML');
        const maxBytes = image ? limits.maxImageReadBytes : limits.maxHtmlBytes;
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isSafeInteger(contentLength) && contentLength > 0) record.contentLength = contentLength;
        if (!image && record.contentLength) assert(record.contentLength <= maxBytes, 'HTML exceeds response budget');
        assert(response.body, 'HTTP response has no body');
        const reader = response.body.getReader(), chunks = [];
        try {
          while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            record.bytesRead += value.byteLength;
            totalBytes += value.byteLength;
            assert(record.bytesRead <= maxBytes && totalBytes <= limits.maxSiteBytes, 'HTTP byte budget exceeded');
            chunks.push(value);
            if (image && record.bytesRead >= limits.imagePrefixBytes) break;
          }
        } finally {await reader.cancel();}
        const bytes = Buffer.concat(chunks);
        if (!image) return bytes.toString('utf8');
        const mime = imageMimeFromBytes(bytes);
        assert(mime, 'Image prefix is not a recognized raster image');
        assert(record.contentType.startsWith('image/'), 'Expected image content type');
        record.declaredMime = record.contentType;
        record.sniffedMime = mime;
        record.mimeMismatch = record.contentType !== mime;
        record.prefixOnly = true;
        return {host: record.host, declaredMime: record.declaredMime, sniffedMime: record.sniffedMime,
          mimeMismatch: record.mimeMismatch, bytesRead: record.bytesRead};
      } finally {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        record.elapsedMs = Math.round(performance.now() - begin);
      }
    }
  }
  const context = {request: async (target, options) => {
    assert(!options?.form, 'Live verification only permits read-only GET requests');
    const html = await readHttp(target, {referer: options?.referer});
    if (new URL(target).pathname === chapterPath) readerHtml = html;
    return html;
  }};
  try {
    operation = 'search-title';
    const found = await network.search({siteId: sample.id, query: sample.query}, context);
    const expectedId = definition.identify(new URL(catalogUrl))?.catalog?.key;
    assert(expectedId && found.items.some(hit => hit.catalogId === expectedId), 'Title search missed the fixed public work');
    assert(found.items.every(hit => definition.identify(new URL(hit.catalogUrl))?.catalog?.key === hit.catalogId), 'Search identity mismatch');
    operation = 'search-empty';
    const empty = await network.search({siteId: sample.id, query: 'nodelanevalidationzzqv'}, context);
    assert.equal(empty.items.length, 0, 'Expected an explicit empty search result');
    assert(!empty.nextCursor, 'Empty search unexpectedly has a next page');
    operation = 'search-page-1';
    const first = await network.search({siteId: sample.id, query: sample.paginationQuery}, context);
    assert(first.items.length && first.nextCursor, 'Expected broad search pagination');
    operation = 'search-page-2';
    const second = await network.search({siteId: sample.id, query: sample.paginationQuery, cursor: first.nextCursor}, context);
    const firstIds = new Set(first.items.map(hit => hit.catalogId));
    assert(second.items.some(hit => !firstIds.has(hit.catalogId)), 'Search second page did not advance');
    result.search = {titleHits: found.items.length, emptyHits: empty.items.length, firstPage: first.items.length,
      secondPage: second.items.length, overlap: second.items.filter(hit => firstIds.has(hit.catalogId)).length};

    operation = 'catalog';
    const catalog = validateCatalog(await network.catalog(catalogUrl, context), [definition]);
    assert(catalog.complete && catalog.entries.length >= sample.minimumEntries, 'Catalog is incomplete or sample changed');
    assert.equal(catalog.id, expectedId);
    assert(catalog.entries.every((entry, index) => entry.catalogId === catalog.id && entry.order === index), 'Catalog order or binding mismatch');
    const entry = catalog.entries.find(value => new URL(value.url).pathname === chapterPath);
    assert(entry && entry.readable !== false, 'Fixed public chapter is unavailable');
    assert(catalog.cover?.url, 'Expected dedicated work artwork');
    result.catalog = {entries: catalog.entries.length, complete: catalog.complete, boundEntries: true};

    operation = 'resolve-catalog';
    assert.equal(await network.resolveCatalog(sample.origin + chapterPath, context), catalogUrl, 'Bare chapter belongs to another work');
    operation = 'reader-pages';
    const location = definition.identify(new URL(entry.url));
    assert(location?.kind === 'reader' && location.catalog?.key === catalog.id, 'Reader has no expected work binding');
    const pages = validatePages(await network.pages(entry.url, context), location);
    assert(pages.discoveryComplete && pages.items.length === pages.knownTotal, 'Incomplete page manifest');
    assert.equal(pages.items.length, sample.pages, 'Public chapter changed from the verified sample');
    assert(pages.items.every((page, index) => page.order === index && page.resource.kind === 'http'), 'Invalid page order or transport');
    assert(readerHtml, 'Reader HTML was not observed');
    const wrongBinding = new URL(entry.url);
    wrongBinding.hash = `nodelane-${sample.id}=not-the-verified-catalog`;
    assert.throws(() => parsePages(readerHtml, wrongBinding.href), /归属/, 'Parser accepted a wrong work binding');
    result.chapter = {pages: pages.items.length, complete: pages.discoveryComplete, resolvedCatalog: true, rejectsWrongBinding: true};
    readerHtml = undefined;

    result.images = [];
    for (const [label, url, referer] of [['cover', catalog.cover.url, catalog.url],
      ['page-first', pages.items[0].resource.url, entry.url], ['page-last', pages.items.at(-1).resource.url, entry.url]]) {
      operation = label;
      result.images.push({role: label, ...await readHttp(url, {image: true, referer})});
    }
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.failedOperation = operation;
    result.error = sanitize(error);
  } finally {
    readerHtml = undefined;
    result.requestCount = requests.length;
    result.bytesRead = totalBytes;
    result.elapsedMs = Math.round(performance.now() - began);
  }
  return result;
}

for (const sample of selected) {
  const result = await verifySite(sample);
  results.push(result);
  console.log(JSON.stringify({siteId: sample.id, status: result.status, requestCount: result.requestCount,
    bytesRead: result.bytesRead, elapsedMs: result.elapsedMs, failedOperation: result.failedOperation, error: result.error}));
}
const report = {status: results.every(result => result.status === 'passed') ? 'passed' : 'failed', limits,
  results, requestCount: results.reduce((sum, result) => sum + result.requestCount, 0),
  bytesRead: results.reduce((sum, result) => sum + result.bytesRead, 0), elapsedMs: Math.round(performance.now() - started),
  liveSource: true, liveProvider: false, browserVerified: false, imageValidation: 'ordinary-get-raster-prefix-only'};
await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({out, status: report.status, requestCount: report.requestCount, bytesRead: report.bytesRead,
  elapsedMs: report.elapsedMs, liveSource: true, liveProvider: false, browserVerified: false}));
if (report.status !== 'passed') process.exitCode = 1;
