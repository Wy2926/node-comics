// Run from repository root. Public source/CDN only; no accounts, persisted bodies or translation calls.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/mangataro/http');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, publicDir: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: out, emptyOutDir: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/mangataro/tests/probe.ts'), formats: ['es'], fileName: () => 'probe-built.mjs'}}});
const {network, definition, validateCatalog, validatePages, imageMimeFromBytes} = await import(pathToFileURL(path.join(out, 'probe-built.mjs')).href);
let requests = 0, bytes = 0;
function read(url, options) {
  requests++;
  const args = ['-f', '-sS', '-L', '--max-time', '30', '--max-filesize', '8388608'];
  if (options?.referer) args.push('--referer', options.referer);
  if (options?.form) args.push('--data', new URLSearchParams(options.form).toString());
  args.push(url);
  const body = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {maxBuffer: 8 * 1024 * 1024, timeout: 35000});
  bytes += body.length; return body;
}
const context = {request: async (url, options) => read(url, options).toString('utf8')};
const input = {siteId: 'mangataro', query: 'Dandadan'}, search = await network.search(input, context);
assert(search.items.length > 0 && search.nextCursor);
assert.equal((await network.search({...input, cursor: search.nextCursor}, context)).items.length, 0);
const catalogs = [];
for (const slug of ['dandadan', 'one-piece', 'the-knight-who-only-lives-today']) {
  const started = Date.now(), before = requests, heapBefore = process.memoryUsage().heapUsed;
  const catalog = validateCatalog(await network.catalog('https://mangataro.org/manga/' + slug, context), [definition]);
  assert(catalog.complete && catalog.entries.length);
  const catalogMs = Date.now() - started, catalogRequests = requests - before;
  const chapterResults = [];
  const selected = [...new Set([catalog.entries[0], catalog.entries.at(-1),
    catalog.entries.find(entry => /\/ch\d+-\d+-\d+$/.test(entry.url)),
    catalog.entries.find(entry => entry.contentLanguage !== 'en')].filter(Boolean))];
  for (const entry of selected) {
    const pages = validatePages(await network.pages(entry.url, context), definition.identify(new URL(entry.url)));
    assert(pages.discoveryComplete && pages.items.length === pages.knownTotal);
    const images = [];
    for (const index of [...new Set([0, pages.items.length - 1])]) {
      const data = read(pages.items[index].resource.url, {referer: entry.url}), mime = imageMimeFromBytes(data);
      assert(mime && data.length > 1000); images.push({mime, bytes: data.length});
    }
    chapterResults.push({id: entry.remoteId, pages: pages.items.length, language: entry.contentLanguage, images});
  }
  assert(imageMimeFromBytes(read(catalog.cover.url, {referer: catalog.url})));
  catalogs.push({slug, entries: catalog.entries.length, languages: [...new Set(catalog.entries.map(e => e.contentLanguage))],
    chapterResults, catalogMs, catalogRequests, requests: requests - before, elapsedMs: Date.now() - started,
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore});
}
const result = {status: 'passed', requests, bytes, search: search.items.length, catalogs, liveSource: true, liveProvider: false};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({out, ...result}, null, 2));
