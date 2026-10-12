// Built MV3 + isolated profile + synthetic source/artwork. No external API/model requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = process.cwd(), base = path.join(root, 'artifacts/webtoonscan/browser');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
await cp(path.resolve(process.env.TEST_EXTENSION_DIR || 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/');
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
const compile = async (entry, name, destination) => build({configFile: false, publicDir: false, logLevel: 'error', build: {
  outDir: destination, emptyOutDir: false, lib: {entry, formats: ['es'], fileName: () => name}}});
await compile(source + '/sources/sites/webtoonscan/tests/fixtures.ts', 'fixtures.mjs', out);
const f = await import(pathToFileURL(path.join(out, 'fixtures.mjs')).href);
const probe = path.join(out, 'probe.mjs');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
  export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
  export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
  export {searchSource, releaseSourceSearchSession, sourceLocation} from '${source}/sources/index.ts';`);
await compile(probe, 'verify-source.js', extension);
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true,
  executablePath: process.env.TEST_CHROMIUM, viewport: {width: 1440, height: 1000}, locale: 'zh-CN',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
browser.setDefaultTimeout(20000);
const checks = []; let reader, failCatalog = false;
try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const home = new URL('reader.html', worker.url()).href, setup = await browser.newPage(); await setup.goto(home);
  const png = await setup.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 900;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#e2edfa'; ctx.fillRect(0, 0, 600, 900);
    ctx.fillStyle = '#214467'; ctx.fillRect(50, 60, 500, 500); ctx.fillStyle = '#fff'; ctx.font = '32px sans-serif';
    ctx.fillText('WebtoonScan fixture', 90, 300); return c.toDataURL('image/png').split(',')[1];
  });
  const responses = {[f.url]: {body: f.catalogHtml(), contentType: 'text/html'},
    [f.origin + '/?s=sample&post_type=wp-manga']: {body: f.searchHtml(), contentType: 'text/html'},
    [f.artwork]: {body: png, contentType: 'image/png', base64: true},
    [f.image]: {body: png, contentType: 'image/png', base64: true}};
  for (const id of ['0', 'chapter-1', 'chapter-2.5']) {
    const body = '<!doctype html><meta charset="utf-8"><style>img{display:block;width:600px;height:900px}</style>' + f.readerHtml(Array(6).fill(f.image), id);
    for (const suffix of ['', '?style=list']) responses[f.url + id + '/' + suffix] = {body, contentType: 'text/html'};
  }
  await browser.route('https://**/*', route => {
    const url = route.request().url(), data = responses[url];
    return route.fulfill(data && !(failCatalog && url === f.url)
      ? {status: 200, contentType: data.contentType, body: data.base64 ? Buffer.from(data.body, 'base64') : data.body}
      : {status: 503, body: '{}'});
  });
  await worker.evaluate(responses => {
    globalThis.fetch = async input => {
      const data = responses[String(typeof input === 'string' ? input : input.url ?? input)];
      return data ? new Response(data.base64 ? Uint8Array.from(atob(data.body), c => c.charCodeAt(0)) : data.body,
        {headers: {'Content-Type': data.contentType}}) : new Response('{}', {status: 503});
    };
  }, responses);
  await setup.evaluate(async () => {
    const settings = {uiLanguage: 'zh-CN', language: 'en', layout: 'single', fit: 'window', autoTranslateTabs: false, discoveryTextTranslation: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});
  });
  await setup.reload(); await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByRole('heading', {name: 'WebtoonScan', exact: true}).waitFor();
  await setup.screenshot({path: path.join(out, 'site-directory.png')});
  const found = await setup.evaluate(async () => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), sessionId = 'webtoonscan-test';
    try {return (await p.searchSource('webtoonscan', {siteId: 'webtoonscan', query: 'sample'}, {sessionId})).items.length;}
    finally {p.releaseSourceSearchSession(sessionId);}
  });
  assert.equal(found, 1); checks.push('Static site listing and registered source search');
  const site = await browser.newPage(); await site.goto(f.reader);
  const entry = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}); await entry.waitFor();
  await site.screenshot({path: path.join(out, 'embedded-entry.png')});
  const opened = browser.waitForEvent('page'); await entry.click(); reader = await opened;
  await reader.waitForURL('**/reader.html?catalog=*'); await reader.getByLabel('跳转页码', {exact: true}).waitFor();
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0);
  const details = await reader.evaluate(async chapter => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), comic = (await p.catalog.list('comics'))[0];
    const entries = await p.catalog.listEntries(comic.id, {limit: 10000}), entry = entries.find(e => e.sourceEntryId === p.sourceLocation(chapter).pageKey);
    return {comicId: comic.id, entryId: entry.id, entries: entries.length, pages: entry.pageCount};
  }, f.reader);
  assert.equal(details.entries, 3); assert.equal(details.pages, 6);
  const jump = reader.getByLabel('跳转页码', {exact: true}); await jump.fill('4'); await jump.press('Enter');
  await reader.waitForFunction(async ({entryId}) => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), entry = await p.catalog.get('entries', entryId);
    const pages = await p.catalog.listPages(entry.contentId), pos = await p.catalog.get('positions', entryId);
    const image = document.querySelector('[data-page-index="3"] img.nc-page-image');
    return pos?.pageId === pages[3]?.pageId && image?.naturalWidth === 600;
  }, details);
  const waitVisiblePage = () => reader.waitForFunction(() => [...document.querySelectorAll('[data-page-index="3"] img.nc-page-image')].some(image => {
    const rect = image.getBoundingClientRect();
    return image.complete && image.naturalWidth === 600 && image.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
      rect.top < innerHeight && rect.bottom > 0 && rect.width > 0;
  }));
  await waitVisiblePage();
  await reader.screenshot({path: path.join(out, 'reader.png')}); checks.push('Embedded chapter import, source-page transport, image decoding and page 4 saved');
  const state = async () => reader.evaluate(async ({comicId, entryId}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    return {count: (await catalog.listEntries(comicId, {limit: 10000})).length, position: await catalog.get('positions', entryId)};
  }, details);
  const before = await state(), route = reader.url(); await reader.close(); reader = await browser.newPage(); await reader.goto(route);
  await reader.getByRole('button', {name: '打开漫画 ' + f.title, exact: true}).click();
  await reader.getByLabel('跳转页码', {exact: true}).waitFor();
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '4');
  await waitVisiblePage();
  await reader.screenshot({path: path.join(out, 'reopened.png')}); checks.push('Close/reopen restores the selected chapter and page');
  const refresh = async () => reader.evaluate(async ({comicId, url}) => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), comic = await p.catalog.get('comics', comicId);
    const snapshot = await p.readWebsiteCatalog(url); await p.applyCatalogRefresh(comicId, comic.source.generation, snapshot);
    return (await p.catalog.get('comics', comicId)).catalogUpdates?.count ?? 0;
  }, {...details, url: f.url});
  assert.equal(await refresh(), 0); assert.equal(await refresh(), 0);
  failCatalog = true; await assert.rejects(refresh); assert.deepEqual(await state(), before); failCatalog = false;
  checks.push('Repeat refresh and source failure preserve the catalog and reading position');
  await writeFile(path.join(out, 'result.json'), JSON.stringify({checks, details, liveSource: false, liveProvider: false}, null, 2));
  console.log(JSON.stringify({out, checks}, null, 2));
} catch (error) {
  if (reader && !reader.isClosed()) await reader.screenshot({path: path.join(out, 'failure.png')});
  console.log(JSON.stringify({out, checks})); throw error;
} finally {await browser.close();}
