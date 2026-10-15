// Run from the repository root. Only public GETs, or explicit replay of captured raw HTTP responses.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.cwd(), origin = 'https://mangaeclipse.com';
const savedIndex = process.argv.indexOf('--saved');
assert(savedIndex === -1 || process.argv[savedIndex + 1], '--saved requires a capture directory');
const saved = savedIndex < 0 ? null : path.resolve(process.argv[savedIndex + 1]);
const records = saved ? JSON.parse(await readFile(path.join(saved, 'manifest.json'), 'utf8')).requests.filter(record => record.file && record.status === 200) : [];
const base = path.join(root, 'artifacts/mangaeclipse/http');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, publicDir: false, logLevel: 'error', build: {outDir: out, emptyOutDir: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/mangaeclipse/network.ts'), formats: ['es'], fileName: () => 'network.mjs'}}});
const {network} = await import(pathToFileURL(path.join(out, 'network.mjs')).href);
let requests = 0;
const context = {request: async url => {
  requests++; assert(requests <= 6, 'Unexpected extra request');
  if (saved) {
    const record = records.find(record => record.url === url); assert(record, `No captured response for ${url}`);
    const filename = path.resolve(saved, record.file); assert(filename.startsWith(saved + path.sep), 'Capture path outside selected directory');
    const bytes = await readFile(filename);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, 'Captured response checksum changed');
    return bytes.toString('utf8');
  }
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  assert(response.ok, `Source HTTP ${response.status}; no automatic transport fallback`);
  assert(response.headers.get('content-type')?.includes('text/html'), 'Not an HTML response');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {size += chunk.length; assert(size <= 8 * 1024 * 1024, 'Response exceeds HTTP budget'); chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}};
const works = [];
for (const slug of ['peculiar-tales-of-swords-and-blades', 'world-apocalypse-online']) {
  const catalog = await network.catalog(`${origin}/manga/${slug}/`, context);
  assert(catalog.complete && catalog.cover && catalog.entries.length > 0);
  const chapters = [];
  for (const entry of [catalog.entries[0], catalog.entries.at(-1)]) {
    const pages = await network.pages(entry.url, context);
    assert(pages.discoveryComplete && pages.items.length > 0);
    assert.equal(pages.knownTotal, pages.items.length);
    chapters.push({id: entry.id, title: pages.title, pages: pages.items.length, complete: pages.discoveryComplete});
  }
  works.push({slug, title: catalog.title, entries: catalog.entries.length, complete: catalog.complete, cover: true, chapters});
}
assert.equal(requests, 6);
const result = {works, requests, mode: saved ? 'captured raw HTTP response replay' : 'live direct HTTP',
  boundary: 'Uses the packaged adapter. Does not verify browser page transport, extension import/render/reopen/permissions, image decoding or translation models.'};
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({out, ...result}, null, 2));
