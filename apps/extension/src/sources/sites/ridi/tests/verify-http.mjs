// Run from the repository root. Logs counts only; signed images remain in memory.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/ridi');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'http-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, lib: {entry: path.join(root, 'apps/extension/src/sources/sites/ridi/tests/live-entry.ts'),
    name: 'RidiValidation', formats: ['es', 'iife'], fileName: format => 'live.' + (format === 'es' ? 'mjs' : 'js')},
}});
const {network, definition, validateCatalog, validatePages} = await import(pathToFileURL(path.join(out, 'live.mjs')));
const context = {request: async (url, options = {}) => {
  const response = await fetch(url, {signal: AbortSignal.timeout(30000), headers: {
    Referer: options.referer ?? 'https://ridibooks.com/', ...(options.json ? {'Content-Type': 'application/json'} : {}),
  }, ...(options.json ? {method: 'POST', body: JSON.stringify(options.json)} : {})});
  assert.equal(response.status, 200, `RIDI HTTP ${response.status}`);
  return response.text();
}};
const reader = 'https://ridibooks.com/books/4921002551/view';
const catalogUrl = await network.resolveCatalog(reader, context);
const catalog = validateCatalog(await network.catalog(catalogUrl, context), [definition]);
assert(catalog.complete && catalog.entries.length > 8);
const pages = validatePages(await network.pages(catalog.entries[0].url, context), definition.identify(new URL(catalog.entries[0].url)));
assert(pages.discoveryComplete && pages.items.length > 1);
const sizes = [];
for (const item of [pages.items[0], pages.items.at(-1)]) {
  const response = await fetch(item.resource.url, {headers: {Referer: 'https://ridibooks.com/'}, signal: AbortSignal.timeout(30000)});
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(bytes.subarray(8, 12)), 'WEBP');
  sizes.push(bytes.length);
}
console.log(JSON.stringify({status: 'passed', entries: catalog.entries.length, pages: pages.items.length, imageBytes: sizes, bundle: out}));
