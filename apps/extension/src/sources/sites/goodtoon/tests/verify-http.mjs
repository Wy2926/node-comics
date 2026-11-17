// Bounded anonymous live-source check. No site scripts, user cookies, account or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.cwd(), extension = path.join(root, 'apps/extension'), base = path.join(root, 'artifacts/goodtoon-http');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-')), source = path.join(extension, 'src').replaceAll('\\', '/');
const {build} = createRequire(path.join(extension, 'package.json'))('vite');
await build({configFile: false, root: extension, logLevel: 'error', plugins: [{
  name: 'goodtoon-http', resolveId(id) {if (id.replaceAll('\\', '/').endsWith('/goodtoon-http')) return '\0goodtoon-http';},
  load(id) {if (id === '\0goodtoon-http') return `
    export {network} from '${source}/sources/sites/goodtoon/network.ts';
    export {definition, origin, isOrigin} from '${source}/sources/sites/goodtoon/definition.ts';
    export {validateCatalog} from '${source}/sources/core/catalog.ts';
    export {validatePages} from '${source}/sources/core/pages.ts';
    export {validateSearchPage} from '${source}/sources/core/search.ts';
    export {inertHtml, tags, hasClass} from '${source}/sources/shared/html.ts';
    export {imageMimeFromBytes} from '${source}/comics/formats/identify.ts';`;},
}], build: {outDir: out, emptyOutDir: false, lib: {entry: 'goodtoon-http', formats: ['es'], fileName: () => 'probe.mjs'}}});
const p = await import(pathToFileURL(path.join(out, 'probe.mjs')).href);
let requests = 0, bytes = 0;
async function read(url, options, image = false) {
  let response;
  for (let redirects = 0; ; redirects++) {
    assert(image ? new URL(url).origin === 'https://img.goodtoon9001.top' : p.isOrigin(new URL(url)));
    assert(++requests <= 24, 'Request budget exceeded');
    response = await fetch(url, {method: options?.form ? 'POST' : 'GET', credentials: 'omit', redirect: 'manual',
      signal: AbortSignal.timeout(25000), body: options?.form ? new URLSearchParams(options.form) : undefined,
      headers: options?.referer ? {Referer: options.referer} : {}});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    assert(redirects < 4 && response.headers.get('location') && !options?.form, 'Invalid redirect or redirected chapter POST');
    url = new URL(response.headers.get('location'), url).href;
  }
  assert(response.ok, `Source HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {for (;;) {const {value, done} = await reader.read(); if (done) break;
    size += value.byteLength; bytes += value.byteLength;
    assert(size <= 8 * 1024 * 1024 && bytes <= 24 * 1024 * 1024, 'Response budget exceeded'); chunks.push(value);
  }} finally {await reader.cancel(); reader.releaseLock();}
  return Buffer.concat(chunks);
}
const context = {request: async (url, options) => (await read(url, options)).toString('utf8')};
try {
  const hits = [];
  let cursor;
  for (let page = 0; page < 2; page++) {
    const result = p.validateSearchPage(await p.network.search({siteId: 'goodtoon', query: '회귀', cursor}, context), p.definition, p.definition.sites[0], [p.definition]);
    hits.push(...result.items); cursor = result.nextCursor;
    assert(page === 0 ? cursor === '2' : cursor === undefined, 'Expected two live search pages including the terminal page');
  }
  assert.equal(new Set(hits.map(hit => hit.catalogId)).size, hits.length);
  assert.deepEqual((await p.network.search({siteId: 'goodtoon', query: 'NodeLaneNoSuchWork12973'}, context)).items, []);
  const catalog = p.validateCatalog(await p.network.catalog(p.origin + '/manga/gt-21580/', context), [p.definition]);
  assert(catalog.complete && catalog.entries.length > 1 && catalog.entries[0].remoteId === '1');
  const pageCounts = [];
  let readerComparison;
  for (const entry of catalog.entries.slice(0, 2)) {
    const before = bytes;
    const pages = p.validatePages(await p.network.pages(entry.url, context), p.definition.identify(new URL(entry.url)));
    assert(pages.discoveryComplete && pages.items.length === pages.knownTotal);
    assert.equal(pages.title, entry.title);
    if (!readerComparison) {
      const apiBytes = bytes - before, html = await read(entry.url);
      const images = p.tags(p.inertHtml(html.toString('utf8')), 'img').filter(image => p.hasClass(image, 'wp-manga-chapter-img'));
      assert.deepEqual(pages.items.map(item => item.resource.url), images.map(image => new URL(image['data-src'] || image.src, entry.url).href));
      readerComparison = {apiBytes, fullPageBytes: html.byteLength, identicalImageList: true};
    }
    pageCounts.push(pages.items.length);
    for (const index of [0, pages.items.length - 1]) assert(p.imageMimeFromBytes(await read(pages.items[index].resource.url, undefined, true)));
  }
  assert(p.imageMimeFromBytes(await read(catalog.cover.url, undefined, true)));
  const alias = p.origin + '/manga/gt-16663/1%EA%B6%8C/301512/';
  const aliasPages = p.validatePages(await p.network.pages(alias, context), p.definition.identify(new URL(alias)));
  assert(aliasPages.items.length > 1);
  const report = {status: 'passed', liveSource: true, liveProvider: false, entries: catalog.entries.length, pages: pageCounts,
    searchPages: 2, candidates: hits.length, aliasPages: aliasPages.items.length, readerComparison, requests, bytes};
  await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({out, ...report}));
} catch (error) {
  const report = {status: 'failed', requests, bytes, error: String(error.message).replace(/https?:\/\/[^\s"']+/g, '[source URL]')};
  await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify({out, ...report})); process.exitCode = 1;
}
