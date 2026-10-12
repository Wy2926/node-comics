// Run from repository root. Public source only; no account or model requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root = process.cwd(), base = path.join(root, 'artifacts/webtoonscan/http');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, publicDir: false, logLevel: 'error', build: {outDir: out, emptyOutDir: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/webtoonscan/network.ts'), formats: ['iife'], name: 'WebtoonProbe', fileName: () => 'probe.js'}}});
const bundle = await readFile(path.join(out, 'probe.js'), 'utf8');
const run = `(async () => {${bundle}
  const origin = 'https://webtoonscan.com', works = []; let requests = 0;
  const context = {request: async url => {
    requests++; const r = await fetch(url, {signal: AbortSignal.timeout(30000)});
    if (!r.ok) throw Error('Source HTTP ' + r.status); return r.text();
  }};
  for (const slug of ['emperor-of-solo-play', 'solo-bug-player']) {
    const catalog = await WebtoonProbe.network.catalog(origin + '/manhwa/' + slug + '/', context);
    const chapters = [];
    for (const entry of [catalog.entries[0], catalog.entries.at(-1)]) {
      const pages = await WebtoonProbe.network.pages(entry.url, context);
      chapters.push({id: entry.id, pages: pages.items.length, complete: pages.discoveryComplete,
        imageHosts: [...new Set(pages.items.map(p => new URL(p.resource.url).hostname))]});
    }
    works.push({slug, entries: catalog.entries.length, complete: catalog.complete, cover: !!catalog.cover, chapters});
  }
  const query = {siteId: 'webtoonscan', query: 'level'};
  const first = await WebtoonProbe.network.search(query, context);
  const second = first.nextCursor ? await WebtoonProbe.network.search({...query, cursor: first.nextCursor}, context) : null;
  const empty = await WebtoonProbe.network.search({...query, query: 'NodeLaneFixtureNoSuchTitle987654'}, context);
  return {works, search: {first: first.items.length, second: second?.items.length, empty: empty.items.length}, requests};
})()`;
let result;
if (process.argv.includes('--browser')) {
  // Reuse an already authorized browser-harness tab on this site. Never copy cookies or solve challenges.
  const python = `import json, base64\nassert page_info()['url'].startswith('https://webtoonscan.com/'), 'Open WebtoonScan in the harness tab first'\nprint(json.dumps(js(base64.b64decode('${Buffer.from(run).toString('base64')}').decode('utf-8'))))\n`;
  const response = spawnSync('browser-harness', {input: python, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024});
  if (response.status !== 0) throw Error(response.stderr || response.stdout || String(response.error));
  result = JSON.parse(response.stdout.trim());
} else {
  result = await (new Function('return ' + run))();
}
assert(result.works.every(w => w.complete && w.cover && w.entries > 0 && w.chapters.every(c => c.complete && c.pages > 0)));
assert(result.search.first === 20 && result.search.second > 0 && result.search.empty === 0);
result.transport = process.argv.includes('--browser') ? 'authorized source-page HTTP' : 'direct HTTP';
result.boundary = 'Real HTML parsed by packaged adapter. Browser extension permissions, image decoding and model effects are separate checks.';
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({out, ...result}, null, 2));
