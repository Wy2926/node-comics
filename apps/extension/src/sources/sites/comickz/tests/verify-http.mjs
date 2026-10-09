// Public source/CDN only. No account credentials or translation provider calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/comickz/http');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.mjs');
await writeFile(probe, `export {network} from '${source}/sources/sites/comickz/network.ts';
  export {definition} from '${source}/sources/sites/comickz/definition.ts';
  export {validateCatalog} from '${source}/sources/core/catalog.ts';
  export {validatePages} from '${source}/sources/core/pages.ts';
  export {imageMimeFromBytes} from '${source}/comics/formats/identify.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, publicDir: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: out, emptyOutDir: false,
  lib: {entry: probe, formats: ['es'], fileName: () => 'probe-built.mjs'}}});
const {network, definition, validateCatalog, validatePages, imageMimeFromBytes} = await import(pathToFileURL(path.join(out, 'probe-built.mjs')).href);
let requests = 0, bytes = 0, imageFailure;
async function read(url) {
  requests++;
  const response = await fetch(url, {signal: AbortSignal.timeout(30000),
    ...(new URL(url).hostname.endsWith('.comicknew.pictures') ? {headers: {Referer: 'https://comickz.co.uk/'}} : {})});
  assert(response.ok, `HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer()); bytes += body.length; return body;
}
const context = {request: async url => (await read(url)).toString('utf8')};
async function image(url) {
  if (imageFailure) return {status: 'skipped-after-cdn-failure'};
  try {
    const body = await read(url), mime = imageMimeFromBytes(body);
    assert(mime && body.length > 1000); return {mime, bytes: body.length};
  } catch (error) {imageFailure = error.message; return {status: 'failed', error: imageFailure};}
}
const input = {siteId: 'comickz', query: 'one piece'}, search = await network.search(input, context);
assert(search.items.length > 0 && search.nextCursor);
const next = await network.search({...input, cursor: search.nextCursor}, context);
assert(next.items.length > 0);
assert(!next.items.some(row => search.items.some(first => first.catalogId === row.catalogId)));
const samples = process.env.COMICKZ_CATALOG_URL ? [process.env.COMICKZ_CATALOG_URL] : [
  'https://comickz.co.uk/comic/00-one-piece-episode-a', 'https://comickz.co.uk/comic/one-piece',
];
const catalogs = [];
for (const url of samples) {
  const started = Date.now(), before = requests, catalog = validateCatalog(await network.catalog(url, context), [definition]);
  assert(catalog.complete && catalog.entries.length > 0);
  const languages = [...new Set(catalog.entries.map(e => e.contentLanguage))];
  const selected = [...new Set([catalog.entries[0], catalog.entries.at(-1), catalog.entries.find(e => e.contentLanguage === 'es-419')].filter(Boolean))];
  const chapters = [];
  for (const entry of selected) {
    const pages = validatePages(await network.pages(entry.url, context), definition.identify(new URL(entry.url)));
    assert(pages.discoveryComplete && pages.items.length === pages.knownTotal);
    const indices = [...new Set([0, pages.items.length - 1])];
    const images = [];
    for (const index of indices) images.push(await image(pages.items[index].resource.url));
    chapters.push({id: entry.id, language: entry.contentLanguage, pages: pages.items.length, images});
  }
  catalogs.push({url, entries: catalog.entries.length, languages, groups: catalog.groups.length, chapters,
    cover: await image(catalog.cover.url), requests: requests - before, elapsedMs: Date.now() - started});
}
const result = {status: imageFailure ? 'partial' : 'passed', imageFailure, search: [search.items.length, next.items.length], catalogs, requests, bytes, liveSource: true, liveProvider: false};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({out, ...result}, null, 2));
if (imageFailure) process.exitCode = 1;
