// Public source verification. Browser mode lets the site's normal navigation establish its session.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = process.cwd(), base = path.join(root, 'artifacts/baozimh/http');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: out, emptyOutDir: false,
  lib: {entry: path.join(root, 'apps/extension/src/sources/sites/baozimh/network.ts'), formats: ['es'], fileName: () => 'network.mjs'}}});
const {network} = await import(pathToFileURL(path.join(out, 'network.mjs')).href);
let browser, page, requests = 0;
async function request(url) {
  assert(['cn.baozimh.com', 'cn.twbzmg.com'].includes(new URL(url).hostname)); requests++;
  const response = page ? await page.context().request.get(url) : await fetch(url, {signal: AbortSignal.timeout(30000)});
  assert(page ? response.ok() : response.ok, `Source HTTP ${page ? response.status() : response.status}`);
  return response.text();
}
try {
  if (process.env.BAOZIMH_BROWSER_SESSION === '1') {
    const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({headless: true, executablePath: process.env.TEST_CHROMIUM});
    page = await browser.newPage(); await page.goto('https://cn.baozimh.com/', {waitUntil: 'domcontentloaded'});
    await page.locator('a[href="/classify"]').first().waitFor({timeout: 30000});
  }
  const query = {siteId: 'baozimh', query: '芙莉莲'}, hits = await network.search(query, {request});
  const doupo = await network.search({siteId: 'baozimh', query: '斗破'}, {request});
  assert(doupo.items.some(hit => hit.title === '斗破苍穹'));
  const doupoMore = doupo.nextCursor ? await network.search({siteId: 'baozimh', query: '斗破', cursor: doupo.nextCursor}, {request}) : {items: []};
  const hit = hits.items.find(row => row.title === '葬送者芙莉莲'); assert(hit);
  assert(hits.nextCursor); const more = await network.search({...query, cursor: hits.nextCursor}, {request}); assert(more.items.length);
  const catalog = await network.catalog(hit.catalogUrl, {request}); assert(catalog.complete && catalog.entries.length > 100);
  const short = await network.catalog('https://cn.baozimh.com/comic/2026bianfurilianggeshijiedebianfuxia-dccomics', {request});
  assert(short.complete && short.entries.length > 0 && short.entries.length <= 24);
  const shortPages = await network.pages(short.entries[0].url, {request}); assert(shortPages.discoveryComplete && shortPages.items.length);
  const volume = catalog.entries.find(row => row.title === '第01卷'); assert(volume);
  const pages = await network.pages(volume.url, {request}); assert(pages.discoveryComplete && pages.items.length > 100);
  const bytes = [];
  for (const url of [catalog.cover.url, pages.items[0].resource.url]) {
    const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
    assert(response.ok && response.headers.get('content-type').startsWith('image/')); bytes.push((await response.arrayBuffer()).byteLength);
  }
  // The site's fuzzy search can return real suggestions even for an unrelated query.
  await network.search({siteId: 'baozimh', query: 'zzqv987654nonexistent'}, {request});
  const result = {status: 'passed', requests, search: hits.items.length + more.items.length, doupoSearch: doupo.items.length + doupoMore.items.length, entries: catalog.entries.length, shortEntries: short.entries.length, shortPages: shortPages.items.length,
    pages: pages.items.length, uniqueImages: new Set(pages.items.map(p => p.resource.url)).size, bytes};
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({out, ...result}));
} finally {await browser?.close();}
