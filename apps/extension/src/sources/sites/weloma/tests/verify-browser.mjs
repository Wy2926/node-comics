import {setReaderProgress} from '../../../../../tests/reader-progress-driver.mjs';
// Real public source/CDN + isolated built MV3 extension. No login or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), base = path.join(root, 'artifacts/weloma/browser');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
await cp(path.resolve(process.env.TEST_EXTENSION_DIR || 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.mjs');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
  export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
  export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
  export {listSearchSites, searchSource, readSearchCover, releaseSourceSearchSession, sourceLocation} from '${source}/sources/index.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, publicDir: false, logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'}}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true,
  executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH, locale: 'zh-CN', viewport: {width: 1440, height: 1000},
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, contentType: 'application/json', body: '{}'}));
const checks = [], errors = []; let reader, details;
context.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const setup = await context.newPage(); await setup.goto(new URL('reader.html', worker.url()).href);
  await setup.evaluate(async () => {
    const settings = {uiLanguage: 'zh-CN', layout: 'single', fit: 'width', autoTranslateTabs: false, discoveryTextTranslation: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});
  });
  await setup.reload(); await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByRole('heading', {name: 'WeLoMa', exact: true}).waitFor();
  await setup.screenshot({path: path.join(out, 'site-directory.png')});
  const found = await setup.evaluate(async () => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), sessionId = 'weloma-browser';
    try {
      const results = await p.searchSource('weloma', {siteId: 'weloma', query: 'blue lock'}, {sessionId});
      const bitmap = await createImageBitmap(await p.readSearchCover(results.items[0]));
      const dimensions = [bitmap.width, bitmap.height]; bitmap.close();
      return {registered: p.listSearchSites().some(s => s.key === 'weloma:weloma'), count: results.items.length, dimensions,
        comics: (await p.catalog.list('comics')).length};
    } finally {p.releaseSourceSearchSession(sessionId);}
  });
  assert(found.registered && found.count > 0 && found.dimensions.every(n => n > 0) && found.comics === 0);
  checks.push('Packaged site listing, real name search and cover decoding do not create library records');
  const chapter = process.env.WELOMA_READER_URL || 'https://weloma.net/c/eMV8K';
  const site = await context.newPage(); await site.goto(chapter, {waitUntil: 'domcontentloaded'});
  const button = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}); await button.waitFor();
  await site.screenshot({path: path.join(out, 'chapter-entry.png')});
  const opened = context.waitForEvent('page'); await button.click(); reader = await opened;
  await reader.waitForURL('**/reader.html?catalog=*');
  await reader.getByLabel('阅读进度', {exact: true}).waitFor({timeout: 60000});
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 60000});
  details = await reader.evaluate(async chapter => {
    const p = await import(chrome.runtime.getURL('verify-source.js'));
    const comic = (await p.catalog.list('comics')).find(c => c.source.connectionId === 'website:weloma');
    const entries = await p.catalog.listEntries(comic.id, {limit: 10000}), entry = entries.find(e => e.sourceEntryId === p.sourceLocation(chapter).pageKey);
    return {comicId: comic.id, entryId: entry.id, title: comic.title, catalogUrl: comic.sourceUrl, chapters: entries.length, pages: entry.pageCount};
  }, chapter);
  assert(details.chapters > 0 && details.pages > 1 && details.pages <= 100);
  const imageSelector = index => `[data-copy-id="${details.entryId}"] [data-page-index="${index}"] img.nc-page-image`;
  const jump = async number => {
    await setReaderProgress(reader.getByLabel('阅读进度', {exact: true}), String(number));

    await reader.waitForFunction(selector => {
      const img = document.querySelector(selector); return img?.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
    }, imageSelector(number - 1), {timeout: 60000});
  };
  for (let page = 1; page <= details.pages; page++) {await jump(page); console.log(`Decoded original page ${page}/${details.pages}`);}
  checks.push(`Bare chapter floating import binds ${details.chapters} catalog entries and decodes all ${details.pages} original pages`);
  const restorePage = Math.min(3, details.pages); await jump(restorePage);
  await reader.waitForFunction(async ({id, index}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js')); return (await catalog.get('positions', id))?.pageIndex === index;
  }, {id: details.entryId, index: restorePage - 1});
  const position = () => reader.evaluate(async id => (await import(chrome.runtime.getURL('verify-source.js'))).catalog.get('positions', id), details.entryId);
  const saved = await position(); await reader.screenshot({path: path.join(out, 'reader.png')});
  await reader.evaluate(() => {
    globalThis.welomaOriginalFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => new URL(typeof input === 'string' ? input : input.url ?? input).origin === 'https://weloma.net'
      ? Promise.resolve(new Response('Unavailable', {status: 503})) : globalThis.welomaOriginalFetch(input, options);
  });
  try {
    const failed = await reader.evaluate(async details => {
      const p = await import(chrome.runtime.getURL('verify-source.js')); let failed = false;
      try {await p.readWebsiteCatalog(details.catalogUrl);} catch {failed = true;}
      return {failed, count: (await p.catalog.listEntries(details.comicId, {limit: 10000})).length};
    }, details);
    assert(failed.failed && failed.count === details.chapters); assert.deepEqual(await position(), saved);
  } finally {await reader.evaluate(() => {globalThis.fetch = globalThis.welomaOriginalFetch; delete globalThis.welomaOriginalFetch;});}
  checks.push('Simulated catalog failure preserves the full directory and saved reading position');
  const route = reader.url(); await reader.close(); reader = await context.newPage(); await reader.goto(route);
  await reader.getByRole('button', {name: '打开漫画 ' + details.title, exact: true}).click();
  await reader.waitForFunction(({selector, page}) => document.querySelector(selector)?.naturalWidth > 0 &&
    document.querySelector('input[aria-label="阅读进度"]')?.value === String(page), {selector: imageSelector(restorePage - 1), page: restorePage});
  await reader.screenshot({path: path.join(out, 'reopened.png')});
  checks.push(`Close/reopen restores the selected chapter and page ${restorePage}`);
  await setup.getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = setup.locator(`[data-comic-id="${details.comicId}"] .nc-thumbnail img`); await cover.waitFor(); await cover.evaluate(i => i.decode());
  assert(await cover.evaluate(i => i.naturalWidth > 0)); await setup.screenshot({path: path.join(out, 'cover.png')});
  await site.close(); const tabs = context.pages().length;
  const refreshed = await reader.evaluate(async details => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), comic = await p.catalog.get('comics', details.comicId);
    const snapshot = await p.readWebsiteCatalog(details.catalogUrl);
    await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);
    return {count: (await p.catalog.listEntries(comic.id, {limit: 10000})).length, updates: (await p.catalog.get('comics', comic.id)).catalogUpdates?.count ?? 0};
  }, details);
  assert.deepEqual(refreshed, {count: details.chapters, updates: 0}); assert.equal(context.pages().length, tabs);
  checks.push('Dedicated shelf artwork decodes; repeated refresh needs no source tab and creates no duplicate updates');
  await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByLabel('通过链接添加漫画').fill(details.catalogUrl); await setup.getByRole('button', {name: '添加到书架', exact: true}).click();
  await setup.waitForFunction(page => document.querySelector('input[aria-label="阅读进度"]')?.value === String(page), restorePage);
  assert.equal(await setup.evaluate(async () => (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).length), 1);
  checks.push('Catalog link reimport preserves the chosen chapter/page and a single library record');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', checks, details, liveSource: true, liveProvider: false}, null, 2));
  console.log(JSON.stringify({out, checks, details}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', checks, details, errors, error: error.message}, null, 2));
  if (reader && !reader.isClosed()) await reader.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  console.log(JSON.stringify({out, checks, errors})); throw error;
} finally {await context.close();}
