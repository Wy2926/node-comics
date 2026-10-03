// Isolated built MV3 extension and live source/CDN. No account or translation calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/mangadna/browser');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
  export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
  export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
  export {listSearchSites, searchSource, readSearchCover, releaseSourceSearchSession, sourceLocation} from '${source}/sources/index.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'},
}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  ...(process.env.MANGADNA_TEST_PROXY ? {proxy: {server: process.env.MANGADNA_TEST_PROXY}} : {}),
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
browser.setDefaultTimeout(30000);
const checks = [], errors = [], samples = [];
browser.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
await browser.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, contentType: 'application/json', body: '{}'}));
let reader;
try {
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  const setup = await browser.newPage(); await setup.goto(home);
  await setup.evaluate(async () => {
    const settings = {uiLanguage: 'zh-CN', language: 'en', layout: 'single', fit: 'window', autoTranslateTabs: false, discoveryTextTranslation: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings));
    await chrome.storage.local.set({'nc-reader-settings': settings});
  });
  await setup.reload(); await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByRole('heading', {name: 'MangaDNA', exact: true}).waitFor();
  await setup.screenshot({path: path.join(out, 'site-directory.png')});
  const search = await setup.evaluate(async () => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), sessionId = 'mangadna-browser-search';
    try {
      const results = await p.searchSource('mangadna', {siteId: 'mangadna', query: 'Nano Machine'}, {sessionId});
      const cover = await p.readSearchCover(results.items.find(hit => hit.cover));
      return {registered: p.listSearchSites().some(s => s.key === 'mangadna:mangadna'), hits: results.items.length,
        bytes: cover.size, comics: (await p.catalog.list('comics')).length};
    } finally {p.releaseSourceSearchSession(sessionId);}
  });
  assert(search.registered && search.hits > 0 && search.bytes > 1000 && search.comics === 0);
  checks.push('Public search and dedicated search artwork work without importing a comic');
  const detailUrl = 'https://mangadna.com/manga/nano-machine';
  const detail = await browser.newPage(); await detail.goto(detailUrl, {waitUntil: 'domcontentloaded'});
  const detailButton = detail.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true});
  await detailButton.waitFor(); assert.equal(await detailButton.count(), 1);
  await detail.screenshot({path: path.join(out, 'detail-entry.png')});
  const detailOpened = browser.waitForEvent('page'); await detailButton.click(); reader = await detailOpened;
  await reader.waitForURL('**/reader.html?catalog=*');
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
  const detailImport = await reader.evaluate(async url => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const matches = (await catalog.list('comics')).filter(comic => comic.sourceUrl === url);
    if (matches.length !== 1) throw Error('Detail-page import did not create exactly one matching comic');
    const entries = await catalog.listEntries(matches[0].id, {limit: 10000});
    return {comicId: matches[0].id, entryId: entries[0].id, title: matches[0].title, entries: entries.length};
  }, detailUrl);
  assert.equal(detailImport.title, 'Nano Machine'); assert(detailImport.entries > 0);
  await reader.waitForFunction(() => [...document.querySelectorAll('img.nc-page-image')].some(img => img.complete && img.naturalWidth > 0));
  await reader.screenshot({path: path.join(out, 'detail-import-reader.png')});
  await reader.getByLabel('跳转页码', {exact: true}).fill('3', {force: true});
  await reader.waitForFunction(async entryId => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
    const entry = await catalog.get('entries', entryId), pages = await catalog.listPages(entry.contentId), position = await catalog.get('positions', entryId);
    return position?.contentId === entry.contentId && position?.pageId === pages[2]?.pageId;
  }, detailImport.entryId);
  await reader.close();
  const detailReopened = browser.waitForEvent('page'); await detailButton.click(); reader = await detailReopened;
  await reader.waitForURL('**/reader.html?catalog=*');
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), '3');
  assert.equal(await reader.evaluate(async url => (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).filter(comic => comic.sourceUrl === url).length, detailUrl), 1);
  assert.equal(await detailButton.count(), 1);
  await reader.close(); await detail.close();
  checks.push('Work detail page has one visible embedded import button, imports the matching full catalog and readable originals, and repeated clicks preserve page 3 without duplicating the comic');
  console.log(JSON.stringify({detailImport}));
  const chapters = process.env.MANGADNA_READER_URL ? [process.env.MANGADNA_READER_URL] : [
    'https://mangadna.com/manga/nano-machine/chapter-1',
    'https://mangadna.com/manga/solo-leveling/chapter-200-5',
    'https://mangadna.com/manga/solo-leveling/chapter-0',
  ];
  for (const chapter of chapters) {
    const site = await browser.newPage(); await site.goto(chapter, {waitUntil: 'domcontentloaded'});
    const button = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true});
    await button.waitFor(); await site.screenshot({path: path.join(out, `entry-${samples.length}.png`)});
    const opened = browser.waitForEvent('page'); await button.click(); reader = await opened;
    await reader.waitForURL('**/reader.html?catalog=*');
    await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
    const details = await reader.evaluate(async chapter => {
      const {catalog, sourceLocation} = await import(chrome.runtime.getURL('verify-source.js'));
      const location = sourceLocation(chapter), comic = (await catalog.list('comics')).find(c => c.sourceUrl === location.catalog.url);
      const entries = await catalog.listEntries(comic.id, {limit: 10000}), entry = entries.find(e => e.sourceEntryId === location.pageKey);
      return {comicId: comic.id, entryId: entry.id, title: comic.title, catalogUrl: comic.sourceUrl,
        chapters: entries.length, total: entry.pageCount, complete: entry.discoveryComplete, knownTotal: entry.knownTotal};
    }, chapter);
    assert(details.chapters > 0 && details.total > 0);
    samples.push(details);
    for (let index = 0; index < details.total; index++) {
      await reader.getByLabel('跳转页码', {exact: true}).fill(String(index + 1), {force: true});
      await reader.waitForFunction(({id, index}) => {
        const image = document.querySelector(`[data-copy-id="${id}"] [data-page-index="${index}"] img.nc-page-image`);
        return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
      }, {id: details.entryId, index}, {timeout: 60000});
    }
    const restorePage = Math.min(10, details.total), selector = `[data-copy-id="${details.entryId}"] [data-page-index="${restorePage - 1}"] img.nc-page-image`;
    await reader.getByLabel('跳转页码', {exact: true}).evaluate(input => input.blur());
    await reader.keyboard.press('Home');
    await reader.getByLabel('跳转页码', {exact: true}).fill(String(restorePage), {force: true});
    await reader.waitForFunction(selector => document.querySelector(selector)?.naturalWidth > 0, selector);
    const position = () => reader.evaluate(async entryId => (await import(chrome.runtime.getURL('verify-source.js'))).catalog.get('positions', entryId), details.entryId);
    await reader.waitForFunction(async ({entryId, index}) => {
      const {catalog} = await import(chrome.runtime.getURL('verify-source.js'));
      const entry = await catalog.get('entries', entryId), pages = await catalog.listPages(entry.contentId), saved = await catalog.get('positions', entryId);
      return saved?.contentId === entry.contentId && saved?.pageId === pages[index]?.pageId;
    }, {entryId: details.entryId, index: restorePage - 1});
    await reader.screenshot({path: path.join(out, `reader-${samples.length}.png`)});
    const route = reader.url(); await reader.close(); reader = await browser.newPage(); await reader.goto(route);
    await reader.getByRole('button', {name: '打开漫画 ' + details.title, exact: true}).click();
    await reader.waitForFunction(selector => document.querySelector(selector)?.naturalWidth > 0, selector);
    assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), String(restorePage));
    await reader.screenshot({path: path.join(out, `restored-${samples.length}.png`)});
    await site.close();
    const before = await position(), pageCount = browser.pages().length;
    await reader.evaluate(async details => {
      const p = await import(chrome.runtime.getURL('verify-source.js')), comic = await p.catalog.get('comics', details.comicId);
      const snapshot = await p.readWebsiteCatalog(comic.sourceUrl);
      await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);
      await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);
    }, details);
    assert.equal(browser.pages().length, pageCount);
    assert.deepEqual(await position(), before);
    await reader.evaluate(async details => {
      const p = await import(chrome.runtime.getURL('verify-source.js')), original = globalThis.fetch;
      globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).startsWith('https://mangadna.com/')
        ? Promise.resolve(new Response('Unavailable', {status: 503})) : original(input, options);
      try {
        await p.readWebsiteCatalog(details.catalogUrl);
        throw Error('Expected simulated HTTP failure');
      } catch (error) {if (error.message === 'Expected simulated HTTP failure') throw error;}
      finally {globalThis.fetch = original;}
      if ((await p.catalog.listEntries(details.comicId, {limit: 10000})).length !== details.chapters) throw Error('Directory lost on failure');
    }, details);
    assert.deepEqual(await position(), before);
    await setup.getByLabel('通过链接添加漫画').fill(details.catalogUrl);
    await setup.getByRole('button', {name: '添加到书架', exact: true}).click();
    await setup.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 60000});
    assert.equal(await setup.getByLabel('跳转页码', {exact: true}).inputValue(), String(restorePage));
    const duplicates = await setup.evaluate(async url => (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).filter(c => c.sourceUrl === url).length, details.catalogUrl);
    assert.equal(duplicates, 1);
    checks.push(`${details.title}: live import, ${details.total} originals decode, page ${restorePage} restores, repeat import/refresh and simulated failure preserve progress`);
    await reader.close(); await setup.goto(home);
    await setup.getByRole('button', {name: '我的漫画', exact: true}).click();
    const cover = setup.locator(`[data-comic-id="${details.comicId}"] .nc-thumbnail img`);
    await cover.waitFor(); await cover.evaluate(i => i.decode());
    assert(await cover.evaluate(i => i.naturalWidth > 0));
    await setup.screenshot({path: path.join(out, `cover-${samples.length}.png`)});
    console.log(JSON.stringify({sample: samples.length, title: details.title, pages: details.total, restored: restorePage, complete: details.complete}));
    await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  }
  assert(samples.some(s => s.total === 1) || process.env.MANGADNA_READER_URL);
  if (!process.env.MANGADNA_READER_URL) assert(samples.some(s => s.complete === false && s.knownTotal > s.total));
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', checks, samples, detailImport, search, errors, liveSource: true, liveProvider: false}, null, 2));
  console.log(JSON.stringify({out, checks, samples}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', checks, samples, errors, error: error.message}, null, 2));
  if (reader && !reader.isClosed()) await reader.screenshot({path: path.join(out, 'failure.png')});
  console.log(JSON.stringify({out, errors})); throw error;
} finally {await browser.close();}
