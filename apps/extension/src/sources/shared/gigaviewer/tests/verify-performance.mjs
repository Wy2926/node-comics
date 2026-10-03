// Read-only baseline comparison; outputs go to ignored artifacts. Run from the repository root.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.cwd(), source = path.join(root, 'apps/extension/src').replaceAll('\\', '/');
const baseline = execFileSync('git', ['rev-parse', process.argv[2] || 'HEAD'], {encoding: 'utf8'}).trim();
const base = path.join(root, 'artifacts/gigaviewer-performance'); await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
async function bundle(name) {
  await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error',
    plugins: name === 'before' ? [{name: 'git-baseline', enforce: 'pre', load(id) {
      if (!id.startsWith(source + '/') || !id.endsWith('.ts')) return;
      return execFileSync('git', ['show', baseline + ':' + path.relative(root, id).replaceAll('\\', '/')], {encoding: 'utf8'});
    }}] : [],
    build: {outDir: out, emptyOutDir: false, lib: {entry: source + '/sources/sites/sundaywebry/page.ts', formats: ['es'], fileName: () => name + '.mjs'}},
  });
  return (await import(pathToFileURL(path.join(out, name + '.mjs')).href)).createPage;
}
const before = await bundle('before'), after = await bundle('after');
function fixture(factory, state) {
  const product = {id: '11', typeName: 'episode', permalink: 'https://www.sunday-webry.com/episode/11', title: 'fixture', series: {id: '7', title: 'fixture'},
    pageStructure: {readingDirection: 'rtl', choJuGiga: 'baku', pages: Array.from({length: 38}, (_, i) =>
      ({type: 'main', width: 1125, height: 1600, src: `https://cdn-img.www.sunday-webry.com/public/page/2/${1000 + i}-abcdef`}))}};
  if (state === 'invalid') product.pageStructure.choJuGiga = 'future-format';
  const raw = JSON.stringify({readableProduct: product});
  const elements = product.pageStructure.pages.map(() => ({width: 1125, height: 1600, isConnected: true}));
  const areas = elements.map(element => ({querySelector: () => element}));
  const document = {title: 'fixture', querySelector: () => ({getAttribute: () => raw}), querySelectorAll: () => areas};
  return factory({document, signal: new AbortController().signal,
    location: {url: product.permalink, sourceId: 'sundaywebry', pageKey: '11', kind: 'reader'}});
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const state of ['ready', 'invalid']) {
  const timings = {before: [], after: []}, iterations = 5000;
  for (let round = 0; round < 7; round++) for (const [name, factory] of round % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]]) {
    const session = fixture(factory, state), count = state === 'ready' ? 38 : 0;
    for (let i = 0; i < 100; i++) assert.equal(session.inlineTargets().length, count);
    const start = performance.now(); let total = 0;
    for (let i = 0; i < iterations; i++) total += session.inlineTargets().length;
    timings[name].push((performance.now() - start) / iterations); assert.equal(total, iterations * count); session.dispose();
  }
  results.push({state, pages: 38, scansPerRound: iterations, rounds: 7,
    beforeMsPerScan: median(timings.before), afterMsPerScan: median(timings.after)});
}
await writeFile(path.join(out, 'results.json'), JSON.stringify({baseline, fixture: 'Node DOM stub; no network or bitmap decoding', results}, null, 2));
console.log(JSON.stringify({out, baseline, results}, null, 2));
