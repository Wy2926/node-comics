// Public unauthenticated APIs only. No cookies, accounts, tickets or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const root = process.cwd(), out = path.join(root, 'artifacts/zebrack');
await mkdir(out, {recursive: true});
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, minify: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/zebrack/tests/live-entry.ts'), name: 'ZebrackValidation', formats: ['es', 'iife'], fileName: format => 'live.' + (format === 'es' ? 'mjs' : 'js')},
}});
if (process.argv.includes('--build-only')) process.exit(0);
const {network, definition, image, validateCatalog, validatePages, validateSearchPage} = await import(pathToFileURL(path.join(out, 'live.mjs')));
let requests = 0, transferred = 0;
async function http(url, options = {}) {
  requests++;
  const response = await fetch(url, {signal: AbortSignal.timeout(30000), headers: {Referer: options.referer ?? definition.sites[0].url},
    ...(options.form ? {method: 'POST', body: new URLSearchParams(options.form)} : {})});
  assert.equal(response.status, 200, `Source HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  assert(data.length <= 8 * 1024 * 1024); transferred += data.length; return data;
}
const context = {request: () => {throw Error('Unexpected text request');}, requestBytes: http};
const started = performance.now();
for (const title of ['9', '249', '4']) {
  const catalogStart = performance.now();
  const catalog = validateCatalog(await network.catalog(`https://zebrack-comic.shueisha.co.jp/title/${title}`, context), [definition]);
  const catalogMs = Math.round(performance.now() - catalogStart), entries = catalog.entries.filter(entry => entry.readable), chapters = [];
  assert(entries.length > 0); assert((await http(catalog.cover.url)).length > 1000);
  for (const entry of entries.slice(0, 2)) {
    const start = performance.now();
    const pages = validatePages(await network.pages(entry.url, context), definition.identify(new URL(entry.url)));
    let decodeMs = 0;
    for (const index of new Set([0, pages.items.length - 1])) {
      const page = pages.items[index], raw = await http(page.resource.url);
      const decodeStart = performance.now(), blob = await image.decode(new Blob([raw]), new Headers(), page.resource.processing);
      decodeMs += performance.now() - decodeStart;
      assert(blob.size > 1000 && blob.type.startsWith('image/'));
    }
    chapters.push({id: entry.remoteId, pages: pages.items.length, elapsedMs: Math.round(performance.now() - start), decodeMs: Math.round(decodeMs)});
  }
  console.log(JSON.stringify({title, entries: catalog.entries.length, groups: catalog.groups.length, free: entries.length, catalogMs, chapters}));
}
const search = validateSearchPage(await network.search({siteId: 'zebrack', query: 'BLEACH'}, context), definition, definition.sites[0], [definition]);
assert(search.items.some(item => item.catalogId === 'zebrack:title:9'));
const empty = await network.search({siteId: 'zebrack', query: 'NodeLaneNoSuchTitleFixture'}, context);
assert.equal(empty.items.length, 0);
console.log(JSON.stringify({status: 'passed', requests, transferred, elapsedMs: Math.round(performance.now() - started), search: search.items.length}));
