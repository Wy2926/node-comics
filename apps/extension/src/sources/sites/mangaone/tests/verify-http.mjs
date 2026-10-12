// Public anonymous reads only; no cookies, account changes, purchased content or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const root = process.cwd(), out = path.join(root, 'artifacts/mangaone');
await mkdir(out, {recursive: true});
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, minify: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/mangaone/tests/live-entry.ts'), name: 'MangaOneValidation', formats: ['es', 'iife'], fileName: format => 'live.' + (format === 'es' ? 'mjs' : 'js')},
}});
if (process.argv.includes('--build-only')) process.exit(0);
const {network, definition, image, validateCatalog, validatePages, validateSearchPage} = await import(pathToFileURL(path.join(out, 'live.mjs')));
let requests = 0, transferred = 0;
async function http(url, options = {}) {
  requests++;
  const response = await fetch(url, {signal: AbortSignal.timeout(30000), headers: {Referer: options.referer ?? 'https://manga-one.com/'},
    ...(options.body !== undefined ? {method: 'POST', body: options.body} : {})});
  assert.equal(response.status, 200, `Source HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  assert(data.length <= 8 * 1024 * 1024); transferred += data.length; return data;
}
const context = {request: () => {throw Error('Unexpected text request');}, requestBytes: http};
const started = performance.now();
for (const work of ['2275', '659', '28579']) {
  const start = performance.now(), before = requests;
  const catalog = validateCatalog(await network.catalog(`https://manga-one.com/manga/${work}/chapter/first`, context), [definition]);
  const catalogMs = Math.round(performance.now() - start), catalogRequests = requests - before;
  const entries = catalog.entries.filter(entry => entry.readable), chapters = [];
  assert(entries.length > 0); assert((await http(catalog.cover.url)).length > 1000);
  for (const entry of entries.slice(0, 2)) {
    const chapterStart = performance.now();
    const pages = validatePages(await network.pages(entry.url, context), definition.identify(new URL(entry.url)));
    let decodeMs = 0;
    for (const index of new Set([0, pages.items.length - 1])) {
      const page = pages.items[index], raw = await http(page.resource.url), decodeStart = performance.now();
      const blob = await image.decode(new Blob([raw]), new Headers(), page.resource.processing);
      decodeMs += performance.now() - decodeStart;
      assert(blob.size > 1000 && blob.type.startsWith('image/'));
    }
    chapters.push({id: entry.remoteId, pages: pages.items.length, elapsedMs: Math.round(performance.now() - chapterStart), decodeMs: Math.round(decodeMs)});
  }
  const locked = catalog.entries.find(entry => !entry.readable);
  if (locked) await assert.rejects(network.pages(locked.url, context));
  console.log(JSON.stringify({work, entries: catalog.entries.length, free: entries.length, catalogRequests, catalogMs, chapters}));
}
const search = validateSearchPage(await network.search({siteId: 'mangaone', query: '一勝千金'}, context), definition, definition.sites[0], [definition]);
assert(search.items.some(item => item.catalogId === 'mangaone:2275'));
assert.equal((await network.search({siteId: 'mangaone', query: 'NodeLaneNoSuchTitleFixture'}, context)).items.length, 0);
console.log(JSON.stringify({status: 'passed', requests, transferred, elapsedMs: Math.round(performance.now() - started), search: search.items.length}));
