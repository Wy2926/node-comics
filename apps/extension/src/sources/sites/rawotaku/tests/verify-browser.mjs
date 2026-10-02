// Real public source/CDN in an isolated built MV3 extension. No translation provider calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), base = path.join(root, 'artifacts/rawotaku/browser');
await mkdir(base, {recursive: true}); const out = await mkdtemp(path.join(base, 'run-'));
const extension = path.join(out, 'extension'); await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(extension, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
  export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
  export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
  export {listSearchSites, searchSource, readSearchCover, releaseSourceSearchSession, sourceLocation} from '${source}/sources/index.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {outDir: extension, emptyOutDir: false,
  lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.js'}}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true, executablePath: process.env.TEST_CHROMIUM,
  locale: 'zh-CN', viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const checks = [], errors = [];
context.on('page', page => page.on('pageerror', error => {if (page.url().startsWith('chrome-extension:')) errors.push(error.message);}));
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, contentType: 'application/json', body: '{}'}));
let reader, details;
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), home = new URL('reader.html', worker.url()).href;
  const setup = await context.newPage(); await setup.goto(home);
  await setup.evaluate(async () => {
    const settings = {uiLanguage: 'zh-CN', language: 'en', layout: 'single', fit: 'window', autoTranslateTabs: false, discoveryTextTranslation: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings)); await chrome.storage.local.set({'nc-reader-settings': settings});
  });
  await setup.reload(); await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByRole('heading', {name: 'RawOtaku', exact: true}).waitFor();
  await setup.screenshot({path: path.join(out, 'site-directory.png')});
  const found = await setup.evaluate(async () => {
    const p = await import(chrome.runtime.getURL('verify-source.js'));
    const registered = p.listSearchSites().some(site => site.key === 'rawotaku:rawotaku'), sessionId = 'rawotaku-browser-search';
    try {
      const results = await p.searchSource('rawotaku', {siteId: 'rawotaku', query: 'blue'}, {sessionId});
      const cover = await p.readSearchCover(results.items.find(hit => hit.cover));
      return {registered, hits: results.items.length, owned: results.items.every(hit => hit.sourceId === 'rawotaku' && hit.siteId === 'rawotaku'),
        coverBytes: cover.size, comics: (await p.catalog.list('comics')).length};
    } finally {p.releaseSourceSearchSession(sessionId);}
  });
  assert(found.registered && found.hits > 0 && found.owned && found.coverBytes > 1000 && found.comics === 0);
  checks.push(`Live public source search returns ${found.hits} validated candidates and artwork without creating a library record`);
  const chapter = process.env.RAWOTAKU_READER_URL || 'https://rawotaku.com/read/ブルーロック/ja/chapter-401-raw/';
  const site = await context.newPage(); await site.goto(chapter, {waitUntil: 'domcontentloaded'});
  const button = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true}); await button.waitFor();
  await site.screenshot({path: path.join(out, 'chapter-entry.png')});
  const opened = context.waitForEvent('page'); await button.click(); reader = await opened;
  await reader.waitForURL('**/reader.html?catalog=*');
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
  await reader.waitForFunction(() => document.querySelector('img.nc-page-image')?.naturalWidth > 0, {}, {timeout: 60000});
  details = await reader.evaluate(async chapter => {
    const {catalog, sourceLocation} = await import(chrome.runtime.getURL('verify-source.js'));
    const comic = (await catalog.list('comics')).find(c => c.source.connectionId === 'website:rawotaku');
    const entries = await catalog.listEntries(comic.id, {limit: 10000});
    const entry = entries.find(e => e.sourceEntryId === sourceLocation(chapter)?.pageKey);
    return {comicId: comic.id, entryId: entry.id, title: comic.title, catalogUrl: comic.sourceUrl, chapters: entries.length, total: entry.pageCount};
  }, chapter);
  assert(details.chapters > 0 && details.total > 0);
  const restorePage = Math.min(10, details.total), restoreIndex = restorePage - 1;
  const readingState = async () => reader.evaluate(async ({comicId, entryId}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js')), comic = await catalog.get('comics', comicId);
    return {position: (await catalog.get('positions', entryId)) ?? null, lastEntryId: comic.lastEntryId};
  }, details);
  for (let number = 1; number <= details.total; number++) {
    await reader.getByLabel('跳转页码', {exact: true}).fill(String(number), {force: true});
    await reader.waitForFunction(({id, index}) => {
      const image = document.querySelector(`[data-copy-id="${id}"] [data-page-index="${index}"] img.nc-page-image`);
      return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    },
      {id: details.entryId, index: number - 1}, {timeout: 60000});
  }
  checks.push(`Live embedded chapter import binds the complete ${details.chapters}-entry catalog and decodes all ${details.total} original pages`);
  await reader.getByLabel('跳转页码', {exact: true}).evaluate(input => input.blur()); await reader.keyboard.press('Home');
  await reader.getByLabel('跳转页码', {exact: true}).fill(String(restorePage), {force: true});
  await reader.evaluate(async ({id, index}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.js')), deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const entry = await catalog.get('entries', id), comic = await catalog.get('comics', entry.comicId);
      const pages = await catalog.listPages(entry.contentId), position = await catalog.get('positions', id);
      if (position && pages[index] && position.contentId === entry.contentId && position.pageId === pages[index].pageId && comic.lastEntryId === id) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Target chapter reading position was not saved');
  }, {id: details.entryId, index: restoreIndex});
  const restoreImage = `[data-copy-id="${details.entryId}"] [data-page-index="${restoreIndex}"] img.nc-page-image`;
  await reader.waitForFunction(selector => {
    const image = document.querySelector(selector); return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  }, restoreImage);
  details.restoreImage = await reader.locator(restoreImage).evaluate(i => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    const context = canvas.getContext('2d'), width = Math.min(8, i.naturalWidth), height = Math.min(8, i.naturalHeight);
    const offsets = [0, Math.floor((i.naturalHeight - height) / 2), i.naturalHeight - height];
    for (const y of offsets) {
      context.clearRect(0, 0, 8, 8); context.drawImage(i, Math.floor((i.naturalWidth - width) / 2), y, width, height, 0, 0, 8, 8);
      const pixels = context.getImageData(0, 0, 8, 8).data;
      if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) throw new Error(`Original image pixel sample is empty at y=${y}`);
    }
    return {width: i.naturalWidth, height: i.naturalHeight, sampleOffsets: offsets};
  });
  await reader.screenshot({path: path.join(out, `reader-${restorePage}.png`)});
  const route = reader.url(); await reader.close(); reader = await context.newPage(); await reader.goto(route);
  await reader.getByRole('button', {name: '打开漫画 ' + details.title, exact: true}).click();
  await reader.waitForFunction(selector => {
    const image = document.querySelector(selector); return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  }, restoreImage);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), String(restorePage));
  assert.equal((await readingState()).lastEntryId, details.entryId);
  await reader.screenshot({path: path.join(out, `reopened-${restorePage}.png`)}); checks.push(`Reader close/reopen restores exact page ${restorePage}`);
  await setup.getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = setup.locator(`[data-comic-id="${details.comicId}"] .nc-thumbnail img`); await cover.waitFor(); await cover.evaluate(i => i.decode());
  assert(await cover.evaluate(i => i.naturalWidth > 0)); await setup.screenshot({path: path.join(out, 'cover.png')});
  checks.push('Shelf decodes the dedicated work artwork');
  await site.close(); const count = context.pages().length;
  const refreshed = await reader.evaluate(async id => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), comic = await p.catalog.get('comics', id);
    const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);
    await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);
    return {total: (await p.catalog.listEntries(comic.id, {limit: 10000})).length, updates: (await p.catalog.get('comics', id)).catalogUpdates?.count ?? 0};
  }, details.comicId);
  assert.equal(refreshed.total, details.chapters); assert.equal(refreshed.updates, 0); assert.equal(context.pages().length, count);
  checks.push('Full catalog refresh with source tab closed creates no source tabs or duplicate updates');
  await reader.evaluate(() => {
    globalThis.rawotakuFailureFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(typeof input === 'string' ? input : input.url ?? input).includes('rawotaku.com/read/')
      ? Promise.resolve(new Response('Unavailable', {status: 503})) : globalThis.rawotakuFailureFetch(input, options);
  });
  details.beforeFailure = await readingState();
  assert(details.beforeFailure.position?.pageId && details.beforeFailure.lastEntryId === details.entryId);
  const preserved = await reader.evaluate(async ({comicId}) => {
    const p = await import(chrome.runtime.getURL('verify-source.js')), comic = await p.catalog.get('comics', comicId);
    let failed = false;
    try {const snapshot = await p.readWebsiteCatalog(comic.sourceUrl); await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);} catch {failed = true;}
    return {failed, entries: (await p.catalog.listEntries(comicId, {limit: 10000})).length};
  }, details);
  details.afterFailure = await readingState();
  assert(preserved.failed && preserved.entries === details.chapters, JSON.stringify(preserved));
  assert.deepEqual(details.afterFailure, details.beforeFailure);
  await reader.evaluate(() => {globalThis.fetch = globalThis.rawotakuFailureFetch; delete globalThis.rawotakuFailureFetch;});
  checks.push('Simulated catalog HTTP failure preserves the complete catalog and saved reading position');
  await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByLabel('通过链接添加漫画').fill(details.catalogUrl);
  await setup.getByRole('button', {name: '添加到书架', exact: true}).click();
  await setup.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 60000});
  assert.equal(await setup.getByLabel('跳转页码', {exact: true}).inputValue(), String(restorePage));
  assert.equal(await setup.evaluate(async () => (await (await import(chrome.runtime.getURL('verify-source.js'))).catalog.list('comics')).length), 1);
  checks.push(`Catalog link reimport keeps one comic and existing page ${restorePage}`); assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', checks, details, errors, liveSource: true, liveProvider: false}, null, 2));
  console.log(JSON.stringify({out, checks, details}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', checks, details, errors, error: error.message}, null, 2));
  if (reader && !reader.isClosed()) await reader.screenshot({path: path.join(out, 'failure.png')});
  console.log(JSON.stringify({out, errors})); throw error;
} finally {await context.close();}
