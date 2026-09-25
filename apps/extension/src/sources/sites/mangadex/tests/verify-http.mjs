// Explicit public-API probe; no MangaDex web page, account, product API, or translation model calls.
// From repository root: node apps/extension/src/sources/sites/mangadex/tests/verify-http.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.cwd(), output = path.join(root, 'artifacts/mangadex/http');
await mkdir(output, {recursive: true});
const temporary = await mkdtemp(path.join(output, 'probe-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: temporary, emptyOutDir: false, lib: {entry: path.join(root, 'apps/extension/src/sources/sites/mangadex/network.ts'), formats: ['es'], fileName: () => 'network.mjs'},
}});
const {network} = await import(pathToFileURL(path.join(temporary, 'network.mjs')).href);
const requests = [];
const context = {request: async target => {
  assert.equal(new URL(target).origin, 'https://api.mangadex.org');
  requests.push(new URL(target).pathname);
  const response = await fetch(target, {signal: AbortSignal.timeout(30000)});
  assert(response.ok, `MangaDex API HTTP ${response.status}`);
  return response.text();
}};
const source = await network.catalog('https://mangadex.org/title/42f40118-dff5-4f23-acbf-e54e89f026bd/okaeri-hatsukoi', context);
assert(source.complete);
assert(source.entries.length > 0);
const languages = [...new Set(source.entries.map(entry => entry.contentLanguage))];
assert(languages.includes('en') && languages.includes('zh-HK'));
assert.equal(new Set(source.entries.map(entry => entry.id)).size, source.entries.length);
const english = source.entries.find(entry => entry.contentLanguage === 'en' && entry.readingSlotId);
const chinese = source.entries.find(entry => entry.contentLanguage === 'zh-HK' && entry.readingSlotId === english.readingSlotId);
assert(chinese, 'The sample should expose more than one language at its first reading position');
assert.equal(english.sequenceId, chinese.sequenceId);
const pages = [];
for (const entry of [english, chinese]) {
  const bareUrl = entry.url.split('#')[0];
  assert.equal(await network.resolveCatalog(bareUrl, context), source.url);
  const snapshot = await network.pages(entry.url, context);
  assert(snapshot.discoveryComplete && snapshot.knownTotal > 0);
  assert(snapshot.items.every((item, index) => item.id === 'page-' + index && item.order === index && item.contentKey));
  const first = snapshot.items[0];
  assert.equal(first.resource.kind, 'http');
  const image = await fetch(first.resource.url, {signal: AbortSignal.timeout(30000)});
  assert(image.ok, `MangaDex image HTTP ${image.status}`);
  assert.match(image.headers.get('content-type') ?? '', /^image\//);
  const bytes = (await image.arrayBuffer()).byteLength;
  assert(bytes > 0);
  pages.push({language: entry.contentLanguage, chapterId: entry.remoteId, pageCount: snapshot.knownTotal, firstImageBytes: bytes,
    imageHost: new URL(first.resource.url).hostname});
}
const report = {catalogId: source.id, entries: source.entries.length, languages, readingSlots: new Set(source.entries.flatMap(entry => entry.readingSlotId ? [entry.readingSlotId] : [])).size,
  coverHost: new URL(source.cover.url).hostname, pages, apiRequests: requests.length,
  boundary: 'Live public API and first-image transfer only. This does not validate MangaDex DOM, browser host-permission prompts, reader decoding, or translation quality.'};
await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
