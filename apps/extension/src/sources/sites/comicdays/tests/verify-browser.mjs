// Real public source/CDN in an isolated built MV3 extension. No translation provider calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), base = path.join(root, 'artifacts/comicdays/browser');
await mkdir(base, {recursive: true});
const out = await mkdtemp(path.join(base, 'run-')), extension = path.join(out, 'extension');
await cp(path.join(root, 'apps/extension/.output/chrome-mv3'), extension, {recursive: true});
const source = path.join(root, 'apps/extension/src').replaceAll('\\', '/'), probe = path.join(out, 'probe.js');
await writeFile(probe, `export {catalog} from '${source}/comics/repositories/index.ts';
export {readWebsiteCatalog} from '${source}/comics/application/website-catalog.ts';
export {applyCatalogRefresh} from '${source}/comics/application/catalog-service.ts';
export {listSearchSites, searchSource, readSearchCover, releaseSourceSearchSession, sourceLocation, sourceImage} from '${source}/sources/index.ts';
export {network} from '${source}/sources/sites/comicdays/network.ts';`);
const {build} = createRequire(path.join(root, 'apps/extension/package.json'))('vite');
await build({configFile: false, root: path.join(root, 'apps/extension'), logLevel: 'error', build: {
  outDir: extension, emptyOutDir: false, lib: {entry: probe, formats: ['es'], fileName: () => 'verify-source.mjs'},
}});
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const context = await chromium.launchPersistentContext(path.join(out, 'profile'), {headless: true,
  executablePath: process.env.TEST_CHROMIUM || process.env.CHROMIUM_PATH, locale: 'zh-CN',
  viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce',
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]});
context.setDefaultTimeout(30000);
const checks = [], errors = [], sourceFailures = [];
const safeError = value => String(value).replace(/https:\/\/cdn-img\.comic-days\.com\/\S+/g, '[Comic DAYS CDN resource]');
const resourceName = value => {const url = new URL(value); return url.origin + url.pathname;};
const isSourceRequest = value => ['comic-days.com', 'cdn-img.comic-days.com'].includes(new URL(value).hostname);
context.on('page', page => page.on('pageerror', error => {
  if (page.url().startsWith('chrome-extension:')) errors.push(safeError(error.message));
}));
context.on('requestfailed', request => {
  if (isSourceRequest(request.url())) sourceFailures.push({resource: resourceName(request.url()), error: request.failure()?.errorText});
});
context.on('response', response => {
  if (isSourceRequest(response.url()) && response.status() >= 400)
    sourceFailures.push({resource: resourceName(response.url()), status: response.status()});
});
await context.route('https://**.nodelane.net/**', route => route.fulfill({status: 503, contentType: 'application/json', body: '{}'}));
let reader, details;
const state = () => reader.evaluate(async ({comicId, entryId}) => {
  const {catalog} = await import(chrome.runtime.getURL('verify-source.mjs'));
  const comic = await catalog.get('comics', comicId), entries = await catalog.listEntries(comicId, {limit: 10000});
  return {entries: entries.map(entry => ({id: entry.id, contentId: entry.contentId, sourceEntryId: entry.sourceEntryId})),
    position: (await catalog.get('positions', entryId)) ?? null, lastEntryId: comic.lastEntryId};
}, details);
const waitImage = page => reader.waitForFunction(({id, index}) => {
  const image = document.querySelector(`[data-copy-id="${id}"] [data-page-index="${index}"] img.nc-page-image`);
  return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
}, {id: details.entryId, index: page - 1}, {timeout: 60000});
async function jump(page) {
  await reader.getByLabel('跳转页码', {exact: true}).fill(String(page), {force: true});
  await waitImage(page);
  await reader.waitForFunction(async ({id, index}) => {
    const {catalog} = await import(chrome.runtime.getURL('verify-source.mjs')), entry = await catalog.get('entries', id);
    const comic = await catalog.get('comics', entry.comicId), pages = await catalog.listPages(entry.contentId);
    const position = await catalog.get('positions', id);
    return position?.pageId === pages[index]?.pageId && comic.lastEntryId === id;
  }, {id: details.entryId, index: page - 1}, {timeout: 30000});
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const home = new URL('reader.html', worker.url()).href, setup = await context.newPage();
  await setup.goto(home);
  await setup.evaluate(async () => {
    const settings = {uiLanguage: 'zh-CN', language: 'ja', layout: 'single', fit: 'window',
      autoTranslateTabs: false, discoveryTextTranslation: false};
    localStorage.setItem('nc-settings', JSON.stringify(settings));
    await chrome.storage.local.set({'nc-reader-settings': settings});
  });
  await setup.reload();
  await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByRole('heading', {name: 'Comic DAYS', exact: true}).waitFor();
  await setup.screenshot({path: path.join(out, 'site-directory.png')});
  const query = process.env.COMICDAYS_SEARCH_QUERY || 'ハコヅメ';
  const found = await setup.evaluate(async query => {
    const p = await import(chrome.runtime.getURL('verify-source.mjs')), sessionId = 'comicdays-browser-search';
    try {
      const results = await p.searchSource('comicdays', {siteId: 'comicdays', query}, {sessionId});
      const hit = results.items.find(hit => hit.cover);
      if (!hit) throw Error('Live search has no artwork');
      const cover = await p.readSearchCover(hit);
      return {registered: p.listSearchSites().some(site => site.key === 'comicdays:comicdays'), hits: results.items.length,
        owned: results.items.every(hit => hit.sourceId === 'comicdays' && hit.siteId === 'comicdays'),
        coverBytes: cover.size, comics: (await p.catalog.list('comics')).length};
    } finally {p.releaseSourceSearchSession(sessionId);}
  }, query);
  assert(found.registered && found.hits > 0 && found.owned && found.coverBytes > 1000 && found.comics === 0);
  await setup.getByRole('navigation', {name: '主导航', exact: true}).getByRole('button', {name: '搜索漫画', exact: true}).click();
  const search = setup.locator('.nc-search-page');
  for (const option of await search.locator('.nc-search-site-option').all())
    await option.locator('input').setChecked((await option.innerText()).includes('Comic DAYS'));
  const input = search.getByPlaceholder('输入漫画名称或别名');
  await input.fill(query); await input.press('Enter');
  await search.locator('.nc-search-result').first().waitFor({timeout: 60000});
  await setup.screenshot({path: path.join(out, 'search.png')});
  checks.push('Website list and live name search return Comic DAYS candidates and artwork without creating shelf records');
  const chapter = process.env.COMICDAYS_READER_URL || 'https://comic-days.com/episode/12207421984001216436';
  const site = await context.newPage();
  await site.goto(chapter, {waitUntil: 'domcontentloaded'});
  const button = site.getByRole('button', {name: 'NodeLane Comics · 导入/管理漫画', exact: true});
  await button.waitFor({timeout: 60000});
  await site.screenshot({path: path.join(out, 'chapter-entry.png')});
  const opened = context.waitForEvent('page');
  await button.click(); reader = await opened;
  await reader.waitForURL('**/reader.html?catalog=*');
  await reader.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
  details = await reader.evaluate(async chapter => {
    const {catalog, sourceLocation} = await import(chrome.runtime.getURL('verify-source.mjs'));
    const comic = (await catalog.list('comics')).find(comic => comic.source.connectionId === 'website:comicdays');
    if (!comic) throw Error('Comic DAYS import did not create a work');
    const entries = await catalog.listEntries(comic.id, {limit: 10000});
    const entry = entries.find(entry => entry.sourceEntryId === sourceLocation(chapter)?.pageKey);
    if (!entry) throw Error('Imported work does not own the source episode');
    return {comicId: comic.id, entryId: entry.id, title: comic.title, catalogUrl: comic.sourceUrl,
      chapters: entries.length, total: entry.pageCount};
  }, chapter);
  assert(details.chapters > 0 && details.total > 0);
  await waitImage(1);
  details.decoding = await reader.evaluate(async ({chapter, id}) => {
    const p = await import(chrome.runtime.getURL('verify-source.mjs'));
    const snapshot = await p.network.pages(chapter, {request: async url => {
      const response = await fetch(url);
      if (!response.ok) throw Error('Source page request failed'); return response.text();
    }});
    const page = snapshot.items[0];
    const source = await createImageBitmap(await p.sourceImage(page.resource.url), {colorSpaceConversion: 'none'});
    const displayed = document.querySelector(`[data-copy-id="${id}"] [data-page-index="0"] img.nc-page-image`);
    const expected = new OffscreenCanvas(source.width, source.height), actual = new OffscreenCanvas(source.width, source.height);
    const expectedContext = expected.getContext('2d'), actualContext = actual.getContext('2d');
    expectedContext.drawImage(source, 0, 0);
    if (page.resource.processing) {
      if (!page.resource.processing.startsWith('gigaviewer-baku:')) throw Error('Unexpected image processing');
      const w = Math.floor(source.width / 32) * 8, h = Math.floor(source.height / 32) * 8;
      expectedContext.imageSmoothingEnabled = false;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
        expectedContext.drawImage(source, x * w, y * h, w, h, y * w, x * h, w, h);
    }
    actualContext.drawImage(displayed, 0, 0);
    const a = expectedContext.getImageData(0, 0, source.width, source.height).data;
    const b = actualContext.getImageData(0, 0, source.width, source.height).data;
    const exact = a.every((value, index) => value === b[index]);
    const result = {exact, width: source.width, height: source.height,
      processing: page.resource.processing?.split(':')[0] ?? null};
    source.close(); expected.width = actual.width = expected.height = actual.height = 1;
    return result;
  }, {chapter, id: details.entryId});
  assert(details.decoding.exact, 'Displayed page pixels differ from the independent source-image reconstruction');
  const pages = [...new Set([1, Math.min(3, details.total), details.total])];
  for (const page of pages) await jump(page);
  const restorePage = Math.min(3, details.total);
  await jump(restorePage);
  await reader.screenshot({path: path.join(out, `reader-${restorePage}.png`)});
  checks.push(`Source floating entry imports its ${details.chapters}-episode work; real first-page reconstruction is exact and pages ${pages.join(', ')} decode`);
  await reader.getByRole('button', {name: '打开目录', exact: true}).click();
  const directoryTab = reader.getByRole('tab', {name: /^目录/});
  if (await directoryTab.isVisible()) await directoryTab.click();
  await reader.getByRole('searchbox', {name: '搜索目录', exact: true}).waitFor();
  await reader.screenshot({path: path.join(out, 'directory.png')});
  await reader.getByRole('button', {name: '关闭面板', exact: true}).click();
  await reader.close(); reader = await context.newPage(); await reader.goto(home);
  await reader.locator(`[data-comic-id="${details.comicId}"] .nc-book-cover`).click();
  await waitImage(restorePage);
  assert.equal(await reader.getByLabel('跳转页码', {exact: true}).inputValue(), String(restorePage));
  assert.equal((await state()).lastEntryId, details.entryId);
  await reader.screenshot({path: path.join(out, 'restored.png')});
  checks.push(`Closing and reopening the reader restores page ${restorePage}`);
  await setup.getByRole('button', {name: '我的漫画', exact: true}).click();
  const cover = setup.locator(`[data-comic-id="${details.comicId}"] .nc-thumbnail img`);
  await cover.waitFor(); await cover.evaluate(image => image.decode());
  assert(await cover.evaluate(image => image.naturalWidth > 0));
  await setup.screenshot({path: path.join(out, 'cover.png')});
  await site.close();
  const beforeRefresh = await state(), tabs = context.pages().length;
  const refreshed = await reader.evaluate(async id => {
    const p = await import(chrome.runtime.getURL('verify-source.mjs')), comic = await p.catalog.get('comics', id);
    const snapshot = await p.readWebsiteCatalog(comic.sourceUrl);
    await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);
    await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot);
    return {total: (await p.catalog.listEntries(comic.id, {limit: 10000})).length,
      updates: (await p.catalog.get('comics', id)).catalogUpdates?.count ?? 0};
  }, details.comicId);
  assert.equal(refreshed.total, details.chapters); assert.equal(refreshed.updates, 0);
  assert.equal(context.pages().length, tabs); assert.deepEqual(await state(), beforeRefresh);
  checks.push('Shelf artwork decodes; duplicate complete refresh with the source tab closed retains entries and position without opening source tabs');
  await reader.evaluate(async catalogUrl => {
    const {sourceLocation} = await import(chrome.runtime.getURL('verify-source.mjs'));
    const series = sourceLocation(catalogUrl)?.catalog?.key?.split(':').at(-1);
    if (!series) throw Error('Catalog failure probe has no work identity');
    globalThis.comicdaysFailureFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? input, location.href);
      return url.hostname === 'comic-days.com' && url.pathname === '/api/viewer/readable_product_pagination_information' &&
        url.searchParams.get('aggregate_id') === series ? Promise.resolve(new Response('Unavailable', {status: 503}))
        : globalThis.comicdaysFailureFetch(input, options);
    };
  }, details.catalogUrl);
  const beforeFailure = await state();
  const failed = await reader.evaluate(async id => {
    const p = await import(chrome.runtime.getURL('verify-source.mjs')), comic = await p.catalog.get('comics', id);
    try {const snapshot = await p.readWebsiteCatalog(comic.sourceUrl);
      await p.applyCatalogRefresh(comic.id, comic.source.generation, snapshot); return false;
    } catch {return true;}
  }, details.comicId);
  assert(failed, 'Injected catalog HTTP failure should reject refresh');
  assert.deepEqual(await state(), beforeFailure);
  await reader.evaluate(() => {globalThis.fetch = globalThis.comicdaysFailureFetch; delete globalThis.comicdaysFailureFetch;});
  checks.push('Simulated catalog HTTP failure preserves the complete catalog and saved reading position');
  await setup.getByRole('button', {name: '漫画网站', exact: true}).click();
  await setup.getByLabel('通过链接添加漫画').fill(chapter);
  await setup.getByRole('button', {name: '添加到书架', exact: true}).click();
  await setup.getByLabel('跳转页码', {exact: true}).waitFor({timeout: 90000});
  assert.equal(await setup.getByLabel('跳转页码', {exact: true}).inputValue(), String(restorePage));
  assert.equal(await setup.evaluate(async () =>
    (await (await import(chrome.runtime.getURL('verify-source.mjs'))).catalog.list('comics')).length), 1);
  assert.deepEqual(await state(), beforeFailure);
  checks.push(`Bare source episode reimport resolves work ownership, keeps one work and restores page ${restorePage}`);
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'passed', checks, details, errors, sourceFailures,
    liveSource: true, liveProvider: false, simulatedCatalogFailure: true}, null, 2));
  console.log(JSON.stringify({out, checks, details}, null, 2));
} catch (error) {
  await writeFile(path.join(out, 'result.json'), JSON.stringify({status: 'failed', checks, details, errors, sourceFailures,
    error: safeError(error.message), liveSource: true, liveProvider: false}, null, 2));
  if (reader && !reader.isClosed()) await reader.screenshot({path: path.join(out, 'failure.png')});
  console.log(JSON.stringify({out, errors, error: safeError(error.message)}, null, 2));
  throw Error(safeError(error.message));
} finally {await context.close();}
