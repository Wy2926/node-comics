import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {samples} from './serial-samples.mjs';

const selected = process.argv[2] ? samples.filter(s => s.id === process.argv[2]) : samples;
assert(selected.length && process.argv.length <= 3, 'Usage: node verify-serial-http.mjs [site-id]');
const root = process.cwd(), extension = path.join(root, 'apps/extension'), base = path.join(root, 'artifacts/gigaviewer/http');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-')), source = path.join(extension, 'src').replaceAll('\\', '/');
const {build} = createRequire(path.join(extension, 'package.json'))('vite');
await build({configFile: false, root: extension, logLevel: 'error', plugins: [{
  name: 'giga-serial-http', resolveId(id) {if (id.replaceAll('\\', '/').endsWith('/giga-serial-http')) return '\0giga-serial-http';},
  load(id) {if (id === '\0giga-serial-http') return selected.map(s =>
    `import {network as ${s.id}} from '${source}/sources/sites/${s.id}/network.ts';
     import {definition as ${s.id}Definition} from '${source}/sources/sites/${s.id}/definition.ts';`).join('\n') +
    `export const adapters = {${selected.map(s => `${s.id}: {network: ${s.id}, definition: ${s.id}Definition}`).join(',')}};
     export {validateCatalog} from '${source}/sources/core/catalog.ts';
     export {validatePages} from '${source}/sources/core/pages.ts';
     export {validateSearchPage} from '${source}/sources/core/search.ts';
     export {imageMimeFromBytes} from '${source}/comics/formats/identify.ts';`;},
}], build: {outDir: out, emptyOutDir: false, lib: {entry: 'giga-serial-http', formats: ['es'], fileName: () => 'probe.mjs'}}});
const {adapters, validateCatalog, validatePages, validateSearchPage, imageMimeFromBytes} = await import(pathToFileURL(path.join(out, 'probe.mjs')).href);
const results = [];
const sanitize = e => String(e?.message ?? e).replace(/https?:\/\/[^\s"']+/g, '[source URL]').slice(0, 400);
for (const sample of selected) {
  let requests = 0, bytes = 0;
  const start = performance.now(), {network, definition} = adapters[sample.id];
  async function read(url, options, image = false) {
    assert.equal(new URL(url).origin, image ? sample.cdn : sample.origin);
    assert(++requests <= 30, 'Sample request budget exceeded');
    const response = await fetch(url, {signal: AbortSignal.timeout(30000), redirect: 'error', credentials: 'omit',
      headers: options?.referer ? {Referer: options.referer} : {}});
    assert(response.ok || options?.acceptStatuses?.includes(response.status), `Source HTTP ${response.status}`);
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {for (;;) {const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength; bytes += value.byteLength;
      assert(size <= (image ? 4 : 8) * 1024 * 1024 && bytes <= 24 * 1024 * 1024, 'Sample response budget exceeded');
      chunks.push(value);
    }} finally {await reader.cancel(); reader.releaseLock();}
    return Buffer.concat(chunks);
  }
  const context = {request: async (url, options) => (await read(url, options)).toString('utf8')};
  try {
    const hits = validateSearchPage(await network.search({siteId: sample.id, query: sample.query}, context), definition, definition.sites[0], [definition]);
    assert(hits.items.some(hit => hit.catalogId === `${sample.id}:series:${sample.series}`));
    const chapter = `${sample.origin}/episode/${sample.episode}`, catalogUrl = await network.resolveCatalog(chapter, context);
    const catalog = validateCatalog(await network.catalog(catalogUrl, context), [definition]);
    assert(catalog.complete && catalog.id === `${sample.id}:series:${sample.series}`);
    const entry = catalog.entries.find(e => e.remoteId === sample.episode); assert(entry?.readable);
    const pages = validatePages(await network.pages(entry.url, context), definition.identify(new URL(entry.url)));
    assert(pages.discoveryComplete && pages.knownTotal === pages.items.length && pages.items.length > 1);
    const pageBytes = await read(pages.items[0].resource.url, undefined, true);
    const coverBytes = await read(catalog.cover.url, undefined, true);
    assert(imageMimeFromBytes(pageBytes) && imageMimeFromBytes(coverBytes));
    const locked = catalog.entries.find(e => e.readable === false);
    if (locked) await assert.rejects(network.pages(locked.url, context), /当前不可读取/);
    assert.deepEqual((await network.search({siteId: sample.id, query: 'NodeLaneNoSuchWork12973'}, context)).items, []);
    let pagination;
    if (sample.paginationQuery) {
      const query = {siteId: sample.id, query: sample.paginationQuery};
      const first = validateSearchPage(await network.search(query, context), definition, definition.sites[0], [definition]);
      assert(first.nextCursor && first.items.length === 50, 'Broad search must exercise a real second result page');
      const second = validateSearchPage(await network.search({...query, cursor: first.nextCursor}, context), definition, definition.sites[0], [definition]);
      const keys = [...first.items, ...second.items].map(hit => hit.catalogId);
      assert(second.items.length > 0 && new Set(keys).size === keys.length, 'Search pages must contain distinct source works');
      pagination = {pages: 2, items: keys.length};
    }
    results.push({siteId: sample.id, status: 'passed', entries: catalog.entries.length,
      readable: catalog.entries.filter(e => e.readable).length, pages: pages.items.length, requests, bytes,
      imageBytes: pageBytes.length, coverBytes: coverBytes.length, lockedRefused: !!locked, pagination, elapsedMs: Math.round(performance.now() - start)});
  } catch (error) {results.push({siteId: sample.id, status: 'failed', error: sanitize(error), requests, bytes});}
  console.log(JSON.stringify(results.at(-1)));
}
await writeFile(path.join(out, 'result.json'), JSON.stringify({results, liveSource: true, liveProvider: false}, null, 2));
console.log(JSON.stringify({out}));
assert(results.every(r => r.status === 'passed'), 'One or more public source checks failed');
