// Built MV3 extension, isolated profile, real public source/CDN. No translation requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {installFixture} from './browser-fixture.mjs';

const root = process.cwd(), base = path.join(root, 'artifacts/comickz/browser');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
await cp(path.resolve(process.env.TEST_EXTENSION_DIR || 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(extension, 'probe.mjs');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
  export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
  export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
  export {listSearchSites, searchSource, readSearchCover, releaseSourceSearchSession, sourceLocation} from '${source}/sources/index.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, publicDir: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'}}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true,
  executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH, locale: 'zh-CN', viewport: {width: 1440, height: 1000},
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
browser.setDefaultTimeout(30000);
await browser.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, contentType: 'application/json', body: '{}'}));
const fixture = process.env.COMICKZ_FIXTURE === '1', checks = [], errors = []; let reader, details;
browser.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  const setup = await browser.newPage(); await setup.goto(home);
  if (fixture) await installFixture(browser, worker, setup);
  await setup.evaluate(async () => {
    const settings = {uiLanguage: 'zh-CN', language: 'en', layout: 'single', fit: 'window', autoTranslateTabs: false, discoveryTextTranslation: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});
  });
  await setup.reload(); await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByRole('heading', {name: 'ComicK (comickz)', exact: true}).waitFor();
  await setup.screenshot({path: path.join(out, 'site-directory.png')});
  const search = await setup.evaluate(async () => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), sessionId = 'comickz-validation';
    try {
      const results = await p.searchSource('comickz', {siteId: 'comickz', query: 'one piece'}, {sessionId});
      const cover = await p.readSearchCover(results.items.find(hit => hit.cover));
      return {registered: p.listSearchSites().some(site => site.key === 'comickz:comickz'), hits: results.items.length,
        coverBytes: cover.size, comics: (await p.catalog.list('comics')).length};
    } finally {p.releaseSourceSearchSession(sessionId);}
  });
  assert(search.registered && search.hits > 0 && search.coverBytes > 1000 && search.comics === 0);
  checks.push('Source search and artwork work without creating a comic');
  const chapter = process.env.COMICKZ_READER_URL || 'https://comickz.co.uk/comic/00-one-piece-episode-a/6X6e3BMq-chapter-4.5-en';
  const site = await browser.newPage(); await site.goto(chapter, {waitUntil: 'domcontentloaded'});
  const button = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}); await button.waitFor();
  await site.screenshot({path: path.join(out, 'chapter-entry.png')});
  const opened = browser.waitForEvent('page'); await button.click(); reader = await opened;
  await reader.waitForURL('**/reader.html?catalog=*');
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
  details = await reader.evaluate(async chapter => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), comic = (await p.catalog.list('comics')).find(c => c.source.connectionId === 'website:comickz');
    const entries = await p.catalog.listEntries(comic.id, {limit: 10000}), entry = entries.find(e => e.sourceEntryId === p.sourceLocation(chapter).pageKey);
    return {comicId: comic.id, entryId: entry.id, title: comic.title, catalogUrl: comic.sourceUrl, chapters: entries.length, pages: entry.pageCount};
  }, chapter);
  assert(details.pages > 0 && details.chapters > 0);
  const waitPage = page => reader.waitForFunction(({id, index}) => {
    const image = document.querySelector(`[data-copy-id="${id}"] [data-page-index="${index}"] img.nc-page-image`);
    return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  }, {id: details.entryId, index: page - 1}, {timeout: 60000});
  for (let page = 1; page <= details.pages; page++) {
    await reader.getByLabel('跳转页码', {exact: true}).fill(String(page), {force: true});
    await reader.getByLabel('跳转页码', {exact: true}).press('Enter');
    await waitPage(page);
  }
  checks.push(`Chapter import reads ${details.chapters} releases and decodes all ${details.pages} original pages`);
  const targetPage = Math.min(5, details.pages);
  await reader.getByLabel('跳转页码', {exact: true}).evaluate(input => input.blur()); await reader.keyboard.press('Home');
  await reader.getByLabel('跳转页码', {exact: true}).fill(String(targetPage), {force: true});
  await reader.getByLabel('跳转页码', {exact: true}).press('Enter');
  const position = async () => reader.evaluate(async ({entryId, comicId}) => {
    const p = await import(chrome.runtime.getURL('verify-source.js'));
    return {position: await p.catalog.get('positions', entryId), lastEntryId: (await p.catalog.get('comics', comicId)).lastEntryId};
  }, details);
  await reader.waitForFunction(async ({id, index}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js')), entry = await catalog.get('entries', id);
    const pages = await catalog.listPages(entry.contentId), pos = await catalog.get('positions', id);
    return pos?.pageId === pages[index]?.pageId;
  }, {id: details.entryId, index: targetPage - 1});
  await waitPage(targetPage);
  await reader.screenshot({path: path.join(out, 'reader.png')});
  const route = reader.url(); await reader.close(); reader = await browser.newPage(); await reader.goto(route);
  await reader.getByRole('button', {name: '打开漫画 ' + details.title, exact: true}).click();
  await reader.getByLabel('跳转页码', {exact: true}).waitFor();
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), String(targetPage));
  await waitPage(targetPage);
  await reader.screenshot({path: path.join(out, 'reopened.png')}); checks.push(`Close/reopen restores page ${targetPage}`);
  await site.close(); const tabCount = browser.pages().length;
  const refresh = await reader.evaluate(async id => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), comic = await p.catalog.get('comics', id);
    const snapshot = await p.readWebsiteCatalog(comic.sourceUrl);
    await p.applyCatalogRefresh(id, comic.source.generation, snapshot); await p.applyCatalogRefresh(id, comic.source.generation, snapshot);
    return {entries: (await p.catalog.listEntries(id, {limit: 10000})).length, updates: (await p.catalog.get('comics', id)).catalogUpdates?.count ?? 0};
  }, details.comicId);
  assert.equal(refresh.entries, details.chapters); assert.equal(refresh.updates, 0); assert.equal(browser.pages().length, tabCount);
  checks.push('Repeated refresh needs no source tab and creates no duplicate updates');
  const before = await position();
  await reader.evaluate(() => {
    globalThis.comickzSavedFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).includes('comickz.co.uk/comic/')
      ? Promise.resolve(new Response('', {status: 503})) : globalThis.comickzSavedFetch(input, options);
  });
  const failure = await reader.evaluate(async ({comicId, catalogUrl}) => {
    const p = await import(chrome.runtime.getURL('verify-source.js')); let failed = false;
    try {await p.readWebsiteCatalog(catalogUrl);} catch {failed = true;}
    return {failed, entries: (await p.catalog.listEntries(comicId, {limit: 10000})).length};
  }, details);
  assert(failure.failed && failure.entries === details.chapters); assert.deepEqual(await position(), before);
  await reader.evaluate(() => {globalThis.fetch = globalThis.comickzSavedFetch; delete globalThis.comickzSavedFetch;});
  checks.push('Simulated HTTP failure leaves catalog and reading position unchanged');
  await setup.getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = setup.locator(`[data-comic-id="${details.comicId}"] .nc-thumbnail img`); await cover.waitFor(); await cover.evaluate(i => i.decode());
  await setup.screenshot({path: path.join(out, 'shelf.png')});
  await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByLabel('通过链接添加漫画').fill(details.catalogUrl); await setup.getByRole('button', {name: '添加到书架', exact: true}).click();
  await setup.getByLabel('跳转页码', {exact: true}).waitFor();
  assert.equal(await setup.getByLabel('跳转页码', {exact: true}).inputValue(), String(targetPage));
  assert.equal(await setup.evaluate(async () => (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).length), 1);
  checks.push('Dedicated shelf cover and duplicate catalog import preserve one comic and its position');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', liveSource: !fixture, liveProvider: false, checks, details, search, errors}, null, 2));
  console.log(JSON.stringify({out, checks, details}, null, 2));
} catch (error) {
  if (reader && !reader.isClosed()) await reader.screenshot({path: path.join(out, 'failure.png')});
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', liveSource: !fixture, liveProvider: false, checks, details, errors, error: error.message}, null, 2));
  console.log(JSON.stringify({out, checks, errors})); throw error;
} finally {await browser.close();}
