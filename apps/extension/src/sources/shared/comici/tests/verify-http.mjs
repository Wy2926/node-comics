// Public, read-only live acceptance. Run a site's wrapper from the repository root.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function verifyComiciHttp({id, origin, queries, paginationQuery = 'の'}) {
  const root = process.cwd(), base = path.join(root, 'artifacts', id, 'http');
  await mkdir(base, {recursive: true});
  const out = await mkdtemp(path.join(base, 'run-'));
  const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
  await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
    outDir: out, emptyOutDir: false, lib: {
      entry: path.join(root, `apps/extension/src/sources/sites/${id}/network.ts`),
      formats: ['es'], fileName: () => 'network.mjs',
    },
  }});
  const {network} = await import(pathToFileURL(path.join(out, 'network.mjs')).href);
  const requests = [], results = [], started = performance.now();
  const context = {request: async target => {
    const url = new URL(target);
    assert.equal(url.origin, origin);
    const begin = performance.now();
    const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
    assert(response.ok, `Source HTTP ${response.status}`);
    const text = await response.text();
    requests.push({path: url.pathname, bytes: Buffer.byteLength(text), ms: Math.round(performance.now() - begin)});
    return text;
  }};
  async function imageBytes(url) {
    const response = await fetch(url, {headers: {Referer: origin + '/'}, signal: AbortSignal.timeout(30000)});
    assert(response.ok, `Image HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    // Some public Comici WebP covers are served as application/octet-stream.
    assert(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP', 'Expected raster image bytes');
    assert(bytes.length > 1000);
    return bytes.length;
  }
  try {
    for (const query of queries) {
      const search = await network.search({siteId: id, query}, context);
      assert(search.items.length, 'Expected live title search results');
      const hit = search.items[0], before = requests.length, begin = performance.now();
      const catalog = await network.catalog(hit.catalogUrl, context);
      const catalogMs = Math.round(performance.now() - begin), catalogRequests = requests.slice(before);
      assert(catalog.complete && catalog.id === hit.catalogId && catalog.entries.length > 0);
      assert.equal(new Set(catalog.entries.map(entry => entry.id)).size, catalog.entries.length);
      assert(catalog.entries.every(entry => entry.catalogId === catalog.id));
      const entry = catalog.entries.find(entry => entry.readable !== false);
      assert(entry, 'Expected a public first chapter');
      assert.equal(await network.resolveCatalog(entry.url.split('#')[0], context), hit.catalogUrl);
      const pages = await network.pages(entry.url, context);
      assert(pages.discoveryComplete && pages.items.length > 0 && pages.items.length === pages.knownTotal);
      assert(pages.items.every((page, order) => page.order === order && page.resource.kind === 'http'));
      assert.equal(new Set(pages.items.map(page => page.id)).size, pages.items.length);
      assert(catalog.cover?.url, 'Expected work artwork');
      results.push({query, catalogId: catalog.id, entryId: entry.remoteId, entries: catalog.entries.length,
        pages: pages.items.length, catalogRequests: catalogRequests.length, catalogMs,
        catalogBytes: catalogRequests.reduce((sum, request) => sum + request.bytes, 0),
        processing: pages.items[0].resource.processing?.split(':')[0],
        imageBytes: await imageBytes(pages.items[0].resource.url), coverBytes: await imageBytes(catalog.cover.url)});
    }
    assert.deepEqual((await network.search({siteId: id, query: 'zzqv987654nonexistent'}, context)).items, []);
    const first = await network.search({siteId: id, query: paginationQuery}, context);
    assert(first.nextCursor, 'Expected broad title search pagination');
    const second = await network.search({siteId: id, query: paginationQuery, cursor: first.nextCursor}, context);
    assert(second.items.some(hit => !first.items.some(previous => previous.catalogId === hit.catalogId)));
    const report = {status: 'passed', results, requests, elapsedMs: Math.round(performance.now() - started),
      searchPagination: true, searchPageOverlap: second.items.filter(hit => first.items.some(previous => previous.catalogId === hit.catalogId)).length,
      liveSource: true, liveProvider: false, browserVerified: false};
    await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({out, ...report}, null, 2));
  } catch (error) {
    const message = String(error.message).replace(/https?:\/\/[^\s"']+/g, '[source URL]');
    await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', results, requests, error: message}, null, 2));
    throw Error(`${id}: ${message}. Artifacts: ${out}`);
  }
}
