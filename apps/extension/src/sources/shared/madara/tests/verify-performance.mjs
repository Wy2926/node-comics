// Offline comparison against a pre-migration git ref; run from the repository root.
// Generated bundles and measurements stay under ignored artifacts/madara-performance/.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';

const root = process.cwd(), normalize = value => value.replaceAll('\\', '/');
const source = normalize(path.join(root, 'apps/extension/src'));
const baseline = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${process.argv[2] || 'HEAD'}^{commit}`], {encoding: 'utf8'}).trim();
const baselineFiles = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', baseline, '--', 'apps/extension/src'], {encoding: 'utf8'}).trim().split('\n'));
const base = path.join(root, 'artifacts/madara-performance');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
const entry = source + '/sources/sites/webtoonscan/network.ts';
const relative = file => normalize(path.relative(root, file));

async function bundle(name) {
  const before = name === 'before';
  const baselineReads = new Set(), modules = new Set();
  await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error',
    plugins: [{name: 'offline-source-comparison', enforce: 'pre',
      resolveId(id, importer) {
        if (!before || !importer?.startsWith(source + '/') || !id.startsWith('.')) return;
        const [target, query] = id.split('?');
        const resolved = normalize(path.resolve(path.dirname(importer.split('?')[0]), target));
        const file = [resolved, resolved + '.ts', resolved + '/index.ts'].find(candidate => baselineFiles.has(relative(candidate)));
        if (!file) throw Error(`Baseline dependency is absent: ${id} from ${relative(importer)}`);
        return file + (query ? '?' + query : '');
      },
      async load(id) {
        const [file, query] = id.split('?');
        if (!file.startsWith(source + '/')) return;
        // Use the same inline SVG representation on both sides; no live assets are fetched.
        const svg = file.endsWith('.svg') && query === 'inline';
        if (!svg && (!before || !/\.(?:ts|json)$/.test(file))) return;
        const content = before
          ? execFileSync('git', ['show', `${baseline}:${relative(file)}`], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024})
          : await readFile(file, 'utf8');
        if (before) baselineReads.add(file);
        return svg ? `export default ${JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(content).toString('base64'))};` : content;
      },
      moduleParsed({id}) {
        const file = id.split('?')[0];
        if (!file.startsWith(source + '/')) return;
        modules.add(relative(file));
        if (before) assert(baselineReads.has(file), `Baseline unexpectedly used a working-tree module: ${relative(file)}`);
      },
    }],
    build: {outDir: out, emptyOutDir: false, reportCompressedSize: false,
      lib: {entry, formats: ['es'], fileName: () => name + '.mjs'}},
  });
  const file = path.join(out, name + '.mjs'), bytes = await readFile(file);
  return {module: await import(pathToFileURL(file).href), bytes: bytes.length, gzipBytes: gzipSync(bytes, {level: 9}).length,
    sourceModules: [...modules].sort()};
}

const before = await bundle('before'), after = await bundle('after');
// Original fixture text only: 1000 native descending chapters, 100 lazy image slots,
// and 20 search cards. No source HTML, artwork bytes, browser or model is involved.
const origin = 'https://webtoonscan.com', url = origin + '/manhwa/performance-book/', reader = url + 'chapter-1/';
const artwork = 'https://images.example.test/performance-cover.jpg';
const canonical = value => `<link rel="canonical" href="${value}">`;
const poster = owner => `<a href="${owner}"><img src="${artwork}"></a>`;
const catalogHtml = `${canonical(url)}<h1>Performance fixture</h1><div class="summary_image">${poster(url)}</div>
  <div class="listing-chapters_wrap show-more"><ul class="main version-chap no-volumn active">${Array.from({length: 1000}, (_, i) =>
    `<li class="wp-manga-chapter"><a href="${url}chapter-${1000 - i}/">Chapter ${1000 - i}</a><span class="chapter-release-date">2026</span></li>`).join('')}</ul></div>`;
const readerHtml = `${canonical(reader)}<h1 id="chapter-heading">Performance fixture - chapter 1</h1>
  <select class="single-chapter-select"><option value="chapter-1" data-redirect="${reader}" selected="selected">Chapter 1</option></select>
  <div class="reading-content"><input id="wp-manga-current-chap" data-id="42" value="chapter-1">${Array.from({length: 100}, (_, i) =>
    `<div class="page-break no-gaps"><img id="image-${i}" class="wp-manga-chapter-img" src="data:image/gif;base64,placeholder" data-src="https://images.example.test/pages/${i}.jpg"></div>`).join('')}</div>`;
const searchInput = {siteId: 'webtoonscan', query: 'performance'};
const searchHtml = `<input class="search-field" name="s" value="performance"><h1 class="h4">20 results for "performance"</h1>${Array.from({length: 20}, (_, i) => {
  const work = `${origin}/manhwa/performance-${i}/`;
  return `<div class="row c-tabs-item__content"><div class="tab-thumb">${poster(work)}</div><div class="tab-summary"><div class="post-title"><h3><a href="${work}">Performance &amp; Book ${i}</a></h3></div></div></div>`;
}).join('')}`;
const cases = [
  {operation: 'catalog', html: catalogHtml, target: url, expected: 1000, iterations: 100, parse: module => module.parseCatalog, count: value => value.entries.length},
  {operation: 'pages', html: readerHtml, target: reader, expected: 100, iterations: 400, parse: module => module.parsePages, count: value => value.items.length},
];
const stable = value => {const {observedAt, ...result} = value; return result;};
for (const fixture of cases) {
  const left = fixture.parse(before.module)(fixture.html, fixture.target), right = fixture.parse(after.module)(fixture.html, fixture.target);
  assert.equal(fixture.count(left), fixture.expected);
  assert.equal(fixture.count(right), fixture.expected);
  assert.deepEqual(stable(right), stable(left), `${fixture.operation} must preserve the baseline snapshot`);
}

const requests = {}, outputs = {};
for (const [name, built] of [['before', before], ['after', after]]) {
  requests[name] = {}; outputs[name] = {};
  for (const fixture of [...cases, {operation: 'search', html: searchHtml, target: searchInput, expected: 20, count: value => value.items.length}]) {
    const calls = [], expectedUrl = fixture.operation === 'pages' ? reader + '?style=list'
      : fixture.operation === 'search' ? origin + '/?s=performance&post_type=wp-manga' : url;
    const result = await built.module.network[fixture.operation](fixture.target, {request: async (target, options) => {
      calls.push({url: target, options});
      assert.equal(target, expectedUrl, `${name} ${fixture.operation} requested an unexpected URL`);
      assert.equal(options?.form, undefined, 'Static fixtures must not trigger an AJAX fallback');
      return fixture.html;
    }});
    assert.equal(fixture.count(result), fixture.expected);
    assert.equal(calls.length, 1, `${name} ${fixture.operation} must use one request`);
    requests[name][fixture.operation] = calls.length;
    outputs[name][fixture.operation] = stable(result);
  }
}
for (const operation of ['catalog', 'pages', 'search'])
  assert.deepEqual(outputs.after[operation], outputs.before[operation], `${operation} network output must preserve the baseline snapshot`);

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rounds = 7, warmup = 25, timings = [];
for (const fixture of cases) {
  const samples = {before: [], after: []};
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]];
    for (const [name, built] of order) {
      const parse = fixture.parse(built.module);
      for (let i = 0; i < warmup; i++) assert.equal(fixture.count(parse(fixture.html, fixture.target)), fixture.expected);
      let count = 0;
      const start = performance.now();
      for (let i = 0; i < fixture.iterations; i++) count += fixture.count(parse(fixture.html, fixture.target));
      samples[name].push((performance.now() - start) / fixture.iterations);
      assert.equal(count, fixture.iterations * fixture.expected);
    }
  }
  const beforeMs = median(samples.before), afterMs = median(samples.after);
  timings.push({operation: fixture.operation, entries: fixture.expected, htmlBytes: Buffer.byteLength(fixture.html),
    iterationsPerRound: fixture.iterations, rounds, warmupPerRound: warmup, beforeMs, afterMs,
    changePercent: (afterMs / beforeMs - 1) * 100, samplesMs: samples});
}
const report = {baseline, node: process.version,
  method: 'Offline synthetic HTML; synchronous parser median of alternating-order rounds; stubbed request counts; tree-shaken Vite network-entry bundles, gzip level 9. Timings are observations, not pass/fail thresholds.',
  boundary: 'Does not measure browser DOM/rendering, real-source latency, extension-wide bundle size, image decoding or translation models.',
  bundles: {before: {bytes: before.bytes, gzipBytes: before.gzipBytes}, after: {bytes: after.bytes, gzipBytes: after.gzipBytes},
    gzipChangeBytes: after.gzipBytes - before.gzipBytes},
  sourceModules: {before: before.sourceModules, after: after.sourceModules},
  equivalentOutputs: ['catalog', 'pages', 'search'], requests, timings};
await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({out, ...report}, null, 2));
