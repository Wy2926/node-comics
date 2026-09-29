// Public source HTTP only; no login cookies or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root = process.cwd(), base = path.join(root, 'artifacts/pixiv/http'); await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: out, emptyOutDir: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/pixiv/network.ts'), formats: ['es'], fileName: () => 'network.mjs'}}});
const {network} = await import(pathToFileURL(path.join(out, 'network.mjs')).href);
const download = async (url, referer) => (await promisify(execFile)('curl', ['--fail', '--silent', '--show-error', '--max-time', '30',
  '--referer', referer, url], {encoding: 'buffer', maxBuffer: 40 * 1024 * 1024})).stdout;
const context = {request: async (url, options) => {assert.equal(new URL(url).origin, 'https://www.pixiv.net'); return (await download(url, options.referer)).toString('utf8');}};
const userId = process.env.PIXIV_USER_ID || '25786514', author = `https://www.pixiv.net/users/${userId}`, tag = process.env.PIXIV_TAG || '二創';
const catalogs = [];
for (const category of ['', '/illustrations', '/manga']) {
  const catalog = await network.catalog(author + category, context); assert(catalog.complete); catalogs.push(catalog);
  const filtered = await network.catalog(author + (category || '/artworks') + '/' + encodeURIComponent(tag), context); assert(filtered.complete);
  assert.notEqual(catalog.id, filtered.id); assert(filtered.entries.every(e => catalog.entries.some(a => a.remoteId === e.remoteId)));
  catalogs.push(filtered);
}
assert.equal(catalogs[0].entries.length, catalogs[2].entries.length + catalogs[4].entries.length);
assert.equal(new Set([...catalogs[2].entries, ...catalogs[4].entries].map(e => e.remoteId)).size, catalogs[0].entries.length);
if (process.env.PIXIV_SERIES_ID) catalogs.push(await network.catalog(`https://www.pixiv.net/user/${userId}/series/${process.env.PIXIV_SERIES_ID}`, context));
const results = [], decoded = new Set();
for (const catalog of catalogs) {
  const chapter = catalog.entries.find(entry => entry.readable);
  if (!chapter || decoded.has(chapter.remoteId)) {results.push({id: catalog.id, entries: catalog.entries.length}); continue;}
  const pages = await network.pages(chapter.url, context);
  assert(pages.discoveryComplete && pages.items.length === pages.knownTotal);
  const image = await download(pages.items[0].resource.url, 'https://www.pixiv.net/'); assert(image.length > 1000);
  results.push({id: catalog.id, entries: catalog.entries.length, pages: pages.items.length, imageBytes: image.length});
  decoded.add(chapter.remoteId);
}
await writeFile(path.join(out, 'result.json'), JSON.stringify({results}, null, 2)); console.log(JSON.stringify({out, results}, null, 2));
