// Real public source/CDN only; no credentials, product API or translation models.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/rawlazy/http');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/');
const probe = path.join(out, 'probe.mjs');
await writeFile(probe, `export {network} from '${source}/sources/sites/rawlazy/network.ts';
  export {definition} from '${source}/sources/sites/rawlazy/definition.ts';
  export {validateCatalog} from '${source}/sources/core/catalog.ts';
  export {validatePages} from '${source}/sources/core/pages.ts';
  export {imageMimeFromBytes} from '${source}/comics/formats/identify.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: out, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'probe-built.mjs'},
}});
const {network, definition, validateCatalog, validatePages, imageMimeFromBytes} =
  await import(pathToFileURL(path.join(out, 'probe-built.mjs')).href);
let requests = 0, formRequests = 0, imageRequests = 0;
// The local Node TLS client intermittently resets on this source. curl's verified
// HTTP/1.1 IPv4 path is also usable outside Chromium; certificate checks stay enabled.
async function readHttp(url, {referer, form, timeout = 30} = {}) {
  const args = ['-sS', '-4', '--http1.1', '--max-time', String(timeout), '-A', 'Mozilla/5.0', '-w', '\n%{http_code}'];
  if (referer) args.push('--referer', referer.split('#')[0]);
  if (form) args.push('-H', 'Content-Type: application/x-www-form-urlencoded;charset=UTF-8', '--data-binary', '@-');
  args.push(new URL(url).href);
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {windowsHide: true});
    const chunks = []; let length = 0, error = '';
    child.stdout.on('data', bytes => {
      length += bytes.length;
      if (length > 64 * 1024 * 1024) {child.kill(); reject(Error('HTTP body exceeds validation budget'));}
      else chunks.push(bytes);
    });
    child.stderr.on('data', bytes => {error += bytes.toString().slice(0, 2048);});
    child.on('error', reject);
    child.on('close', code => code ? reject(Error(`HTTP transport failed (${code}): ${error.trim()}`)) : resolve(Buffer.concat(chunks)));
    child.stdin.end(form ? new URLSearchParams(form).toString() : undefined);
  });
  const split = output.lastIndexOf(10), status = Number(output.subarray(split + 1).toString());
  assert(status >= 200 && status < 300, `Source HTTP ${status}`);
  return output.subarray(0, split);
}
const request = async (url, options) => {
  assert.equal(new URL(url).origin, 'https://rawlazy.io');
  requests++; if (options?.form) formRequests++;
  return (await readHttp(url, options)).toString('utf8');
};
async function readImage(url, referer) {
  imageRequests++;
  const bytes = await readHttp(url, {referer, timeout: 60}), mime = imageMimeFromBytes(bytes);
  assert(bytes.length > 1000 && mime, 'Source body is not a recognized image');
  return {host: new URL(url).host, mime, bytes: bytes.length};
}
const samples = process.env.RAWLAZY_CATALOG_URL ? [process.env.RAWLAZY_CATALOG_URL] : [
  'https://rawlazy.io/manga-lazy/御子神かれんの隠しごと-raw-free/',
  'https://rawlazy.io/manga-lazy/キングダム-raw-free/',
  'https://rawlazy.io/manga-lazy/百鬼夜京-raw-free/',
];
const started = Date.now(), works = [], failures = [];
for (const url of samples) {
  const work = {url, chapters: []}; works.push(work);
  try {
    const catalog = validateCatalog(await network.catalog(url, {request}), [definition]);
    assert(catalog.complete && catalog.entries.length > 0);
    Object.assign(work, {title: catalog.title, entries: catalog.entries.length});
    assert(catalog.cover); work.cover = await readImage(catalog.cover.url, catalog.url);
    const selected = new Map();
    for (const entry of [catalog.entries[0], catalog.entries.at(-1), catalog.entries.find(entry => /\d\.\d/.test(entry.title))].filter(Boolean))
      selected.set(entry.id, entry);
    for (const entry of selected.values()) {
      const before = requests, chapterStarted = Date.now();
      const bareUrl = entry.url.split('#')[0], parent = await network.resolveCatalog(bareUrl, {request});
      assert.equal(definition.identify(new URL(parent))?.catalog?.key, catalog.id);
      const pages = validatePages(await network.pages(entry.url, {request}), definition.identify(new URL(entry.url)));
      assert(pages.discoveryComplete && pages.knownTotal > 0);
      const images = [];
      for (const index of new Set([0, Math.floor(pages.items.length / 2), pages.items.length - 1]))
        images.push({page: index + 1, ...await readImage(pages.items[index].resource.url, entry.url)});
      work.chapters.push({title: entry.title, pages: pages.items.length, requests: requests - before,
        elapsedMs: Date.now() - chapterStarted, images});
    }
    work.status = 'passed';
  } catch (error) {work.status = 'failed'; work.error = error.message; failures.push({url, error: error.message});}
  console.log(JSON.stringify({status: work.status, title: work.title, entries: work.entries, chapters: work.chapters.length, error: work.error}));
}
let search;
try {
  const found = await network.search({siteId: 'rawlazy', query: 'キングダム'}, {request});
  const empty = await network.search({siteId: 'rawlazy', query: 'NodeLaneFixtureNoSuchTitle'}, {request});
  assert(found.items.length > 0); assert.equal(empty.items.length, 0);
  search = {hits: found.items.length, empty: empty.items.length};
} catch (error) {failures.push({search: true, error: error.message});}
const result = {status: failures.length ? 'failed' : 'passed', works, search, failures,
  requests, formRequests, imageRequests, elapsedMs: Date.now() - started, liveSource: true, liveProvider: false};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({out, ...result}, null, 2));
if (failures.length) process.exitCode = 1;
