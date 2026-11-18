// Real public HTTP: seven language searches, Originals/Canvas catalogs, images and covers.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root = process.cwd(), base = path.join(root, 'artifacts/webtoons/http'); await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: out, emptyOutDir: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/webtoons/network.ts'), formats: ['es'], fileName: () => 'network.mjs'}}});
const {network} = await import(pathToFileURL(path.join(out, 'network.mjs')).href);
const download = async (url, referer = 'https://www.webtoons.com/') => (await promisify(execFile)('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--retry-all-errors', '--max-time', '30', '--referer', referer, url], {encoding: 'buffer', maxBuffer: 10 * 1024 * 1024})).stdout;
let requests = 0, bytes = 0;
const context = {request: async (url, options) => {
  const target = new URL(url), api = target.origin === 'https://m.webtoons.com';
  if (api) {assert.match(target.pathname, /^\/api\/v1\/(?:webtoon|canvas)\/[1-9]\d*\/episodes$/); assert.equal(options?.desktop, undefined);}
  else {assert.equal(target.origin, 'https://www.webtoons.com'); assert.equal(options?.desktop, true);}
  const body = await download(url); requests++; bytes += body.length; return body.toString('utf8');
}};
const results = [];
for (const language of ['en', 'zh-hant', 'th', 'id', 'es', 'fr', 'de']) {
  const result = await network.search({siteId: 'webtoons-' + language, query: language === 'zh-hant' ? '愛' : 'a'}, context);
  assert(result.items.length, language); results.push({language, searchResults: result.items.length, next: result.nextCursor});
}
for (const [query, cursor] of [['Not So Silent', undefined], ['The Lucky Cat', 'canvas:1']]) {
  const hits = await network.search({siteId: 'webtoons-en', query, cursor}, context); assert(hits.items.length);
  const hit = hits.items.find(h => h.title.toLowerCase() === query.toLowerCase()) ?? hits.items[0];
  const beforeRequests = requests, beforeBytes = bytes;
  const catalog = await network.catalog(hit.catalogUrl.replace('www.', 'm.'), context); assert(catalog.complete && catalog.entries.length);
  const catalogRequests = requests - beforeRequests, catalogBytes = bytes - beforeBytes;
  assert.equal(catalog.id, hit.catalogId); assert.equal(catalog.url, hit.catalogUrl);
  const mobile = catalog.entries[0].url.replace('www.', 'm.');
  const pages = await network.pages(mobile, context); assert(pages.discoveryComplete && pages.items.length); assert.equal(pages.url, mobile);
  const image = await download(pages.items[0].resource.url), cover = await download(catalog.cover.url);
  assert(image.length > 1000 && cover.length > 1000);
  results.push({id: catalog.id, entries: catalog.entries.length, catalogRequests, catalogBytes, pages: pages.items.length,
    imageBytes: image.length, coverBytes: cover.length});
}
const empty = await network.search({siteId: 'webtoons-en', query: 'zzqv987654nonexistent', cursor: 'canvas:1'}, context); assert.deepEqual(empty.items, []);
await writeFile(path.join(out, 'result.json'), JSON.stringify({results}, null, 2)); console.log(JSON.stringify({out, results}, null, 2));
