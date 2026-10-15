// Offline representative parsing and request-count observations; run from the repository root.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.cwd(), extension = path.join(root, 'apps/extension');
const source = path.join(extension, 'src/sources/shared/mangathemesia').replaceAll('\\', '/');
const {build} = createRequire(path.join(extension, 'package.json'))('vite');
const base = path.join(root, 'artifacts/mangathemesia-performance');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const entry = source + '/tests/performance-entry', virtual = '\0mangathemesia-performance-entry';
await build({configFile: false, root: extension, logLevel: 'error',
  plugins: [{name: 'mangathemesia-performance-entry',
    resolveId(id) {if (id.replaceAll('\\', '/') === entry) return virtual;},
    load(id) {
      if (id !== virtual) return;
      return `export {createMangaThemesiaNetwork} from ${JSON.stringify(source + '/network.ts')};
        export {fixtureSite,catalogHtml,readerHtml,searchHtml,work,chapter,pageUrl} from ${JSON.stringify(source + '/tests/fixtures.ts')};`;
    },
  }],
  build: {outDir: out, emptyOutDir: false, reportCompressedSize: false,
    lib: {entry, formats: ['es'], fileName: () => 'fixtures.mjs'}},
});
const fixture = await import(pathToFileURL(path.join(out, 'fixtures.mjs')).href);
const site = fixture.fixtureSite('performance'), engine = fixture.createMangaThemesiaNetwork(site);
const catalogUrl = site.catalogUrl(fixture.work), readerUrl = site.chapterUrl(fixture.chapter, fixture.work);
const input = {siteId: site.id, query: 'performance'};
const cases = [
  {operation: 'catalog', html: fixture.catalogHtml(site, Array.from({length: 1000}, (_, i) => `sample-chapter-${1000 - i}`)),
    target: catalogUrl, expected: 1000, iterations: 50, parse: engine.parseCatalog, count: value => value.entries.length},
  {operation: 'pages', html: fixture.readerHtml(site, Array.from({length: 100}, (_, i) => fixture.pageUrl(site, i))),
    target: readerUrl, expected: 100, iterations: 200, parse: engine.parsePages, count: value => value.items.length},
  {operation: 'search', html: fixture.searchHtml(site, 20, 1, false, input.query),
    target: input, expected: 20, iterations: 200, parse: engine.parseSearch, count: value => value.items.length},
];
const requests = {};
for (const item of cases) {
  const calls = [], expectedUrl = item.operation === 'pages' ? site.chapterUrl(fixture.chapter)
    : item.operation === 'search' ? site.searchUrl(input.query, 1) : catalogUrl;
  const result = await engine.network[item.operation](item.target, {request: async (url, options) => {
    calls.push({url, options});
    assert.equal(url, expectedUrl, 'A fixture must use only its declared endpoint');
    assert.equal(options?.form, undefined, 'No view counters, mutations or speculative POSTs');
    return item.html;
  }});
  assert.equal(item.count(result), item.expected);
  assert.equal(calls.length, 1, `${item.operation} must not prefetch chapters, images or further result pages`);
  requests[item.operation] = calls.length;
}
let resolveCount = 0;
assert.equal(await engine.network.resolveCatalog(site.chapterUrl(fixture.chapter), {request: async (url, options) => {
  resolveCount++;
  assert.equal(url, site.chapterUrl(fixture.chapter));
  assert.equal(options?.form, undefined);
  return cases[1].html;
}}), catalogUrl);
assert.equal(resolveCount, 1);
requests.resolveCatalog = resolveCount;

const rounds = 5, warmup = 10, timings = [];
for (const item of cases) {
  const samplesMs = [];
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < warmup; i++) assert.equal(item.count(item.parse(item.html, item.target)), item.expected);
    let count = 0;
    const start = performance.now();
    for (let i = 0; i < item.iterations; i++) count += item.count(item.parse(item.html, item.target));
    samplesMs.push((performance.now() - start) / item.iterations);
    assert.equal(count, item.iterations * item.expected);
  }
  timings.push({operation: item.operation, entries: item.expected, htmlBytes: Buffer.byteLength(item.html),
    iterationsPerRound: item.iterations, rounds, warmupPerRound: warmup,
    medianMs: [...samplesMs].sort((a, b) => a - b)[Math.floor(rounds / 2)], samplesMs});
}
const report = {node: process.version,
  method: 'Original synthetic HTML: 1000 chapters, 100 JSON page slots and 20 search cards. Synchronous parser timings with warmup; medians are observations, not pass/fail thresholds. Mocked transport verifies exactly one read-only request per operation.',
  boundary: 'New engine; no before/after comparison is claimed. Does not measure real-source latency, browser rendering, permissions, image decoding, extension-wide bundle size or translation models.',
  requests, timings};
await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({out, ...report}, null, 2));
