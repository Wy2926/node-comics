// Public source only. No account cookies, model calls, ticket use or point consumption.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {unlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const root = process.cwd(), out = path.join(root, 'artifacts/comicfuz');
await mkdir(out, {recursive: true});
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, minify: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/comicfuz/tests/live-entry.ts'), name: 'ComicFuzValidation', formats: ['es', 'iife'], fileName: format => 'live.' + (format === 'es' ? 'mjs' : 'js')},
}});
if (process.argv.includes('--build-only')) process.exit(0);
const {network, definition, image, validateCatalog, validatePages} = await import(pathToFileURL(path.join(out, 'live.mjs')));
// Keep only this test's server-issued anonymous session, as credentials:include does in the extension.
const cookieJar = path.join(out, `anonymous-${crypto.randomUUID()}.cookies`);
process.on('exit', () => {try {unlinkSync(cookieJar);} catch { /* not created */ }});
let requests = 0, transferred = 0;
async function http(url, options = {}) {
  requests++;
  const args = ['-sS', '--cookie', cookieJar, '--cookie-jar', cookieJar, '--max-time', '30', '--referer', options.referer ?? 'https://comic-fuz.com/', '-w', '\n%{http_code}'];
  if (process.env.SOURCE_TEST_PROXY) args.push('--proxy', process.env.SOURCE_TEST_PROXY);
  if (options.body) args.push('-H', 'Content-Type: application/octet-stream', '--data-binary', '@-');
  args.push(url);
  const buffer = await new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {windowsHide: true}), chunks = [];
    let length = 0;
    child.stdout.on('data', chunk => {length += chunk.length; if (length > 32 * 1024 * 1024) {child.kill(); reject(Error('Response too large'));} else chunks.push(chunk);});
    child.on('error', reject); child.on('close', code => code ? reject(Error('HTTP transport failure')) : resolve(Buffer.concat(chunks)));
    child.stdin.end(options.body);
  });
  const split = buffer.lastIndexOf(10), status = Number(buffer.subarray(split + 1));
  assert.equal(status, 200, `Source HTTP ${status}`); transferred += split; return buffer.subarray(0, split);
}
const context = {request: async (url, options) => (await http(url, options)).toString('utf8'), requestBytes: http};
const started = performance.now();
for (const manga of ['2062', '218', '3360']) {
  const catalog = validateCatalog(await network.catalog(`https://comic-fuz.com/manga/${manga}`, context), [definition]);
  const free = catalog.entries.filter(entry => entry.readable).slice(0, 2), chapters = [];
  for (const entry of free) {
    const pages = validatePages(await network.pages(entry.url, context), definition.identify(new URL(entry.url)));
    for (const index of new Set([0, pages.items.length - 1])) {
      const page = pages.items[index], raw = await http(page.resource.url);
      const blob = await image.decode(new Blob([raw]), new Headers(), page.resource.processing);
      assert(blob.size > 1000 && blob.type.startsWith('image/'));
    }
    chapters.push({id: entry.remoteId, pages: pages.items.length});
  }
  console.log(JSON.stringify({manga, entries: catalog.entries.length, groups: catalog.groups.length, free: catalog.entries.filter(entry => entry.readable).length, chapters}));
}
const result = await network.search({siteId: 'comicfuz', query: '星屑'}, context);
assert(result.items.some(hit => hit.catalogId === 'comicfuz:manga:2062'));
const empty = await network.search({siteId: 'comicfuz', query: 'NodeLaneNoSuchTitleFixture'}, context);
assert.equal(empty.items.length, 0);
console.log(JSON.stringify({status: 'passed', requests, transferred, elapsedMs: Math.round(performance.now() - started), search: result.items.length}));
