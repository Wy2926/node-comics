// Run from the repository root. Public source HTTP only; no product API, account or model.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.cwd(), output = path.join(root, 'artifacts/comicpash/search-http');
await mkdir(output, {recursive: true});
const temporary = await mkdtemp(path.join(output, 'probe-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: temporary, emptyOutDir: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/comicpash/network.ts'), formats: ['es'], fileName: () => 'network.mjs'},
}});
const {network} = await import(pathToFileURL(path.join(temporary, 'network.mjs')).href);
const requests = [], results = [];
for (const query of ['の', 'zzzznodelanesearchzzzz']) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  const context = {signal: controller.signal, request: async target => {
    const url = new URL(target);
    assert.equal(url.origin, 'https://comicpash.jp');
    assert.equal(url.pathname, '/api/search');

    requests.push({origin: url.origin, path: url.pathname});
    const response = await fetch(target, {signal: controller.signal, redirect: 'error'});
    assert(response.ok, 'Public source HTTP ' + response.status);
    return response.text();
  }};
  try {
    const first = await network.search({siteId: 'comicpash', query}, context);
    clearTimeout(timer);
    assert(first.items.length <= 50);
    assert(query === 'zzzznodelanesearchzzzz' ? first.items.length === 0 && !first.nextCursor : first.items.length > 0 && first.nextCursor);

    assert(first.items.every(item => item.catalogId && item.title && item.catalogUrl && !item.contentLanguages));
    const nextTimer = setTimeout(() => controller.abort(), 15000);
    let second;
    try { second = first.nextCursor ? await network.search({siteId: 'comicpash', query, cursor: first.nextCursor}, context) : undefined; }
    finally { clearTimeout(nextTimer); }
    if (second) assert(second.items.length > 0 && second.items.every(item => !first.items.some(previous => previous.catalogId === item.catalogId)));
    results.push({query, firstCount: first.items.length, secondCount: second?.items.length ?? 0, firstIdentity: first.items[0]?.catalogId});
  } finally { clearTimeout(timer); }
}
const report = {results, requests, boundary: 'Live public HTTP search and parser only; no browser host-permission, source login, import, reader or model acceptance.'};
await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
